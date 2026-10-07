/**
 * 测试职责：验证 codex-app-server 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import {
  CodexAppServerGateway,
  type CodexAppServerSession,
  type CodexAppServerSessionFactory,
  type ModelRoleConfig,
} from "../index.js";

function createSessionFactory(
  events: Array<{ id?: string | number; method: string; params: Record<string, unknown> }>,
  calls: Array<{ method: string; params: unknown }>,
  options: { failResume?: boolean } = {},
): CodexAppServerSessionFactory {
  const session: CodexAppServerSession = {
    startThread: async (params) => {
      calls.push({ method: "thread/start", params });
      return "codex-thread-1";
    },
    resumeThread: async (threadId) => {
      calls.push({ method: "thread/resume", params: { threadId } });
      if (options.failResume) throw new Error(`thread/resume failed for ${threadId}`);
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
  it("describes the Codex CLI it launched, without pretending to know the upstream endpoint", async () => {
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      command: "codex",
      args: ["app-server", "--stdio"],
      sessionFactory: createSessionFactory([], []),
    });

    // Codex 没有可配的 baseUrl：能担保的只有"启动了哪个 CLI"，上游端点在 Codex 自己的登录态里。
    expect(gateway.describeEndpoint()).toEqual({
      backend: "codex-app-server",
      endpoint: "codex app-server --stdio",
      source: "provider-settings",
      cliVersion: null,
      credentialSource: null,
      providerModel: null,
    });
  });

  it("creates a read-only Explorer thread and maps App Server stream events", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "turn-1", delta: "hello" } },
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
      { type: "text.delta", text: "hello", providerThreadId: "codex-thread-1", providerTurnId: "turn-1" },
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

  it("uses a plain read-only model turn for Explorer title generation", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "turn-title", delta: "订单取消流程优化" } },
        { method: "turn/completed", params: { turn: { id: "turn-title", status: "completed" } } },
      ], calls),
    });

    for await (const _event of gateway.stream({
      role: "explorer",
      purpose: "title",
      // 起标题的调用方显式要 default 模式：网关不再从 purpose 反推模式（P9 之前那两处特例已删）。
      mode: "default",
      conversationId: "title-explorer-1",
      messages: [{ role: "user", content: "请给这条需求生成标题" }],
    })) { /* consume the stream */ }

    expect(calls[0]).toMatchObject({ method: "thread/start", params: { sandbox: "read-only", approvalPolicy: "never" } });
    expect((calls[0]?.params as { collaborationMode?: unknown } | undefined)?.collaborationMode).toMatchObject({ mode: "default", settings: { model: "explorer-model" } });
    expect(calls[0]?.params).not.toHaveProperty("developerInstructions");
    expect(calls[1]).toMatchObject({ method: "turn/start", params: { collaborationMode: { mode: "default" } } });
  });

  it("resolves the run mode from request, then role config, then the per-role default", async () => {
    const startCall = async (input: { roles: Record<string, ModelRoleConfig>; mode?: "plan" | "default" }): Promise<{ collaborationMode?: unknown; developerInstructions?: unknown }> => {
      const calls: Array<{ method: string; params: unknown }> = [];
      const gateway = new CodexAppServerGateway({
        roles: input.roles,
        sessionFactory: createSessionFactory([{ method: "turn/completed", params: { turn: { id: "turn-mode", status: "completed" } } }], calls),
      });
      for await (const _event of gateway.stream({ role: "explorer", conversationId: "mode-thread", messages: [{ role: "user", content: "hi" }], ...(input.mode ? { mode: input.mode } : {}) })) { /* consume */ }
      return (calls[0]?.params ?? {}) as { collaborationMode?: unknown; developerInstructions?: unknown };
    };

    // 请求级覆盖优先：角色配置说 plan，但这次调用明确要 default。
    expect((await startCall({ roles: { explorer: { model: "explorer-model", mode: "plan" }, executor: { model: "executor-model" } }, mode: "default" })).collaborationMode).toMatchObject({ mode: "default" });
    // 其次才是角色配置：没有请求级覆盖时 roleConfig.mode 真的生效（旧实现忽略它，恒按角色取 plan）。
    expect((await startCall({ roles: { explorer: { model: "explorer-model", mode: "default" }, executor: { model: "executor-model" } } })).collaborationMode).toMatchObject({ mode: "default" });
    // 最后才是按角色默认：两者都没写时 Explorer 仍是 plan，且带上探索指令。
    const fallback = await startCall({ roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } } });
    expect(fallback.collaborationMode).toMatchObject({ mode: "plan" });
    expect(typeof fallback.developerInstructions).toBe("string");
  });

  it("rebuilds a lost provider thread from the persisted transcript instead of failing the turn", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory(
        [{ method: "turn/completed", params: { turn: { id: "turn-rebuilt", status: "completed" } } }],
        calls,
        { failResume: true },
      ),
    });
    const events = [];
    for await (const event of gateway.stream({
      role: "explorer",
      conversationId: "rebuild-thread",
      providerThreadId: "codex-thread-gone",
      messages: [
        { role: "user", content: "先看看订单模块" },
        { role: "assistant", content: "订单模块有三个入口" },
        { role: "user", content: "那取消流程呢" },
      ],
    })) events.push(event);

    // 续接失败 → 重建新线程，并把本地整段对话回放进去，而不是把可恢复的丢失升级成回合失败。
    expect(calls.map((call) => call.method)).toEqual(["thread/resume", "thread/start", "turn/start"]);
    expect((calls[2]?.params as { input?: Array<{ text: string }> })?.input?.[0]?.text).toContain("订单模块有三个入口");
    expect(events.some((event) => event.type === "thread.started")).toBe(true);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "provider.activity" && event.itemType === "providerSession")).toBe(true);
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
      sessionFactory: createSessionFactory([{ id: "server-request-1", method: "item/tool/requestUserInput", params: { threadId: "codex-thread-1", turnId: "turn-1", itemId: "item-1", questions: [{ id: "q1", header: "Choice", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "A", description: "Option A" }] }], isBlocking: true } }], calls),
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
      { type: "provider.activity", phase: "started", itemId: "item-mcp-1", itemType: "mcpToolCall", providerThreadId: "codex-thread-1", providerTurnId: "turn-1" },
      { type: "provider.activity", phase: "completed", itemId: "item-mcp-1", itemType: "mcpToolCall", providerThreadId: "codex-thread-1", providerTurnId: "turn-1" },
      { type: "turn.completed" },
    ]);
  });

  it("maps nested Codex App Server token usage notifications", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory([
        { method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-1", tokenUsage: { total: { inputTokens: 240, outputTokens: 80, reasoningOutputTokens: 25, totalTokens: 320 } } } },
        { method: "turn/completed", params: { turn: { id: "turn-usage", status: "completed", usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } } },
      ], calls),
    });

    const events = [];
    for await (const event of gateway.stream({ role: "executor", conversationId: "executor-usage", messages: [{ role: "user", content: "execute" }] })) events.push(event);

    expect(events).toEqual([
      { type: "thread.started", threadId: "codex-thread-1" },
      { type: "model.usage", usage: { inputTokens: 240, outputTokens: 80, reasoningTokens: 25, totalTokens: 320 }, scope: "total", providerThreadId: "codex-thread-1" },
      { type: "model.usage", usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: null, totalTokens: 17 }, scope: "turn", providerThreadId: "codex-thread-1", providerTurnId: "turn-usage" },
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

  it("multiplexes concurrent requirement threads over one App Server session", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let factoryCalls = 0;
    let threadCount = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const session: CodexAppServerSession = {
      startThread: async () => `provider-thread-${++threadCount}`,
      resumeThread: async (threadId) => { calls.push({ method: "thread/resume", params: { threadId } }); },
      streamTurn: async function* (params) {
        calls.push({ method: "turn/start", params });
        if (params.threadId === "provider-thread-1") {
          await firstGate;
        } else {
          yield {
            id: "input-request-2",
            method: "item/tool/requestUserInput",
            params: {
              threadId: params.threadId,
              turnId: `turn-${params.threadId}`,
              itemId: "input-item-2",
              questions: [{ id: "q1", header: "Choice", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "B", description: "Option B" }] }],
              isBlocking: true,
            },
          };
          await secondGate;
        }
        yield { method: "item/agentMessage/delta", params: { threadId: params.threadId, turnId: `turn-${params.threadId}`, delta: params.threadId } };
        yield { method: "turn/completed", params: { turn: { id: `turn-${params.threadId}`, status: "completed" } } };
      },
      interrupt: async (threadId, turnId) => { calls.push({ method: "turn/interrupt", params: { threadId, turnId } }); },
      respond: async () => undefined,
      answerUserInput: async (requestId, response) => {
        calls.push({ method: "input/answer", params: { requestId, response } });
        if (requestId === "input-request-2") releaseSecond();
      },
      close: async () => undefined,
    };
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: async () => { factoryCalls += 1; return session; },
    });
    const firstEvents: Array<{ type: string; text?: string | undefined; providerThreadId?: string | undefined }> = [];
    const secondEvents: typeof firstEvents = [];
    const consume = async (conversationId: string, events: typeof firstEvents) => {
      for await (const event of gateway.stream({ role: "explorer", conversationId, messages: [{ role: "user", content: conversationId }] })) events.push(event);
    };
    const first = consume("requirement-1", firstEvents);
    const second = consume("requirement-2", secondEvents);
    for (let attempt = 0; attempt < 50 && calls.filter((call) => call.method === "turn/start").length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(factoryCalls).toBe(1);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    for (let attempt = 0; attempt < 50 && !secondEvents.some((event) => event.type === "turn.input_required"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(secondEvents).toContainEqual(expect.objectContaining({ type: "turn.input_required", request: expect.objectContaining({ requestId: "input-request-2", threadId: "provider-thread-2", turnId: "turn-provider-thread-2" }) }));
    await gateway.answerUserInput({ requestId: "input-request-2", answers: { q1: { answers: ["B"] } } });
    await second;
    releaseFirst();
    await first;

    expect(firstEvents).toContainEqual({ type: "text.delta", text: "provider-thread-1", providerThreadId: "provider-thread-1", providerTurnId: "turn-provider-thread-1" });
    expect(secondEvents).toContainEqual({ type: "text.delta", text: "provider-thread-2", providerThreadId: "provider-thread-2", providerTurnId: "turn-provider-thread-2" });
    expect(calls).toContainEqual({ method: "input/answer", params: { requestId: "input-request-2", response: { answers: { q1: { answers: ["B"] } } } } });
    await gateway.cancel({ conversationId: "requirement-1", providerThreadId: "provider-thread-1", providerTurnId: "turn-provider-thread-1" });
    expect(calls.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: "provider-thread-1", turnId: "turn-provider-thread-1" } });
    await gateway.close();
  });
});

/**
 * 这一组钉的是**数据层曾经丢掉的东西**：`agentMessage.phase`（过程叙述 vs 最终回答）、
 * 工具的结构化载荷，以及那些"没有 item 载体"的运行事实通知。
 */
describe("Codex 侧的数据层：读什么、为什么读", () => {
  async function run(events: Array<{ id?: string | number; method: string; params: Record<string, unknown> }>) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      sessionFactory: createSessionFactory(events, calls),
    });
    const streamed = [];
    for await (const event of gateway.stream({ role: "explorer", conversationId: "explorer-phase", messages: [{ role: "user", content: "inspect" }] })) streamed.push(event);
    return streamed;
  }

  it("**`agentMessage` 的 `phase` 单独送一趟** —— 它在 item 上，不在 delta 的载荷里", async () => {
    const events = await run([
      { method: "item/started", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-msg-1", type: "agentMessage", phase: "commentary", text: "先看一圈" } } },
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-msg-2", type: "agentMessage", phase: "final_answer", text: "结论" } } },
      // Provider 不保证给 phase（schema 原话：treat None as "phase unknown"）——不给就不发，别猜。
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "item-msg-3", type: "agentMessage", text: "无 phase" } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    // 正文本身走 `item/agentMessage/delta`，这里**不重复产出活动行**——只送"这一段是哪一类"。
    const phases = events.filter((event) => event.type === "text.phase");
    expect(phases).toEqual([
      { type: "text.phase", providerItemId: "item-msg-1", phase: "commentary" },
      { type: "text.phase", providerItemId: "item-msg-2", phase: "final_answer" },
    ]);
    expect(events.some((event) => event.type === "provider.activity")).toBe(false);
  });

  it("命令的**输出、退出码与耗时**跟着事件走，不再只剩一句摘要", async () => {
    const events = await run([
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "exec-1", type: "commandExecution", command: "pnpm test", status: "failed", exitCode: 1, aggregatedOutput: "1 failed", durationMs: 2_500 } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    expect(events).toContainEqual(expect.objectContaining({
      type: "provider.activity", activityKind: "command", outcome: "failed",
      output: "1 failed", exitCode: 1, durationMs: 2_500, summary: "pnpm test",
    }));
  });

  it("**推理的文字在数组里** —— `summary[]` 此前取不到，整段被丢掉", async () => {
    // 实测抓到的：Codex 的 `reasoning` item 是 `{ content: string[], summary: string[] }`，
    // 而适配器只读字符串字段（`command` / `text`），于是推理正文整段丢掉、界面上只剩一个「推理」标签，
    // 展开也没有东西——看起来像"这一轮没推理"。Claude 侧同样的问题这一轮已经补上（读 `thinking` 块）。
    const events = await run([
      { method: "item/started", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "rs-1", type: "reasoning", summary: ["先看现有的活动投影。", "再决定每一类各摆什么。"], content: ["绝密的原始思维链"] } } },
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "rs-1", type: "reasoning", summary: ["先看现有的活动投影。", "再决定每一类各摆什么。"], content: [] } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    const reasoning = events.filter((event) => event.type === "provider.activity" && event.activityKind === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]).toMatchObject({ summary: "先看现有的活动投影。\n\n再决定每一类各摆什么。" });
    // `content[]` 是原始思维链，按本仓的立场**不展示**——只取 Provider 自己给的摘要。
    expect(JSON.stringify(events)).not.toContain("绝密的原始思维链");
  });

  it("推理没有摘要时不编内容（空数组与空串都算没有）", async () => {
    const events = await run([
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "rs-2", type: "reasoning", summary: [], content: ["只有原文"] } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    expect(events).toContainEqual(expect.objectContaining({ activityKind: "reasoning", summary: null }));
  });

  it("MCP 与动态工具的**参数和返回**原样带上来", async () => {
    const events = await run([
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "mcp-1", type: "mcpToolCall", server: "github", tool: "create_issue", arguments: { title: "x" }, result: { number: 42 }, status: "completed" } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    expect(events).toContainEqual(expect.objectContaining({ activityKind: "mcp", arguments: { title: "x" }, result: { number: 42 } }));
  });

  it("**Codex 声明拒绝的命令是 failed** —— `declined` 曾漏在失败词表外，被显示成「状态未知」", async () => {
    const events = await run([
      { method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { id: "exec-2", type: "commandExecution", command: "rm -rf /", status: "declined" } } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    expect(events).toContainEqual(expect.objectContaining({ activityKind: "command", outcome: "failed", status: "declined" }));
  });

  it("**没有 item 载体的运行事实**（压缩 / 钩子 / 配额 / 告警）也走同一条通道", async () => {
    const events = await run([
      { method: "thread/compacted", params: { threadId: "codex-thread-1", turnId: "turn-1" } },
      { method: "hook/started", params: { threadId: "codex-thread-1", turnId: "turn-1", run: { id: "hook-run-1", eventName: "PostToolUse", status: "running" } } },
      { method: "hook/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", run: { id: "hook-run-1", eventName: "PostToolUse", status: "failed", statusMessage: "lint 失败", durationMs: 400 } } },
      { method: "account/rateLimits/updated", params: { threadId: "codex-thread-1" } },
      { method: "warning", params: { threadId: "codex-thread-1", message: "配置里有一个不认识的键。" } },
      { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
    ]);

    const runtime = events.flatMap((event) => event.type === "provider.activity" ? [event.activityKind] : []);
    expect(runtime).toEqual(["compaction", "hook", "hook", "rate-limit", "warning"]);
    expect(events).toContainEqual(expect.objectContaining({ activityKind: "hook", outcome: "failed", error: "lint 失败", durationMs: 400 }));
    expect(events).toContainEqual(expect.objectContaining({ activityKind: "warning", summary: "配置里有一个不认识的键。" }));
  });
});
