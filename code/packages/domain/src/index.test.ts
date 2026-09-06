/**
 * 测试职责：验证 index 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryPipelineStore,
  LifecycleHookRunner,
  PlanService,
  type CommandExecutor,
} from "./index.js";

describe("PlanService", () => {
  it("puts a confirmed plan in the manual Enqueued stage without dispatching it", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    const plan = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Wait for an explicit start",
    });

    service.confirm(plan.id, "user-1");
    const enqueued = service.enqueue(plan.id);

    expect(enqueued).toMatchObject({ status: "ENQUEUED", queuedAt: expect.any(String), dispatchedAt: null, runId: null });
    expect(store.getDispatchState(plan.id)).toBeUndefined();
    expect(store.listEvents().filter((event) => event.type === "plan.enqueued")).toHaveLength(1);
  });

  it("dispatches only an Enqueued plan and records the durable dispatched stage", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    const plan = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Start only after enqueue",
    });

    service.confirm(plan.id, "user-1");
    expect(() => service.dispatch(plan.id)).toThrow(/must be enqueued/i);
    service.enqueue(plan.id);

    const dispatched = service.dispatch(plan.id);
    expect(dispatched).toMatchObject({ status: "DISPATCHED", dispatchedAt: expect.any(String), runId: null });
    expect(service.dispatch(plan.id)).toMatchObject({ status: "DISPATCHED", dispatchedAt: dispatched.dispatchedAt });
    expect(store.listEvents().filter((event) => event.type === "plan.dispatched")).toHaveLength(1);
  });

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
    expect(service.enqueue(plan.id).status).toBe("ENQUEUED");
    expect(service.enqueue(plan.id).status).toBe("ENQUEUED");
    expect(store.listEvents().filter((event) => event.type === "plan.enqueued")).toHaveLength(1);
  });

  it("keeps conversation artifacts reviewable but rejects every execution entry", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    const created = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Conversation plan" });
    store.updatePlan({ ...created, contract: { ...created.contract, artifactMode: "CONVERSATION" } });
    expect(service.confirm(created.id, "user-1").status).toBe("READY");
    expect(() => service.enqueue(created.id)).toThrow("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    expect(() => service.dispatch(created.id)).toThrow("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
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

  it("lists an unqueued confirmed plan without sorting on a null queuedAt", () => {
    const store = new InMemoryPipelineStore();
    const service = new PlanService(store);
    service.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const confirmed = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Confirmed but not queued" });
    const queued = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Already queued" });

    service.confirm(confirmed.id, "user-1");
    service.confirm(queued.id, "user-1");
    service.enqueue(queued.id);

    expect(service.listThreadPlans("thread-1")).toMatchObject([
      { planId: queued.id, status: "ENQUEUED" },
      { planId: confirmed.id, status: "READY", queuedAt: null },
    ]);
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

  it("retries a failed lifecycle hook within its configured attempt bound", async () => {
    let calls = 0;
    const runner = new LifecycleHookRunner(async () => ({ exitCode: ++calls === 2 ? 0 : 1, stdout: `attempt-${calls}`, stderr: "" }));
    const context = { projectId: "project-1", runId: "run-1", workspacePath: "/tmp/worktree", branch: "factory/run-1", baseCommit: "abc123", exitReason: "running" } as const;

    const result = await runner.runStart({ commandId: "project.start", maxAttempts: 2 }, context);

    expect(result).toMatchObject({ status: "completed", blocked: false, result: { stdout: "attempt-2" } });
    expect(result.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([[1, "failed"], [2, "completed"]]);
  });
});
