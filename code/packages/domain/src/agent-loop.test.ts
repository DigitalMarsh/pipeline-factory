import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryPipelineStore,
  SqlitePipelineStore,
  type AgentLoop,
  type AgentLoopStep,
} from "./index.js";

describe("AgentLoop persistence contract", () => {
  it("persists loops and steps in SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-agent-loop-"));
    const store = new SqlitePipelineStore(join(directory, "factory.sqlite"));
    try {
      store.saveAgentLoop({ id: "sqlite-loop", ownerType: "run", ownerId: "run-1", role: "executor", mode: "factory-controlled", state: "RUNNING", stepCount: 1, maxSteps: 4, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });
      const step = store.appendAgentLoopStep({ loopId: "sqlite-loop", stepType: "MODEL_STARTED", status: "RUNNING", callId: null, providerThreadId: null, providerTurnId: null, payload: { phase: "test" } });

      expect(store.getAgentLoop("sqlite-loop")).toMatchObject({ state: "RUNNING", role: "executor" });
      expect(step.sequence).toBe(1);
      expect(store.listAgentLoopSteps("sqlite-loop")[0]?.payload).toEqual({ phase: "test" });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a loop and appends contiguous steps", () => {
    const store = new InMemoryPipelineStore();
    const loop = store.saveAgentLoop({
      id: "loop-1",
      ownerType: "explorer-turn",
      ownerId: "turn-1",
      role: "explorer",
      mode: "provider-controlled",
      state: "CREATED",
      stepCount: 0,
      maxSteps: 4,
      startedAt: null,
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });

    expect(loop).toMatchObject({ id: "loop-1", state: "CREATED", stepCount: 0 });
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_STARTED", status: "RUNNING", payload: { step: 1 } });
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_COMPLETED", status: "COMPLETED", payload: { step: 1 } });

    expect(store.listAgentLoopSteps(loop.id).map((step) => step.sequence)).toEqual([1, 2]);
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toEqual(["MODEL_STARTED", "MODEL_COMPLETED"]);
  });

  it("does not replay a step marked for reconciliation", () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = {
      id: "loop-2",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "factory-controlled",
      state: "NEEDS_RECONCILIATION",
      stepCount: 1,
      maxSteps: 4,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    };
    store.saveAgentLoop(loop);
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "TOOL_COMPLETED", status: "NEEDS_RECONCILIATION", callId: "call-1", payload: { replay: false } });

    expect(store.recoverAgentLoops()).toEqual([]);
    expect(store.listAgentLoopSteps(loop.id)[0]).toMatchObject({ status: "NEEDS_RECONCILIATION", callId: "call-1" } satisfies Partial<AgentLoopStep>);
  });
});
