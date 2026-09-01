import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, ProjectService, Scheduler, SqlitePipelineStore } from "./index.js";

const coordinatorModule = domain as unknown as {
  PlanDispatchCoordinator: new (options: {
    store: domain.PipelineStore;
    plans: PlanService;
    scheduler: Scheduler;
    globalConcurrency?: number;
    verify?: (run: domain.Run, revision: domain.PlanRevisionV2) => Promise<domain.VerificationRun>;
  }) => {
    enqueue(planId: string): Promise<{ plan: domain.CandidatePlan; state: domain.PlanDispatchState }>;
    wake(): Promise<domain.PlanDispatchState[]>;
    state(planId: string): domain.PlanDispatchState | undefined;
  };
};

function schedulerFor(store: domain.PipelineStore, globalConcurrency?: number): Scheduler {
  return new Scheduler({
    store,
    ...(globalConcurrency === undefined ? {} : { globalConcurrency }),
    workspace: { create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }), remove: async () => undefined },
    hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  });
}

function createPlan(store: domain.PipelineStore, plans: PlanService, title: string, dependsOnPlanIds: string[] = []): domain.CandidatePlan {
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title });
  if (dependsOnPlanIds.length) store.updatePlan({ ...plan, contract: { ...plan.contract, dependsOnPlanIds } });
  plans.confirm(plan.id, "user-1");
  return plans.get(plan.id);
}

describe("PlanDispatchCoordinator", () => {
  it("dispatches an enqueued Plan automatically and keeps repeated wake idempotent", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Automatic dispatch");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    const result = await coordinator.enqueue(plan.id);

    expect(result.plan.status).toBe("IN_PROGRESS");
    expect(result.state).toMatchObject({ planId: plan.id, status: "RUNNING", waitReason: null });
    await coordinator.wake();
    expect(store.listRuns()).toHaveLength(1);
  });

  it("waits on same-project dependencies and resumes once the dependency is complete", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const dependency = createPlan(store, plans, "Dependency");
    const dependent = createPlan(store, plans, "Dependent", [dependency.id]);
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    const waiting = await coordinator.enqueue(dependent.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_DEPENDENCY" });
    expect(store.listRuns()).toHaveLength(0);

    store.updatePlan({ ...dependency, status: "MERGED" });
    const resumed = (await coordinator.wake()).find((state) => state.planId === dependent.id);
    expect(resumed).toMatchObject({ status: "RUNNING", waitReason: null });
  });

  it("uses a stable queuedAt then planId order and records global capacity waiting", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const first = createPlan(store, plans, "First");
    const second = createPlan(store, plans, "Second");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store, 1), globalConcurrency: 1 });

    await coordinator.enqueue(first.id);
    const waiting = await coordinator.enqueue(second.id);
    expect(waiting.state.waitReason).toBe("WAITING_GLOBAL_CAPACITY");

    const firstRun = store.listRuns()[0];
    expect(firstRun).toBeDefined();
    store.saveRun({ ...firstRun!, status: "MERGE_READY" });
    const resumed = (await coordinator.wake()).find((state) => state.planId === second.id);
    expect(resumed).toMatchObject({ status: "RUNNING", waitReason: null });
  });

  it("waits on the frozen Project concurrency limit before using another slot", async () => {
    const store = new InMemoryPipelineStore();
    new ProjectService(store).create({ id: "project-1", name: "Project", repoRoot: "/repo/project-1", defaultBranch: "main", worktreeRoot: "/tmp/project-1-worktrees", settings: { concurrency: { maxParallelRuns: 1 }, commands: [{ commandId: "project.test", argv: ["true"] }, { commandId: "project.typecheck", argv: ["true"] }] } });
    const plans = new PlanService(store);
    const first = createPlan(store, plans, "Project first");
    const second = createPlan(store, plans, "Project second");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    await coordinator.enqueue(first.id);
    const waiting = await coordinator.enqueue(second.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_PROJECT_CAPACITY" });

    const firstRun = store.listRuns()[0]!;
    store.saveRun({ ...firstRun, status: "MERGE_READY" });
    const resumed = (await coordinator.wake()).find((state) => state.planId === second.id);
    expect(resumed).toMatchObject({ status: "RUNNING", waitReason: null });
  });

  it("persists PlanDispatchState across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-dispatch-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const firstStore = new SqlitePipelineStore(databasePath);
      const plans = new PlanService(firstStore);
      const plan = createPlan(firstStore, plans, "Persist dispatch");
      const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store: firstStore, plans, scheduler: schedulerFor(firstStore, 0), globalConcurrency: 0 });
      const result = await coordinator.enqueue(plan.id);
      expect(result.state.waitReason).toBe("WAITING_GLOBAL_CAPACITY");
      firstStore.close();

      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getDispatchState(plan.id)).toMatchObject({ planId: plan.id, status: "WAITING", waitReason: "WAITING_GLOBAL_CAPACITY" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("automatically verifies a Run that reaches READY_FOR_VERIFY", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Automatic verification");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({
      store,
      plans,
      scheduler: schedulerFor(store),
      verify: async (run) => {
        store.saveRun({ ...run, status: "MERGE_READY" });
        return { id: "verification-1", runId: run.id, status: "PASSED", repairAttempts: 0, commandResults: [], completedAt: store.now() };
      },
    });

    const result = await coordinator.enqueue(plan.id);
    const run = store.getRun(result.state.runId!);
    store.saveRun({ ...run!, status: "READY_FOR_VERIFY" });
    store.appendEvent({ type: "run.executor.event", aggregateId: run!.id, payload: { action: "executor_completed" } });
    await coordinator.wake();

    expect(coordinator.state(plan.id)).toMatchObject({ status: "NEEDS_REVIEW", runId: run!.id });
  });
});

describe("Plan dependency validation", () => {
  it("rejects missing, self and cyclic Plan dependencies", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const missing = createPlan(store, plans, "Missing");
    store.updatePlan({ ...missing, status: "DRAFT", confirmedAt: null, confirmedBy: null, contract: { ...missing.contract, dependsOnPlanIds: ["missing-plan"] } });
    expect(() => plans.confirm(missing.id, "user-1")).toThrow(/unknown plan/i);

    const self = createPlan(store, plans, "Self");
    store.updatePlan({ ...self, status: "DRAFT", confirmedAt: null, confirmedBy: null, contract: { ...self.contract, dependsOnPlanIds: [self.id] } });
    expect(() => plans.confirm(self.id, "user-1")).toThrow(/itself|self/i);

    const first = createPlan(store, plans, "Cycle A");
    const second = createPlan(store, plans, "Cycle B");
    store.updatePlan({ ...first, status: "DRAFT", confirmedAt: null, confirmedBy: null, contract: { ...first.contract, dependsOnPlanIds: [second.id] } });
    store.updatePlan({ ...second, status: "DRAFT", confirmedAt: null, confirmedBy: null, contract: { ...second.contract, dependsOnPlanIds: [first.id] } });
    expect(() => plans.confirm(first.id, "user-1")).toThrow(/cycle/i);
  });
});
