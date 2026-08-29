import { describe, expect, it } from "vitest";
import {
  CodexAppServerGateway,
  type CodexAppServerSession,
  type CodexAppServerSessionFactory,
} from "./index.js";

function createSessionFactory(events: Array<{ id?: string | number; method: string; params: Record<string, unknown> }>, calls: Array<{ method: string; params: unknown }>): CodexAppServerSessionFactory {
  const session: CodexAppServerSession = {
    startThread: async (params) => {
      calls.push({ method: "thread/start", params });
      return "codex-thread-1";
    },
    resumeThread: async (threadId) => {
      calls.push({ method: "thread/resume", params: { threadId } });
    },
    streamTurn: async function* (params) {
      calls.push({ method: "turn/start", params });
      for (const event of events) yield event;
    },
    interrupt: async (threadId, turnId) => {
      calls.push({ method: "turn/interrupt", params: { threadId, turnId } });
    },
    respond: async (requestId, result) => { calls.push({ method: "response", params: { requestId, result } }); },
    answerUserInput: async (requestId, response) => { calls.push({ method: "input/answer", params: { requestId, response } }); },
    close: async () => undefined,
  };
  return async () => session;
}

describe("CodexAppServerGateway", () => {
  it("creates a read-only Explorer thread and maps App Server stream events", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "item/agentMessage/delta", params: { delta: "hello" } },
        { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
      ], calls),
    });

    const events = [];
    for await (const event of gateway.stream({
      role: "explorer",
      conversationId: "explorer-1",
      messages: [{ role: "user", content: "inspect the repository" }],
    })) events.push(event);

    expect(events).toEqual([
      { type: "thread.started", threadId: "codex-thread-1" },
      { type: "text.delta", text: "hello" },
      { type: "turn.completed" },
    ]);
    expect(calls[0]).toMatchObject({
      method: "thread/start",
      params: { model: "explorer-model", sandbox: "read-only", approvalPolicy: "never" },
    });
    expect((calls[0]?.params as { collaborationMode?: unknown } | undefined)?.collaborationMode).toMatchObject({ mode: "plan", settings: { model: "explorer-model" } });
    expect(calls[1]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "codex-thread-1",
        collaborationMode: {
          mode: "plan",
          settings: { model: "explorer-model", developer_instructions: null },
        },
      },
    });
  });

  it("reuses a persisted provider thread and maps an interrupted turn", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "turn/completed", params: { turn: { id: "turn-2", status: "interrupted" } } },
      ], calls),
    });
    const events = [];
    const stream = gateway.stream({
      role: "explorer",
      conversationId: "explorer-1",
      providerThreadId: "codex-thread-existing",
      messages: [{ role: "user", content: "continue" }],
    });
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ type: "turn.cancelled" }]);
    expect(calls.map((call) => call.method)).toEqual(["thread/resume", "turn/start"]);
  });

  it("maps a structured App Server request and answers it using the preserved request id", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([{ id: "server-request-1", method: "item/tool/requestUserInput", params: { threadId: "codex-thread-1", turnId: "turn-1", itemId: "item-1", questions: [{ id: "q1", header: "Choice", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "A", description: "Option A" }] }], isBlocking: true, autoResolutionMs: null } }], calls),
    });

    const events = [];
    for await (const event of gateway.stream({ role: "explorer", conversationId: "explorer-structured", messages: [{ role: "user", content: "ask me" }] })) events.push(event);
    expect(events).toMatchObject([{ type: "thread.started", threadId: "codex-thread-1" }, { type: "turn.input_required", request: { requestId: "server-request-1", threadId: "codex-thread-1", turnId: "turn-1", itemId: "item-1" } }]);

    await gateway.answerUserInput({ requestId: "server-request-1", answers: { q1: { answers: ["A"] } } });
    expect(calls.at(-1)).toMatchObject({ method: "input/answer", params: { requestId: "server-request-1", response: { answers: { q1: { answers: ["A"] } } } } });
  });

  it("surfaces provider item lifecycle activity without pretending Factory owns the provider loop", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "item/started", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-mcp-1", type: "mcpToolCall", name: "search_text" } } },
        { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-mcp-1", type: "mcpToolCall", name: "search_text" } } },
        { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-message-1", type: "agentMessage", text: "do not duplicate" } } },
        { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
      ], calls),
    });

    const events = [];
    for await (const event of gateway.stream({ role: "explorer", conversationId: "explorer-activity", messages: [{ role: "user", content: "inspect" }] })) events.push(event);

    expect(events).toMatchObject([
      { type: "thread.started" },
      { type: "provider.activity", phase: "started", itemId: "item-mcp-1", itemType: "mcpToolCall" },
      { type: "provider.activity", phase: "completed", itemId: "item-mcp-1", itemType: "mcpToolCall" },
      { type: "turn.completed" },
    ]);
  });

  it("interrupts the existing provider session when the loop id differs from the Explorer id", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let factoryCalls = 0;
    const sessionFactory: CodexAppServerSessionFactory = async () => {
      factoryCalls += 1;
      return createSessionFactory([
        { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
      ], calls)();
    };
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory,
    });

    for await (const _event of gateway.stream({ role: "explorer", conversationId: "explorer-1", messages: [{ role: "user", content: "inspect" }] })) { /* consume */ }
    await gateway.cancel({ conversationId: "agent-loop-1", providerThreadId: "codex-thread-1", providerTurnId: "turn-1" });

    expect(factoryCalls).toBe(1);
    expect(calls.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "codex-thread-1", turnId: "turn-1" } });
  });
});
