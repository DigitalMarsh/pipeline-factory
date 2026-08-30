import { describe, expect, it } from "vitest";
import {
  InMemoryPipelineStore,
  LifecycleHookRunner,
  PlanService,
  type CommandExecutor,
} from "./index.js";

describe("PlanService", () => {
  it("keeps confirm and enqueue as separate transitions", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    const plan = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Add audit timeline",
    });

    expect(() => service.enqueue(plan.id)).toThrow(/confirmed/i);
    expect(service.confirm(plan.id, "user-1").status).toBe("READY");
    expect(service.enqueue(plan.id).status).toBe("QUEUED");
    expect(service.enqueue(plan.id).status).toBe("QUEUED");
    expect(store.listEvents().filter((event) => event.type === "plan.enqueued")).toHaveLength(1);
  });

  it("queries only dispatched plans across the thread lineage", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    service.registerThread({ id: "root", projectId: "project-1", parentThreadId: null });
    service.registerThread({ id: "successor", projectId: "project-1", parentThreadId: "root" });
    const confirmed = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "root", title: "Confirmed" });
    const queued = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "successor", title: "Queued" });
    const draft = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "root", title: "Draft" });
    service.confirm(confirmed.id, "user-1");
    service.enqueue(confirmed.id);
    service.confirm(queued.id, "user-1");
    service.enqueue(queued.id);

    expect(service.listThreadPlans("successor").map((item) => item.title)).toEqual(["Queued", "Confirmed"]);
    expect(service.listThreadPlans("successor").some((item) => item.planId === draft.id)).toBe(false);
  });

  it("discards only a draft plan and blocks every execution transition", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    const plan = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Discard this plan",
    });

    const discarded = service.discard(plan.id, "user-1");

    expect(discarded).toMatchObject({ id: plan.id, status: "DISCARDED", revision: 1, queuedAt: null, runId: null });
    expect(store.listEvents().at(-1)).toMatchObject({ type: "plan.discarded", aggregateId: plan.id, payload: { actorId: "user-1" } });
    expect(() => service.discard(plan.id, "user-1")).toThrow(/cannot be discarded/i);
    expect(() => service.confirm(plan.id, "user-1")).toThrow(/cannot be confirmed/i);
    expect(() => service.enqueue(plan.id)).toThrow(/must be confirmed/i);
    expect(service.listThreadPlans("thread-1")).toEqual([]);
  });
});

describe("LifecycleHookRunner", () => {
  it("blocks a run when start fails and only warns when cleanup fails", async () => {
    const calls: string[] = [];
    const executor: CommandExecutor = async (command) => {
      calls.push(command.commandId);
      return { exitCode: command.commandId.includes("start") ? 1 : 1, stdout: "", stderr: "failed" };
    };
    const runner = new LifecycleHookRunner(executor);
    const context = {
      projectId: "project-1",
      runId: "run-1",
      workspacePath: "/tmp/worktree",
      branch: "factory/run-1",
      baseCommit: "abc123",
      exitReason: "completed",
    } as const;

    await expect(runner.runStart({ commandId: "project.start" }, context)).resolves.toMatchObject({ blocked: true });
    await expect(runner.runCleanup({ commandId: "project.cleanup" }, context)).resolves.toMatchObject({ needsAttention: true });
    expect(calls).toEqual(["project.start", "project.cleanup"]);
  });
});
