/**
 * 测试职责：验证 m3-run 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, LifecycleHookRunner, LocalGitWorktreeAdapter, PlanService, ProjectService, Scheduler } from "./index.js";

describe("Scheduler and ExecutionThread", () => {
  it("fails before creating a worktree when frozen verification commands are not registered", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-preflight", name: "Preflight", repoRoot: "/repo/preflight", defaultBranch: "main", worktreeRoot: "/tmp/preflight", settings: { commands: [{ commandId: "project.test", argv: ["true"] }] } });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({ projectId: "project-preflight", sourceExplorerThreadId: "thread-preflight", title: "Preflight" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    plans.dispatch(plan.id);
    let created = false;
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => { created = true; return { path: "/tmp/preflight/run", branch: "factory/run", baseCommit: "abc" }; }, remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    await expect(scheduler.start(plan.id)).rejects.toThrow(/RUN_PREREQUISITES_UNSATISFIED/);
    expect(created).toBe(false);
  });
  it("creates a run, workspace and thread in order, then records the start hook", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Run a plan" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const order: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => { order.push("worktree.add"); return { path: "/tmp/run-1", branch: "factory/run-1", baseCommit: "abc" }; },
        remove: async () => { order.push("worktree.remove"); },
      },
      hooks: new LifecycleHookRunner(async (command) => { order.push(command.commandId); return { exitCode: 0, stdout: "ok", stderr: "" }; }),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start" } });
    expect(run).toMatchObject({ planId: plan.id, planRevision: 1, status: "IN_PROGRESS", executionThreadId: expect.any(String) });
    expect(order).toEqual(["worktree.add", "project.start"]);
    expect(scheduler.thread(run.executionThreadId).journal.map((entry) => entry.type)).toEqual(["RUN_CREATED", "HOOK_COMPLETED", "TASK_PROGRESS"]);
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({
      type: "TASK_PROGRESS",
      payload: { action: "legacy_plan_revision" },
    });
  });

  it("persists every bounded lifecycle hook attempt", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-hooks", sourceExplorerThreadId: "thread-hooks", title: "Hook audit" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    let calls = 0;
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/hook-audit", branch: "factory/hook-audit", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: ++calls === 2 ? 0 : 1, stdout: `attempt-${calls}`, stderr: "" })),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start", maxAttempts: 2 } });

    expect(run.status).toBe("IN_PROGRESS");
    expect(store.listHookExecutions(run.id).map((item) => ({ attempt: item.attempt, status: item.status, stdout: item.stdout }))).toEqual([
      { attempt: 1, status: "failed", stdout: "attempt-1" },
      { attempt: 2, status: "completed", stdout: "attempt-2" },
    ]);
  });

  it("blocks a run after start failure and never opens an Executor turn", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Blocked run" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run-2", branch: "factory/run-2", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 1, stdout: "", stderr: "environment failed" })),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start" } });
    expect(run.status).toBe("BLOCKED");
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({ type: "HOOK_FAILED" });
  });

  it("removes the workspace before running cleanup and keeps cleanup failure as attention", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Cleanup run" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const order: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run-3", branch: "factory/run-3", baseCommit: "abc" }), remove: async () => { order.push("worktree.remove"); } },
      hooks: new LifecycleHookRunner(async (command) => { order.push(command.commandId); return { exitCode: 1, stdout: "", stderr: "cleanup failed" }; }),
    });
    const run = await scheduler.start(plan.id);
    await scheduler.finish(run.id, "completed", { cleanup: { commandId: "project.cleanup" } });
    expect(order).toEqual(["worktree.remove", "project.cleanup"]);
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({ type: "HOOK_FAILED" });
    expect(store.getPlan(plan.id)?.attentionReason).toMatch(/cleanup/i);
  });

  it("validates the base commit before creating a real Git worktree", async () => {
    const commands: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({ projectRoot: "/repo", worktreeRoot: "/worktrees", runGit: async (args) => { commands.push(args); return { exitCode: 0, stdout: "abc", stderr: "" }; } });
    await adapter.create({ projectId: "project-1", runId: "run-1", branch: "factory/run-1", baseCommit: "abc" });
    await adapter.remove({ path: "/worktrees/run-1", branch: "factory/run-1", baseCommit: "abc" });
    expect(commands).toEqual([["rev-parse", "--verify", "abc"], ["worktree", "add", "-b", "factory/run-1", "/worktrees/run-1", "abc"], ["worktree", "remove", "--force", "/worktrees/run-1"]]);
  });

  it("uses the persisted run status after verification changes it", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Fresh run state" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run-4", branch: "factory/run-4", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);
    store.saveRun({ ...run, status: "MERGE_READY" });

    expect(() => scheduler.pause(run.id)).toThrow(/cannot be paused from MERGE_READY/i);
    expect(scheduler.thread(run.executionThreadId).state).toBe("ACTIVE");
  });

  it("synchronizes the Plan when a cancelled Run reaches finish twice", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Cancelled run race" });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run-race", branch: "factory/run-race", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);
    store.saveRun({ ...run, status: "CANCELLED" });
    await scheduler.finish(run.id, "cancelled", {}, "stale_run");

    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Run cancelled: stale_run" });
  });

  it.each(["READY_FOR_VERIFY", "MERGE_READY"] as const)("does not count %s as an execution slot", async (status) => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const firstPlan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "First plan" });
    planService.confirm(firstPlan.id, "user-1");
    planService.enqueue(firstPlan.id);
    planService.dispatch(firstPlan.id);
    const scheduler = new Scheduler({
      store,
      globalConcurrency: 1,
      workspace: { create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const firstRun = await scheduler.start(firstPlan.id);
    store.saveRun({ ...firstRun, status });
    const secondPlan = planService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Second plan" });
    planService.confirm(secondPlan.id, "user-1");
    planService.enqueue(secondPlan.id);
    planService.dispatch(secondPlan.id);

    await expect(scheduler.start(secondPlan.id)).resolves.toMatchObject({ status: "IN_PROGRESS" });
  });
});
