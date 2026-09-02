/**
 * 测试职责：验证 recovery-coordinator 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, type AgentLoop, type ExplorerInputRequest, type ExplorerTurn, type Run } from "./index.js";
import { RecoveryCoordinator } from "./recovery-coordinator.js";

function loop(store: InMemoryPipelineStore, id: string, state: AgentLoop["state"], providerThreadId: string | null = null, providerTurnId: string | null = null, ownerId = `run-${id}`): AgentLoop {
  const value: AgentLoop = { id, ownerType: "run", ownerId, role: "executor", mode: "provider-controlled", state, stepCount: 2, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId, providerTurnId, checkpointJson: null };
  store.saveAgentLoop(value);
  return value;
}

describe("RecoveryCoordinator", () => {
  it("terminalizes every non-terminal Explorer Loop and recovers its input request", () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const thread = { ...store.getThread("explorer-1")!, state: "WAITING_FOR_INPUT" as const, messageCount: 2 };
    const turn: ExplorerTurn = { id: "turn-1", threadId: thread.id, role: "assistant", content: "已开始分析", status: "WAITING_FOR_INPUT", createdAt: store.now(), sequence: 2 };
    const request: ExplorerInputRequest = { id: "input-1", threadId: thread.id, localTurnId: turn.id, providerRequestId: "request-1", providerThreadId: "provider-thread", providerTurnId: "provider-turn", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null, status: "OPEN", createdAt: store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null };
    store.updateThread(thread);
    store.saveTurn({ id: "user-1", threadId: thread.id, role: "user", content: "请探索", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    store.saveTurn(turn);
    store.saveInputRequest(request);
    store.saveAgentLoop({ id: "explorer-loop", ownerType: "explorer-turn", ownerId: turn.id, role: "explorer", mode: "provider-controlled", state: "WAITING_FOR_INPUT", stepCount: 1, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId: "provider-thread", providerTurnId: "provider-turn", checkpointJson: null });
    for (const [id, state] of [["explorer-running", "RUNNING"], ["explorer-paused", "PAUSED"], ["explorer-recovering", "RECOVERING"]] as const) {
      store.saveAgentLoop({ id, ownerType: "explorer-turn", ownerId: `missing-${id}`, role: "explorer", mode: "provider-controlled", state, stepCount: 1, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });
    }

    new RecoveryCoordinator(store).recover();

    expect(store.getAgentLoop("explorer-loop")).toMatchObject({ state: "FAILED", completedAt: expect.any(String) });
    expect(store.getAgentLoop("explorer-running")).toMatchObject({ state: "FAILED", completedAt: expect.any(String) });
    expect(store.getAgentLoop("explorer-paused")).toMatchObject({ state: "FAILED", completedAt: expect.any(String) });
    expect(store.getAgentLoop("explorer-recovering")).toMatchObject({ state: "FAILED", completedAt: expect.any(String) });
    expect(store.getInputRequest(request.id)).toMatchObject({ status: "RECOVERY_REQUIRED" });
    expect(store.listTurns(thread.id).find((item) => item.id === turn.id)).toMatchObject({ status: "FAILED", error: "STRUCTURED_INPUT_RECOVERY_REQUIRED" });
    expect(store.getThread(thread.id)).toMatchObject({ state: "ACTIVE" });
  });

  it("marks orphaned running loops as recovering without replaying work", () => {
    const store = new InMemoryPipelineStore();
    loop(store, "orphaned", "RUNNING");
    const coordinator = new RecoveryCoordinator(store);

    const recovered = coordinator.recover();

    expect(recovered[0]).toMatchObject({ id: "orphaned", state: "RECOVERING" });
    expect(store.listAgentLoopSteps("orphaned").at(-1)?.stepType).toBe("LOOP_SUSPENDED");
    expect(store.listEvents({ aggregateId: "orphaned" }).at(-1)).toMatchObject({ type: "agent.loop.recovery_required" });
  });

  it("moves a loop with an unknown side effect to reconciliation and leaves input loops recoverable", () => {
    const store = new InMemoryPipelineStore();
    loop(store, "side-effect", "RUNNING", "provider-thread", "provider-turn");
    loop(store, "input", "WAITING_FOR_INPUT", "provider-thread", "provider-turn");
    store.saveToolCall({ callId: "call-1", loopId: "side-effect", role: "executor", tool: "write_file", status: "UNKNOWN", inputHash: "hash", result: null, startedAt: store.now(), completedAt: null });

    new RecoveryCoordinator(store).recover();

    expect(store.getAgentLoop("side-effect")).toMatchObject({ state: "NEEDS_RECONCILIATION" });
    expect(store.getAgentLoop("input")).toMatchObject({ state: "WAITING_FOR_INPUT" });
  });

  it("marks an orphaned run as recovering and records attention without leaving it active", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Orphaned run" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const run: Run = { id: "run-orphaned", projectId: "project-1", planId: plan.id, planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-orphaned", workspacePath: "/tmp/demo-worktrees/run-orphaned", baseCommit: "abc", executionThreadId: "execution-orphaned", createdAt: store.now(), startedAt: store.now() };
    store.saveRun(run);
    store.updatePlan({ ...plan, status: "IN_PROGRESS", runId: run.id });
    loop(store, "orphaned", "RUNNING", null, null, run.id);

    new RecoveryCoordinator(store).recover();

    expect(store.getRun(run.id)).toMatchObject({ status: "RECOVERING" });
    expect(store.getPlan(plan.id)).toMatchObject({ attentionReason: "Execution recovery required: PROVIDER_TURN_NOT_ACTIVE" });
  });

  it("reconciles a terminal run into a stale in-progress plan projection", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Stale plan projection" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const run: Run = { id: "run-blocked", projectId: "project-1", planId: plan.id, planRevision: 1, status: "BLOCKED", branch: "factory/run-blocked", workspacePath: null, baseCommit: "abc", executionThreadId: "execution-blocked", createdAt: store.now(), startedAt: store.now() };
    store.saveRun(run);
    store.updatePlan({ ...plan, status: "IN_PROGRESS", runId: run.id });

    new RecoveryCoordinator(store).recover();

    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Run is blocked" });
  });

  it("does not downgrade a merged Plan when its Run remains merge-ready", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Keep merged plan" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const run: Run = { id: "run-merge-ready", projectId: "project-1", planId: plan.id, planRevision: 1, status: "MERGE_READY", branch: "factory/run-merge-ready", workspacePath: null, baseCommit: "abc", executionThreadId: "execution-merge-ready", createdAt: store.now(), startedAt: store.now() };
    store.saveRun(run);
    store.updatePlan({ ...plan, status: "MERGED", runId: run.id });

    new RecoveryCoordinator(store).recover();

    expect(store.getPlan(plan.id)?.status).toBe("MERGED");
  });
});
