import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as domain from "../index.js";
import {
  InMemoryPipelineStore,
  LifecycleHookRunner,
  PlanService,
  ProjectService,
  Scheduler,
  SqlitePipelineStore,
  resolvePlanContract,
} from "../index.js";
import { planContractFixture } from "../plan/plan-fixture.js";

const coordinatorModule = domain as unknown as {
  PlanDispatchCoordinator: new (options: {
    store: domain.PipelineStore;
    plans: PlanService;
    scheduler: Scheduler;
    globalConcurrency?: number;
    verify?: (run: domain.Run, revision: domain.PlanRevision) => Promise<domain.VerificationRun>;
  }) => {
    dispatch(planId: string): Promise<{ plan: domain.CandidatePlan; state: domain.PlanDispatchState }>;
    confirmAndDispatch(
      planId: string,
      revision: number,
      confirmedBy: string,
    ): Promise<{ plan: domain.CandidatePlan; run: domain.Run | null; state: domain.PlanDispatchState }>;
    reviseConfiguration(planId: string, actorId: string): domain.CandidatePlan;
    wake(): Promise<domain.PlanDispatchState[]>;
    state(planId: string): domain.PlanDispatchState | undefined;
    dispose(): void;
  };
};

function schedulerFor(store: domain.PipelineStore): Scheduler {
  // 容量不再由 Scheduler 判定（见 run/scheduler.ts 维护提示 3）：这里只造一个能建 worktree 的 Scheduler。
  return new Scheduler({
    store,
    workspace: {
      create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
      remove: async () => undefined,
    },
    hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  });
}

/** 造一个带指定 include 范围的已确认 Plan（范围要在 confirm 之前写进去，Confirm 会冻结它）。 */
function createScopedPlan(
  store: domain.PipelineStore,
  plans: PlanService,
  projectId: string,
  title: string,
  include: string[],
): domain.CandidatePlan {
  const plan = plans.createCandidatePlan({
    projectId,
    sourceExplorerThreadId: "thread-1",
    title,
    resolvedContract: planContractFixture({ store, projectId, title }),
  });
  store.updatePlan({
    ...plan,
    resolvedContract: { ...plan.resolvedContract, scope: { ...plan.resolvedContract.scope, includePaths: include } },
  });
  plans.confirm(plan.id, "user-1");
  return plans.get(plan.id);
}

function createPlan(store: domain.PipelineStore, plans: PlanService, title: string, dependsOnPlanIds: string[] = []): domain.CandidatePlan {
  const plan = plans.createCandidatePlan({
    projectId: "project-1",
    sourceExplorerThreadId: "thread-1",
    title,
    resolvedContract: planContractFixture({ store, projectId: "project-1", title }),
  });
  if (dependsOnPlanIds.length) store.updatePlan({ ...plan, resolvedContract: { ...plan.resolvedContract, dependsOnPlanIds } });
  plans.confirm(plan.id, "user-1");
  return plans.get(plan.id);
}

async function dispatch(coordinator: InstanceType<typeof coordinatorModule.PlanDispatchCoordinator>, plans: PlanService, planId: string) {
  plans.enqueue(planId);
  return coordinator.dispatch(planId);
}

/**
 * 等到调度状态落到目标值。
 * 验证是**后台**跑的（见「不等待验证跑完就返回」那条用例），所以断言终态不能假设 `wake()` 返回时它已经跑完——
 * 用轮询把"等一会儿"变成确定的等待，而不是靠微任务时序侥幸通过。
 */
async function waitForStatus(
  coordinator: InstanceType<typeof coordinatorModule.PlanDispatchCoordinator>,
  planId: string,
  status: string,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (coordinator.state(planId)?.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`dispatch state for ${planId} did not settle to ${status}（当前 ${coordinator.state(planId)?.status ?? "unknown"}）`);
}

describe("PlanDispatchCoordinator", () => {
  it("does not schedule an Enqueued plan until an explicit dispatch request", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Manual dispatch gate");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    plans.enqueue(plan.id);
    await coordinator.wake();
    expect(store.listRuns()).toHaveLength(0);
    expect(coordinator.state(plan.id)).toBeUndefined();

    const dispatched = await coordinator.dispatch(plan.id);
    expect(dispatched.plan.status).toBe("IN_PROGRESS");
    expect(dispatched.state).toMatchObject({ planId: plan.id, status: "RUNNING", waitReason: null });
  });

  /**
   * **已丢弃的方案不再有调度投影。**
   *
   * 投影的来源是 **Run**，而 Run 并不知道自己的方案已经被丢了：`discard` 把投影清掉之后，这里每遇
   * 一次唤醒都会按 Run 的状态把它写回来——实测清掉 **6ms** 之后就被写成 `BLOCKED`/`ATTENTION`，
   * 于是 Plan 中心里还挂着一条指向已丢弃方案的"待处理"。这条钉的是"写不回来"。
   */
  it("**丢弃之后不再按 Run 的状态重建调度投影**", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Discarded while its run is stopped");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });
    await dispatch(coordinator, plans, plan.id);

    // 让这个 Run 停下来，投影里于是有一条 BLOCKED（这正是丢弃之后会被写回来的那条）。
    const run = store.listRuns().find((item) => item.planId === plan.id)!;
    store.saveRun({ ...run, status: "BLOCKED" });
    await coordinator.wake();
    expect(coordinator.state(plan.id)?.status).toBe("BLOCKED");

    // 丢弃：`discard` 会清掉投影，而下面的这一次唤醒必须**不再把它写回来**。
    store.updatePlan({ ...store.getPlan(plan.id)!, status: "BLOCKED" });
    plans.discard(plan.id, "user-1");
    expect(coordinator.state(plan.id)).toBeUndefined();

    await coordinator.wake();

    expect(coordinator.state(plan.id)).toBeUndefined();
  });

  it("dispatches an explicitly started Plan automatically and keeps repeated wake idempotent", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Automatic dispatch");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    const result = await dispatch(coordinator, plans, plan.id);

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

    const waiting = await dispatch(coordinator, plans, dependent.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_DEPENDENCY" });
    expect(store.listRuns()).toHaveLength(0);

    store.updatePlan({ ...dependency, status: "MERGED" });
    const resumed = (await coordinator.wake()).find((state) => state.planId === dependent.id);
    expect(resumed).toMatchObject({ status: "RUNNING", waitReason: null });
  });

  it("does not treat V2 natural-language prerequisites as Plan dependencies during dispatch", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project-1",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-1-worktrees",
      settings: { commands: [] },
    });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "thread-1",
      title: "Prerequisite-bearing plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Prerequisite-bearing plan" }),
    });
    const generatedSpec = {
      schemaVersion: 2 as const,
      title: "Prerequisite-bearing plan",
      artifact: { mode: "REPOSITORY_FILE" as const, path: "src/example.ts" },
      objective: { goal: "Implement the feature", audience: ["Developers"], acceptanceCriteria: ["Feature works"], outOfScope: [] },
      design: {
        technicalConstraints: ["Use TypeScript"],
        dataSecurity: ["Do not expose secrets"],
        failureHandling: ["Surface errors clearly"],
      },
      scope: { includePaths: ["src/example.ts"], excludePaths: [] },
      tasks: [{ id: "task-1", title: "Implement the feature", dependencies: [], status: "READY" as const }],
      dependencies: ["Node.js 22 or compatible version", "pnpm"],
      conflicts: [],
      execution: {},
      verification: { mode: "NONE" as const },
      merge: { strategy: "manual" as const, requireHumanMerge: true as const },
    };
    const resolvedContract = resolvePlanContract(generatedSpec, projects.snapshot(project.id), {
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    });
    store.updatePlan({
      ...plan,
      generatedSpec,
      resolvedContract,
    });
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    try {
      const result = await coordinator.confirmAndDispatch(plan.id, plan.revision, "user-1");
      expect(result.state).toMatchObject({ status: "RUNNING", waitReason: null });
      expect(result.run).not.toBeNull();
    } finally {
      coordinator.dispose();
    }
  });

  // 容量闸门本轮**重新接通**（此前 PlanDispatchCoordinator 声明了 WAITING_*_CAPACITY 却从不判定，
  // 前端也一直在渲染这两个状态）。这两条用例原先断言"不设上限"，现在断言上限生效。
  // 冲突判定分两层：模型声明的语义键（一直生效）与 scope 重叠（`conflictScope: "overlap"` 才参与）。
  // 默认必须是 `declared`——否则升级后同目录下不相关的 Plan 会突然开始互相排队。
  it("keeps conflict detection on declared keys unless the Project opts into scope overlap", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    // 两个 Project 用同一组重叠范围，唯一区别是 conflictScope。
    const declared = projects.create({
      id: "project-declared",
      name: "Declared",
      repoRoot: "/repo/declared",
      defaultBranch: "main",
      worktreeRoot: "/tmp/declared-worktrees",
      settings: {
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });
    const overlap = projects.create({
      id: "project-overlap",
      name: "Overlap",
      repoRoot: "/repo/overlap",
      defaultBranch: "main",
      worktreeRoot: "/tmp/overlap-worktrees",
      settings: {
        concurrency: { conflictScope: "overlap" },
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });
    const plans = new PlanService(store, projects);
    const declaredFirst = createScopedPlan(store, plans, declared.id, "Declared first", ["code/apps/web/src"]);
    const declaredSecond = createScopedPlan(store, plans, declared.id, "Declared second", ["code/apps/web/src/checkout"]);
    const overlapFirst = createScopedPlan(store, plans, overlap.id, "Overlap first", ["code/apps/web/src"]);
    const overlapSecond = createScopedPlan(store, plans, overlap.id, "Overlap second", ["code/apps/web/src/checkout"]);
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    // 默认（declared）：父子范围重叠也不算冲突，两个都跑 —— 与引入该开关之前一致。
    await dispatch(coordinator, plans, declaredFirst.id);
    expect((await dispatch(coordinator, plans, declaredSecond.id)).state).toMatchObject({ status: "RUNNING", waitReason: null });

    // overlap：父范围覆盖子范围 → 第二个排队，并说明是哪一个范围重叠。
    await dispatch(coordinator, plans, overlapFirst.id);
    const waiting = await dispatch(coordinator, plans, overlapSecond.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_CONFLICT" });
    // 等待原因里带上是哪一片范围重叠，排障时不用去猜。
    expect(waiting.state.lastError).toContain("overlapping scope code/apps/web/src");
    expect(store.listRuns().filter((run) => run.projectId === overlap.id)).toHaveLength(1);
  });

  it("does not treat disjoint scopes as a conflict even when overlap detection is on", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-disjoint",
      name: "Disjoint",
      repoRoot: "/repo/disjoint",
      defaultBranch: "main",
      worktreeRoot: "/tmp/disjoint-worktrees",
      settings: {
        concurrency: { conflictScope: "overlap" },
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });
    const plans = new PlanService(store, projects);
    const docs = createScopedPlan(store, plans, project.id, "Docs plan", ["docs/guide.md"]);
    const web = createScopedPlan(store, plans, project.id, "Web plan", ["code/apps/web/**"]);
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    await dispatch(coordinator, plans, docs.id);
    expect((await dispatch(coordinator, plans, web.id)).state).toMatchObject({ status: "RUNNING", waitReason: null });
    expect(store.listRuns()).toHaveLength(2);
  });

  it("waits for a free global execution slot instead of exceeding the cap", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const first = createPlan(store, plans, "First");
    const second = createPlan(store, plans, "Second");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({
      store,
      plans,
      scheduler: schedulerFor(store),
      globalConcurrency: 1,
    });

    await dispatch(coordinator, plans, first.id);
    const waiting = await dispatch(coordinator, plans, second.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_GLOBAL_CAPACITY" });
    expect(store.listRuns()).toHaveLength(1);

    // 槽位释放后重新唤醒：Run 进入终态（不再是 EXECUTION_SLOT_RUN_STATUSES 的一员）即可放行。
    const activeRun = store.listRuns()[0]!;
    store.saveRun({ ...activeRun, status: "READY_FOR_VERIFY" });
    const started = await dispatch(coordinator, plans, second.id);
    expect(started.state).toMatchObject({ status: "RUNNING", waitReason: null });
    expect(store.listRuns()).toHaveLength(2);
  });

  it("waits for a free slot in the Project instead of exceeding maxParallelRuns", async () => {
    const store = new InMemoryPipelineStore();
    new ProjectService(store).create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project-1",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-1-worktrees",
      settings: {
        concurrency: { maxParallelRuns: 1 },
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });
    const plans = new PlanService(store);
    const first = createPlan(store, plans, "Project first");
    const second = createPlan(store, plans, "Project second");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    await dispatch(coordinator, plans, first.id);
    const waiting = await dispatch(coordinator, plans, second.id);
    expect(waiting.state).toMatchObject({ status: "WAITING", waitReason: "WAITING_PROJECT_CAPACITY" });
    expect(store.listRuns()).toHaveLength(1);
  });

  it("does not let a Run block its own retry on the same revision", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Retryable");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({
      store,
      plans,
      scheduler: schedulerFor(store),
      globalConcurrency: 1,
    });

    const started = await dispatch(coordinator, plans, plan.id);
    expect(started.state).toMatchObject({ status: "RUNNING" });
    // 同一 Plan 同一 Revision 的既有 Run 属于续跑：容量已满也不该把它自己卡在等待里。
    const again = await dispatch(coordinator, plans, plan.id);
    expect(again.state).toMatchObject({ status: "RUNNING", waitReason: null });
    expect(store.listRuns()).toHaveLength(1);
  });

  it("revises a configuration-blocked dispatch with the current Project snapshot", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project-1",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-1-worktrees",
      settings: { commands: [] },
    });
    const plans = new PlanService(store, projects);
    const plan = createPlan(store, plans, "Configuration recovery");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    const waiting = await dispatch(coordinator, plans, plan.id);
    expect(waiting).toMatchObject({
      plan: { status: "DISPATCHED", revision: 1, runId: null },
      state: { status: "WAITING", waitReason: "NEEDS_CONFIGURATION" },
    });
    const originalRevision = plans.getRevision(plan.id, 1);

    expect(() => coordinator.reviseConfiguration(plan.id, "reviewer")).toThrow(
      "RUN_PREREQUISITES_UNSATISFIED: missing registered commands: project.test, project.typecheck",
    );
    expect(plans.get(plan.id)).toMatchObject({ revision: 1, status: "DISPATCHED" });

    projects.update(project.id, {
      expectedConfigVersion: project.configVersion,
      settings: {
        ...project.settings,
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });
    const revised = coordinator.reviseConfiguration(plan.id, "reviewer");

    expect(revised).toMatchObject({
      id: plan.id,
      revision: 2,
      status: "READY",
      queuedAt: null,
      dispatchedAt: null,
      runId: null,
      attentionReason: null,
    });
    expect(originalRevision.projectConfigSnapshot?.settings.commands).toEqual([]);
    expect(plans.getRevision(plan.id, 2).projectConfigSnapshot?.settings.commands.map((command) => command.commandId)).toEqual([
      "project.test",
      "project.typecheck",
    ]);
    expect(store.getDispatchState(plan.id)).toBeUndefined();
  });

  it("persists PlanDispatchState across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-dispatch-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const firstStore = new SqlitePipelineStore(databasePath);
      const plans = new PlanService(firstStore);
      const plan = createPlan(firstStore, plans, "Persist dispatch");
      const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store: firstStore, plans, scheduler: schedulerFor(firstStore) });
      const result = await dispatch(coordinator, plans, plan.id);
      expect(result.state).toMatchObject({ status: "RUNNING", phase: "RUN_STARTED" });
      firstStore.close();

      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getDispatchState(plan.id)).toMatchObject({ planId: plan.id, status: "RUNNING", phase: "RUN_STARTED" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a failed confirmation phase and retries it without creating a second Run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Recoverable confirmation",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Recoverable confirmation" }),
    });
    store.updatePlan({ ...plan, resolvedContract: { ...plan.resolvedContract, dependsOnPlanIds: ["plan-does-not-exist"] } });
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });

    const failed = await coordinator.confirmAndDispatch(plan.id, plan.revision, "user-1");
    expect(failed).toMatchObject({
      plan: { status: "DRAFT" },
      run: null,
      state: { status: "BLOCKED", phase: "VALIDATION_FAILED", attempt: 1 },
    });

    store.updatePlan({ ...plans.get(plan.id), resolvedContract: { ...plans.get(plan.id).resolvedContract, dependsOnPlanIds: [] } });
    const retried = await coordinator.confirmAndDispatch(plan.id, plan.revision, "user-1");
    const repeated = await coordinator.confirmAndDispatch(plan.id, plan.revision, "user-1");
    expect(retried).toMatchObject({
      plan: { status: "IN_PROGRESS" },
      run: { id: expect.any(String) },
      state: { status: "RUNNING", phase: "RUN_STARTED", attempt: 2 },
    });
    expect(repeated.run?.id).toBe(retried.run?.id);
    expect(store.listRuns()).toHaveLength(1);
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

    const result = await dispatch(coordinator, plans, plan.id);
    const run = store.getRun(result.state.runId!);
    store.saveRun({ ...run!, status: "READY_FOR_VERIFY" });
    store.appendEvent({ type: "run.executor.event", aggregateId: run!.id, payload: { action: "executor_completed" } });
    await coordinator.wake();

    // 验证是**后台**跑的（见下一条用例），所以这里等状态落定，而不是假设 wake 返回时它已经跑完。
    await waitForStatus(coordinator, plan.id, "NEEDS_REVIEW");
    expect(coordinator.state(plan.id)).toMatchObject({ status: "NEEDS_REVIEW", runId: run!.id });
  });

  it("**不等待**验证跑完就返回：确认一个 Plan 不该被别的 Run 的验证命令挡住", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Detached verification");
    let releaseVerification: () => void = () => undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationStarted = false;
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({
      store,
      plans,
      scheduler: schedulerFor(store),
      verify: async (run) => {
        verificationStarted = true;
        await verificationGate;
        store.saveRun({ ...run, status: "MERGE_READY" });
        return {
          id: "verification-detached",
          runId: run.id,
          status: "PASSED",
          repairAttempts: 0,
          commandResults: [],
          completedAt: store.now(),
        };
      },
    });

    const result = await dispatch(coordinator, plans, plan.id);
    const run = store.getRun(result.state.runId!)!;
    store.saveRun({ ...run, status: "READY_FOR_VERIFY" });
    store.appendEvent({ type: "run.executor.event", aggregateId: run.id, payload: { action: "executor_completed" } });

    // 验证被 gate 卡住时 wake() 仍必须返回——`wake()` 要遍历所有 Run，而它同时在
    // `confirmAndDispatch` 的调用链上；在这里 await 会把"另一个 Run 的 build/test"塞进确认请求。
    await coordinator.wake();
    expect(verificationStarted).toBe(true);
    expect(coordinator.state(plan.id)).toMatchObject({ status: "VERIFYING" });

    releaseVerification();
    await waitForStatus(coordinator, plan.id, "NEEDS_REVIEW");
  });

  it("projects recovery-required Runs into Needs Attention instead of RUNNING", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Recovery attention");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });
    const dispatched = await dispatch(coordinator, plans, plan.id);

    store.saveRun({ ...store.getRun(dispatched.state.runId!)!, status: "RECOVERING" });
    await coordinator.wake();

    expect(coordinator.state(plan.id)).toMatchObject({ status: "BLOCKED", lastError: expect.stringContaining("recovery") });
  });

  it("does not rewrite dispatch state or events when a wake changes nothing", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = createPlan(store, plans, "Idempotent wake");
    const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });
    await dispatch(coordinator, plans, plan.id);
    const countStateEvents = () =>
      store.listEvents({ aggregateId: plan.id }).filter((event) => event.type === "plan.dispatch.state.changed").length;
    const before = countStateEvents();

    await coordinator.wake();
    await coordinator.wake();

    expect(coordinator.state(plan.id)).toMatchObject({ status: "RUNNING" });
    expect(countStateEvents()).toBe(before);
    coordinator.dispose();
  });

  it("coalesces streaming deltas into a single wake", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPipelineStore();
      const plans = new PlanService(store);
      const plan = createPlan(store, plans, "Streaming coalesce");
      const coordinator = new coordinatorModule.PlanDispatchCoordinator({ store, plans, scheduler: schedulerFor(store) });
      const dispatched = await dispatch(coordinator, plans, plan.id);
      const countStateEvents = () =>
        store.listEvents({ aggregateId: plan.id }).filter((event) => event.type === "plan.dispatch.state.changed").length;
      const before = countStateEvents();

      // 窗口内既有真实状态变化、又有大量 token 事件，只应合并成一次状态写入。
      store.saveRun({ ...store.getRun(dispatched.state.runId!)!, status: "BLOCKED" });
      for (let index = 0; index < 50; index += 1)
        store.appendEvent({ type: "agent.model.text.delta", aggregateId: "agent-loop-1", payload: { text: "token" } });
      expect(countStateEvents()).toBe(before);

      await vi.advanceTimersByTimeAsync(400);

      expect(countStateEvents()).toBe(before + 1);
      expect(coordinator.state(plan.id)).toMatchObject({ status: "BLOCKED" });
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Plan dependency validation", () => {
  it("rejects missing, self and cyclic Plan dependencies", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const missing = createPlan(store, plans, "Missing");
    store.updatePlan({
      ...missing,
      status: "DRAFT",
      confirmedAt: null,
      confirmedBy: null,
      resolvedContract: { ...missing.resolvedContract, dependsOnPlanIds: ["missing-plan"] },
    });
    expect(() => plans.confirm(missing.id, "user-1")).toThrow(/unknown plan/i);

    const self = createPlan(store, plans, "Self");
    store.updatePlan({
      ...self,
      status: "DRAFT",
      confirmedAt: null,
      confirmedBy: null,
      resolvedContract: { ...self.resolvedContract, dependsOnPlanIds: [self.id] },
    });
    expect(() => plans.confirm(self.id, "user-1")).toThrow(/itself|self/i);

    const first = createPlan(store, plans, "Cycle A");
    const second = createPlan(store, plans, "Cycle B");
    store.updatePlan({
      ...first,
      status: "DRAFT",
      confirmedAt: null,
      confirmedBy: null,
      resolvedContract: { ...first.resolvedContract, dependsOnPlanIds: [second.id] },
    });
    store.updatePlan({
      ...second,
      status: "DRAFT",
      confirmedAt: null,
      confirmedBy: null,
      resolvedContract: { ...second.resolvedContract, dependsOnPlanIds: [first.id] },
    });
    expect(() => plans.confirm(first.id, "user-1")).toThrow(/cycle/i);
  });
});
