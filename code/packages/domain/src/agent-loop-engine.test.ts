/**
 * 测试职责：验证 agent-loop-engine 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { AgentLoopEngine } from "./agent-loop.js";
import { DurableToolRuntime } from "./tool-runtime.js";
import { InMemoryPipelineStore, ToolGateway, type ModelEvent, type ModelGateway, type ModelRequest, type TerminationGate } from "./index.js";

const completeWhenTextContainsDone: TerminationGate = {
  evaluate: ({ content }) => content?.includes("done") ? { action: "complete", reason: "DONE" } : { action: "continue", reason: "CONTINUE" },
};

function baseInput(gate: TerminationGate = completeWhenTextContainsDone) {
  return {
    ownerType: "run" as const,
    ownerId: "run-1",
    role: "executor" as const,
    mode: "factory-controlled" as const,
    maxSteps: 4,
    modelRequest: { messages: [{ role: "user" as const, content: "execute" }] },
    gate,
  };
}

describe("AgentLoopEngine", () => {
  it("runs model, tool, tool result, and model again within one loop", async () => {
    const store = new InMemoryPipelineStore();
    let calls = 0;
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: true, supportedLoopModes: ["factory-controlled"] }),
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        calls += 1;
        expect(request.role).toBe("executor");
        if (calls === 1) {
          yield { type: "tool.call", call: { callId: "call-1", tool: "run_registered_command", input: { commandId: "project.test" } } };
        } else {
          yield { type: "text.delta", text: "done" };
        }
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const toolRuntime = new DurableToolRuntime(store, new ToolGateway({ role: "executor", workspaceRoot: "/tmp/project", registeredCommandIds: new Set(["project.test"]), handler: async () => ({ exitCode: 0 }) }));

    const loop = await new AgentLoopEngine(store, model, toolRuntime).run({ ...baseInput(), workspacePath: "/tmp/project" });

    expect(loop).toMatchObject({ state: "COMPLETED", stepCount: 2 });
    expect(store.listToolCalls()).toHaveLength(1);
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toEqual(expect.arrayContaining(["TOOL_REQUESTED", "TOOL_COMPLETED", "GATE_CHECKED", "LOOP_COMPLETED"]));
    expect(store.listEvents({ aggregateId: loop.id }).map((event) => event.type)).toEqual(expect.arrayContaining(["agent.tool.requested", "agent.tool.running", "agent.tool.completed"]));
  });

  it("emits a failed tool event separately from a policy denial", async () => {
    const store = new InMemoryPipelineStore();
    let calls = 0;
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: true, supportedLoopModes: ["factory-controlled"] }),
      async *stream() {
        calls += 1;
        if (calls === 1) yield { type: "tool.call", call: { callId: "failed-tool", tool: "git_status", input: {} } };
        else yield { type: "text.delta", text: "done" };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const runtime: import("./tool-runtime.js").ToolRuntime = {
      async execute(call) { return { callId: call.callId, allowed: false, status: "FAILED", reason: "MCP timeout", result: null, audited: true }; },
      async reconcile() { return undefined; },
    };
    const loop = await new AgentLoopEngine(store, model, runtime).run({ ...baseInput(), workspacePath: "/tmp/project" });

    expect(loop.state).toBe("COMPLETED");
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toContain("TOOL_FAILED");
    expect(store.listEvents({ aggregateId: loop.id }).map((event) => event.type)).toContain("agent.tool.failed");
  });

  it("stops the loop when a tool result needs reconciliation", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: true, supportedLoopModes: ["factory-controlled"] }),
      async *stream() {
        yield { type: "tool.call", call: { callId: "uncertain-tool", tool: "write_file", input: { path: "src/index.ts", content: "unknown" } } };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const runtime: import("./tool-runtime.js").ToolRuntime = {
      async execute(call) { return { callId: call.callId, allowed: false, status: "NEEDS_RECONCILIATION", reason: "side effect status is unknown", result: null, audited: true }; },
      async reconcile() { return undefined; },
    };

    const loop = await new AgentLoopEngine(store, model, runtime).run({ ...baseInput(), workspacePath: "/tmp/project" });

    expect(loop.state).toBe("NEEDS_RECONCILIATION");
    expect(store.listEvents({ aggregateId: loop.id }).map((event) => event.type)).toContain("agent.loop.recovery_required");
  });

  it("suspends on structured input and resumes the same loop", async () => {
    const store = new InMemoryPipelineStore();
    let answered = false;
    const model: ModelGateway = {
      configFor: () => ({ model: "explorer" }),
      capabilities: () => ({ supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() {
        yield { type: "turn.input_required", request: { requestId: "request-1", threadId: "provider-thread", turnId: "provider-turn", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } };
        if (answered) yield { type: "text.delta", text: "done" };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { answered = true; },
      async cancel() { return undefined; },
    };
    const engine = new AgentLoopEngine(store, model);
    const loop = await engine.start({ ...baseInput(completeWhenTextContainsDone), role: "explorer", mode: "provider-controlled", ownerType: "explorer-turn", ownerId: "turn-1", maxSteps: 2 });
    for (let attempt = 0; attempt < 50 && store.getAgentLoop(loop.id)?.state !== "WAITING_FOR_INPUT"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(store.getAgentLoop(loop.id)).toMatchObject({ state: "WAITING_FOR_INPUT" });
    await engine.answerInput(loop.id, "request-1", {});
    const completed = await engine.wait(loop.id);
    expect(completed).toMatchObject({ state: "COMPLETED", stepCount: 1 });
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toEqual(expect.arrayContaining(["INPUT_REQUIRED", "INPUT_RESOLVED"]));
  });

  it("blocks instead of looping beyond the configured step limit", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() { yield { type: "text.delta", text: "no progress" }; yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    const loop = await new AgentLoopEngine(store, model).run({ ...baseInput({ evaluate: () => ({ action: "continue", reason: "KEEP_GOING" }) }), mode: "provider-controlled", maxSteps: 2 });

    expect(loop).toMatchObject({ state: "BLOCKED", stepCount: 2 });
    expect(store.listAgentLoopSteps(loop.id).at(-1)?.payload).toMatchObject({ reason: "MAX_STEPS_EXCEEDED" });
  });

  it("fails closed when Factory-controlled execution lacks model tool-call capability", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() { yield { type: "text.delta", text: "should not run" }; yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    const loop = await new AgentLoopEngine(store, model).run({ ...baseInput(), mode: "factory-controlled" });

    expect(loop.state).toBe("BLOCKED");
    expect(store.listAgentLoopSteps(loop.id).at(-1)?.payload).toMatchObject({ reason: "MODEL_CAPABILITY_UNAVAILABLE" });
  });

  it("does not resolve an input request before the provider accepts the answer", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "explorer" }),
      capabilities: () => ({ supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() {
        yield { type: "turn.input_required", request: { requestId: "request-fails", threadId: "provider-thread", turnId: "provider-turn", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { throw new Error("provider response uncertain"); },
      async cancel() { return undefined; },
    };
    const engine = new AgentLoopEngine(store, model);
    const loop = await engine.start({ ...baseInput(), role: "explorer", mode: "provider-controlled", ownerType: "explorer-turn", ownerId: "turn-1", maxSteps: 1 });
    for (let attempt = 0; attempt < 50 && store.getAgentLoop(loop.id)?.state !== "WAITING_FOR_INPUT"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(engine.answerInput(loop.id, "request-fails", {})).rejects.toThrow("provider response uncertain");
    await expect(engine.wait(loop.id)).resolves.toMatchObject({ state: "FAILED" });
  });

  it("cancels a loop waiting for input without an unhandled completion rejection", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "explorer" }),
      capabilities: () => ({ supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() {
        yield { type: "turn.input_required", request: { requestId: "request-cancel", threadId: "provider-thread", turnId: "provider-turn", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const engine = new AgentLoopEngine(store, model);
    const loop = await engine.start({ ...baseInput(), role: "explorer", mode: "provider-controlled", ownerType: "explorer-turn", ownerId: "turn-cancel", maxSteps: 1 });
    for (let attempt = 0; attempt < 50 && store.getAgentLoop(loop.id)?.state !== "WAITING_FOR_INPUT"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(engine.cancel(loop.id, "user_cancelled")).resolves.toMatchObject({ state: "CANCELLED" });
    await expect(engine.wait(loop.id)).resolves.toMatchObject({ state: "CANCELLED" });
  });
});
