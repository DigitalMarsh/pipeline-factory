/**
 * 模块职责：协调 Agent Loop 和 Run 在中断、重启及不确定副作用后的恢复状态。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { AgentLoop, PipelineStore, PlanStatus, RunStatus } from "./index.js";

/** 启动恢复协调器，把未完成 Loop、未知工具副作用和 Run/Plan 投影恢复到可诊断状态。 */
export class RecoveryCoordinator {
  constructor(private readonly store: PipelineStore) {}

  /** 恢复所有活动 Loop；未知副作用进入 NEEDS_RECONCILIATION，禁止自动重放。 */
  recover(): AgentLoop[] {
    const recover = () => this.recoverInternal();
    return this.store.runInTransaction ? this.store.runInTransaction(recover) : recover();
  }

  private recoverInternal(): AgentLoop[] {
    const affected = new Map<string, AgentLoop>();
    const uncertainLoopIds = new Set(
      this.store.listToolCalls()
        .filter((call) => call.status === "UNKNOWN" || call.status === "NEEDS_RECONCILIATION")
        .map((call) => call.loopId),
    );

    for (const loop of this.store.listAgentLoops().filter((item) => item.ownerType === "explorer-turn" && !isTerminal(item.state))) {
      const updated = this.terminalizeExplorerLoop(loop);
      affected.set(updated.id, updated);
    }

    for (const loop of this.store.recoverAgentLoops().filter((item) => item.ownerType !== "explorer-turn")) {
      if (uncertainLoopIds.has(loop.id)) {
        const updated = this.transition(loop, "NEEDS_RECONCILIATION", "UNKNOWN_TOOL_RESULT");
        affected.set(updated.id, updated);
      } else if (loop.state === "RUNNING" && (!loop.providerThreadId || !loop.providerTurnId)) {
        const updated = this.transition(loop, "RECOVERING", "PROVIDER_TURN_NOT_ACTIVE");
        affected.set(updated.id, updated);
      } else {
        affected.set(loop.id, loop);
      }
    }
    this.reconcilePlanProjections();
    return [...affected.values()];
  }

  private terminalizeExplorerLoop(loop: AgentLoop): AgentLoop {
    const turn = this.store.listThreads()
      .flatMap((thread) => this.store.listTurns(thread.id))
      .find((candidate) => candidate.id === loop.ownerId);
    const thread = turn ? this.store.getThread(turn.threadId) : undefined;
    const requests = turn ? this.store.listInputRequests(turn.threadId).filter((request) => request.localTurnId === turn.id) : [];
    const inputRecovery = requests.some((request) => request.status === "OPEN" || request.status === "SUBMITTING" || request.status === "RECOVERY_REQUIRED");
    const reason = inputRecovery ? "STRUCTURED_INPUT_RECOVERY_REQUIRED" : "EXPLORER_TURN_RECOVERY_REQUIRED";
    for (const request of requests) {
      if (request.status === "OPEN" || request.status === "SUBMITTING") this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    }
    if (turn && (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED")) {
      this.store.updateTurn({ ...turn, status: "FAILED", error: reason, content: turn.content || "模型回合中断，需要重新开始探索" });
    }
    if (thread && thread.state === "WAITING_FOR_INPUT") this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    const completedAt = this.store.now();
    const updated = { ...loop, state: "FAILED" as const, completedAt, checkpointJson: JSON.stringify({ error: reason, recoveredAt: completedAt }) };
    this.store.updateAgentLoop(updated);
    this.store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_FAILED", status: "FAILED", payload: { error: reason, recovered: true } });
    this.store.appendEvent({ type: "agent.loop.failed", aggregateId: loop.id, payload: { error: reason, recovered: true } });
    if (turn) this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: turn.threadId, payload: { assistantTurnId: turn.id, error: reason, recoveryRequired: true } });
    return updated;
  }

  private transition(loop: AgentLoop, state: AgentLoop["state"], reason: string): AgentLoop {
    const updated = { ...loop, state, checkpointJson: JSON.stringify({ reason, stepCount: loop.stepCount }) };
    this.store.updateAgentLoop(updated);
    this.store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_SUSPENDED", status: state === "NEEDS_RECONCILIATION" ? "NEEDS_RECONCILIATION" : "RUNNING", payload: { reason } });
    this.store.appendEvent({ type: "agent.loop.recovery_required", aggregateId: loop.id, payload: { state, reason } });
    this.markRunRecovery(loop, reason);
    return updated;
  }

  private markRunRecovery(loop: AgentLoop, reason: string): void {
    if (loop.ownerType !== "run") return;
    const run = this.store.getRun(loop.ownerId);
    if (!run || (run.status !== "STARTING" && run.status !== "IN_PROGRESS")) return;
    this.store.saveRun({ ...run, status: "RECOVERING" });
    const plan = this.store.getPlan(run.planId);
    if (plan && (plan.status === "IN_PROGRESS" || plan.status === "VERIFYING")) {
      this.store.updatePlan({ ...plan, attentionReason: `Execution recovery required: ${reason}`, lastEventAt: this.store.now() });
    }
    this.store.appendEvent({ type: "run.recovery_required", aggregateId: run.id, payload: { runId: run.id, loopId: loop.id, reason } });
  }

  private reconcilePlanProjections(): void {
    for (const run of this.store.listRuns()) {
      const plan = this.store.getPlan(run.planId);
      if (!plan || plan.runId !== run.id) continue;
      const targetStatus = planStatusForRun(run.status);
      if (!targetStatus || plan.status === targetStatus || !RECONCILIABLE_PLAN_STATUSES.has(plan.status)) continue;
      const attentionReason = targetStatus === "BLOCKED"
        ? plan.attentionReason ?? (run.status === "CANCELLED" ? "Run cancelled: startup reconciliation" : "Run is blocked")
        : null;
      this.store.updatePlan({ ...plan, status: targetStatus, attentionReason, lastEventAt: this.store.now() });
    }
  }
}

function isTerminal(state: AgentLoop["state"]): boolean {
  return state === "BLOCKED" || state === "COMPLETED" || state === "FAILED" || state === "CANCELLED" || state === "NEEDS_RECONCILIATION";
}

const RECONCILIABLE_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set(["QUEUED", "IN_PROGRESS", "VERIFYING", "MERGE_READY"]);

function planStatusForRun(status: RunStatus): PlanStatus | null {
  if (status === "STARTING" || status === "IN_PROGRESS" || status === "RECOVERING") return "IN_PROGRESS";
  if (status === "VERIFYING") return "VERIFYING";
  if (status === "MERGE_READY") return "MERGE_READY";
  if (status === "BLOCKED" || status === "CANCELLED" || status === "STALE") return "BLOCKED";
  return null;
}
