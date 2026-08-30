import type { AgentLoop, PipelineStore, PlanStatus, RunStatus } from "./index.js";

export class RecoveryCoordinator {
  constructor(private readonly store: PipelineStore) {}

  recover(): AgentLoop[] {
    const affected = new Map<string, AgentLoop>();
    const uncertainLoopIds = new Set(
      this.store.listToolCalls()
        .filter((call) => call.status === "UNKNOWN" || call.status === "NEEDS_RECONCILIATION")
        .map((call) => call.loopId),
    );

    for (const loop of this.store.recoverAgentLoops()) {
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

const RECONCILIABLE_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set(["QUEUED", "IN_PROGRESS", "VERIFYING", "MERGE_READY"]);

function planStatusForRun(status: RunStatus): PlanStatus | null {
  if (status === "STARTING" || status === "IN_PROGRESS" || status === "RECOVERING") return "IN_PROGRESS";
  if (status === "VERIFYING") return "VERIFYING";
  if (status === "MERGE_READY") return "MERGE_READY";
  if (status === "BLOCKED" || status === "CANCELLED" || status === "STALE") return "BLOCKED";
  return null;
}
