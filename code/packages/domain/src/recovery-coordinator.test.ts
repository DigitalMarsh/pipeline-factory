import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, type AgentLoop } from "./index.js";
import { RecoveryCoordinator } from "./recovery-coordinator.js";

function loop(store: InMemoryPipelineStore, id: string, state: AgentLoop["state"], providerThreadId: string | null = null, providerTurnId: string | null = null): AgentLoop {
  const value: AgentLoop = { id, ownerType: "run", ownerId: `run-${id}`, role: "executor", mode: "provider-controlled", state, stepCount: 2, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId, providerTurnId, checkpointJson: null };
  store.saveAgentLoop(value);
  return value;
}

describe("RecoveryCoordinator", () => {
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
});
