import type { AgentLoop, PipelineStore } from "./index.js";

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
    return [...affected.values()];
  }

  private transition(loop: AgentLoop, state: AgentLoop["state"], reason: string): AgentLoop {
    const updated = { ...loop, state, checkpointJson: JSON.stringify({ reason, stepCount: loop.stepCount }) };
    this.store.updateAgentLoop(updated);
    this.store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_SUSPENDED", status: state === "NEEDS_RECONCILIATION" ? "NEEDS_RECONCILIATION" : "RUNNING", payload: { reason } });
    this.store.appendEvent({ type: "agent.loop.recovery_required", aggregateId: loop.id, payload: { state, reason } });
    return updated;
  }
}
