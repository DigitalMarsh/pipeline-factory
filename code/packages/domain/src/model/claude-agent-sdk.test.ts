/**
 * 测试职责：验证 claude-agent-sdk 适配器的业务场景、异常分支和回归约束。
 *
 * 设计说明：全部用例都用注入的 queryFactory/sessionExists，**不启动真实 CLI、不访问网络** ——
 *   与 codex-app-server.test.ts 一样，fixture 只构造本测试需要的事件序列。约定：
 *   - 事件序列由脚本按 SDK 的消息形状给出（system/init、stream_event、assistant、user、result）；
 *   - canUseTool 由脚本显式调用，用来复现"结构化提问挂起 → answerUserInput 送达答案"这条并发路径。
 *
 * 维护提示：ModelEvent 契约或 Options 的构造方式变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkGateway, type ClaudeQueryHandle } from "../index.js";
import type { ModelEvent, ModelRequest } from "../index.js";

const message = (value: unknown): SDKMessage => value as SDKMessage;

function initMessage(sessionId: string, reported: Record<string, unknown> = {}): SDKMessage {
  return message({ type: "system", subtype: "init", session_id: sessionId, cwd: "/tmp/repo", tools: [], model: "claude-opus-5", permissionMode: "default", ...reported });
}

function textDelta(sessionId: string, text: string): SDKMessage {
  return message({ type: "stream_event", session_id: sessionId, uuid: `uuid-${text}`, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
}

function assistantToolUse(sessionId: string, id: string, name: string, input: Record<string, unknown>): SDKMessage {
  return message({ type: "assistant", session_id: sessionId, uuid: `uuid-${id}`, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
}

function toolResult(sessionId: string, toolUseId: string, text: string, isError = false): SDKMessage {
  return message({ type: "user", session_id: sessionId, uuid: `uuid-${toolUseId}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }], is_error: isError }] } });
}

function resultMessage(sessionId: string, input: Record<string, unknown> = {}): SDKMessage {
  return message({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 8,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    result: "done",
    ...input,
  });
}

type Capture = { prompt: string; options: Options; handle: ClaudeQueryHandle };

/** 用一段消息脚本构造 query 工厂；脚本可显式触发 canUseTool 以复现结构化提问。 */
function createFactory(
  captures: Capture[],
  script: (context: {
    options: Options;
    sessionId: string;
    runPermission: (toolName: string, input: Record<string, unknown>, requestId: string, toolUseID: string) => Promise<unknown>;
  }) => AsyncIterable<SDKMessage>,
): (input: { prompt: string; options: Options }) => Promise<ClaudeQueryHandle> {
  return async ({ prompt, options }) => {
    const handle: ClaudeQueryHandle = {
      stream: () => script({
        options,
        sessionId: SessionIds.next(),
        runPermission: async (toolName, input, requestId, toolUseID) => {
          const canUseTool = options.canUseTool;
          if (!canUseTool) return null;
          const controller = new AbortController();
          return await canUseTool(toolName, input, {
            signal: controller.signal,
            suggestions: [],
            toolUseID,
            requestId,
            decisionReason: "test",
          } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        },
      }),
      interrupt: async () => undefined,
    };
    captures.push({ prompt, options, handle });
    return handle;
  };
}

/** 每个用例内稳定的 provider 会话 id 序列。 */
const SessionIds = {
  next: (() => {
    let counter = 0;
    return () => `session-${++counter}`;
  })(),
};

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** 轮询等待条件成立；结构化提问是回调驱动的，事件到达没有同步信号。 */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const roles = { explorer: { model: "claude-opus-5" }, executor: { model: "claude-opus-5" } };

function explorerRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { role: "explorer", conversationId: "thread-1", messages: [{ role: "user", content: "设计取消订单流程" }], ...overrides };
}

describe("ClaudeAgentSdkGateway", () => {
  it("maps the SDK message stream onto ModelEvent", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId);
        yield textDelta(sessionId, "先看");
        yield textDelta(sessionId, "订单模块");
        yield assistantToolUse(sessionId, "tool-1", "Read", { file_path: "/tmp/repo/orders.ts" });
        yield toolResult(sessionId, "tool-1", "export function cancelOrder() {}");
        yield resultMessage(sessionId);
      }),
    });

    const events = await collect(gateway.stream(explorerRequest()));

    expect(events[0]).toMatchObject({ type: "thread.started", threadId: captures[0]?.options.resume ?? expect.any(String) });
    expect(events.filter((event) => event.type === "text.delta").map((event) => (event as { text: string }).text).join("")).toBe("先看订单模块");
    expect(events).toContainEqual(expect.objectContaining({ type: "provider.activity", phase: "started", toolName: "Read", itemId: "tool-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "provider.activity", phase: "completed", status: "succeeded", itemId: "tool-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "model.usage", usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }) }));
    expect(events.at(-1)).toEqual({ type: "turn.completed" });
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("round-trips AskUserQuestion through turn.input_required and answerUserInput", async () => {
    const captures: Capture[] = [];
    let permissionResult: unknown;
    const questions = [
      { question: "Which colour do you prefer?", header: "Colour", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
    ];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId, runPermission }) {
        yield initMessage(sessionId);
        permissionResult = await runPermission("AskUserQuestion", { questions }, "req-1", "tool-ask");
        yield resultMessage(sessionId);
      }),
    });

    const events: ModelEvent[] = [];
    const consume = (async () => { for await (const event of gateway.stream(explorerRequest())) events.push(event); })();
    await waitFor(() => events.some((event) => event.type === "turn.input_required"));

    const request = events.find((event) => event.type === "turn.input_required");
    expect(request).toMatchObject({
      request: {
        requestId: "req-1",
        itemId: "tool-ask",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{ id: "0", header: "Colour", question: "Which colour do you prefer?", isOther: true, isSecret: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }],
      },
    });

    await gateway.answerUserInput({ requestId: "req-1", answers: { "0": { answers: ["Blue"] } } });
    await consume;

    // 回传形状：allow + updatedInput.answers，键是题目原文（CLI 侧的输出契约就是"题目原文 -> 答案"）。
    expect(permissionResult).toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which colour do you prefer?": "Blue" } } });
    expect(events.at(-1)).toEqual({ type: "turn.completed" });
  });

  it("joins multi-select answers with a comma and keeps the option list verbatim", async () => {
    const captures: Capture[] = [];
    let permissionResult: unknown;
    const questions = [{ question: "Which features?", header: "Features", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId, runPermission }) {
        yield initMessage(sessionId);
        permissionResult = await runPermission("AskUserQuestion", { questions }, "req-multi", "tool-multi");
        yield resultMessage(sessionId);
      }),
    });
    const events: ModelEvent[] = [];
    const consume = (async () => { for await (const event of gateway.stream(explorerRequest())) events.push(event); })();
    await waitFor(() => events.some((event) => event.type === "turn.input_required"));
    await gateway.answerUserInput({ requestId: "req-multi", answers: { "0": { answers: ["A", "B"] } } });
    await consume;
    expect(permissionResult).toEqual({ behavior: "allow", updatedInput: { questions, answers: { "Which features?": "A, B" } } });
  });

  it("denies structured questions for the executor, which has no answer channel", async () => {
    const captures: Capture[] = [];
    let permissionResult: unknown;
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId, runPermission }) {
        yield initMessage(sessionId);
        permissionResult = await runPermission("AskUserQuestion", { questions: [{ question: "ok?", options: [] }] }, "req-exec", "tool-exec");
        yield resultMessage(sessionId);
      }),
    });

    await collect(gateway.stream({ role: "executor", conversationId: "run-1", messages: [{ role: "user", content: "执行" }] }));

    expect(permissionResult).toMatchObject({ behavior: "deny" });
    expect(gateway.capabilities("executor").supportsStructuredUserInput).toBe(false);
    expect(gateway.capabilities("explorer").supportsStructuredUserInput).toBe(true);
    // Executor 的工具集里不能出现 AskUserQuestion，否则模型会走到一个没人接的提问上。
    expect(captures[0]?.options.tools).not.toContain("AskUserQuestion");
    expect(captures[0]?.options.disallowedTools).toContain("AskUserQuestion");
    expect(captures[0]?.options.permissionMode).toBe("acceptEdits");
  });

  it("keeps the explorer read-only in plan mode and denies requests that leave the session directory", async () => {
    const captures: Capture[] = [];
    let outsideResult: unknown;
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId);
        const canUseTool = captures[0]?.options.canUseTool;
        if (canUseTool) {
          outsideResult = await canUseTool("Read", { file_path: "/etc/passwd" }, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: "tool-outside",
            requestId: "req-outside",
            blockedPath: "/etc/passwd",
          } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        }
        yield resultMessage(sessionId);
      }),
    });

    await collect(gateway.stream(explorerRequest({ cwd: "/tmp/repo" })));

    expect(captures[0]?.options.permissionMode).toBe("plan");
    expect(captures[0]?.options.cwd).toBe("/tmp/repo");
    expect(typeof captures[0]?.options.planModeInstructions).toBe("string");
    expect(outsideResult).toMatchObject({ behavior: "deny" });
  });

  it("rebuilds a missing provider session from the persisted transcript", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => false,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId);
        yield resultMessage(sessionId);
      }),
    });

    const events = await collect(gateway.stream(explorerRequest({
      providerThreadId: "session-gone",
      messages: [
        { role: "user", content: "先看看订单模块" },
        { role: "assistant", content: "订单模块有三个入口" },
        { role: "user", content: "那取消流程呢" },
      ],
    })));

    // 不再 resume（会话已经不在磁盘上），而是把本地整段对话回放进去。
    expect(captures[0]?.options.resume).toBeUndefined();
    expect(captures[0]?.prompt).toContain("订单模块有三个入口");
    expect(captures[0]?.prompt).toContain("那取消流程呢");
    expect(events).toContainEqual(expect.objectContaining({ type: "provider.activity", itemType: "providerSession", title: "Provider session rebuilt" }));
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("resumes an existing session and only re-announces a different thread id", async () => {
    const resumed: Capture[] = [];
    const resuming = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(resumed, async function* () {
        yield initMessage("session-existing");
        yield resultMessage("session-existing");
      }),
    });
    const resumedEvents = await collect(resuming.stream(explorerRequest({ providerThreadId: "session-existing" })));
    expect(resumed[0]?.options.resume).toBe("session-existing");
    expect(resumedEvents.some((event) => event.type === "thread.started")).toBe(false);

    const forked: Capture[] = [];
    const forking = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(forked, async function* () {
        // Provider 返回了另一个会话 id（例如 fork）：必须重新声明线程，否则 loop 会一直指向旧 id。
        yield initMessage("session-different");
        yield resultMessage("session-different");
      }),
    });
    const forkedEvents = await collect(forking.stream(explorerRequest({ providerThreadId: "session-existing" })));
    expect(forkedEvents[0]).toMatchObject({ type: "thread.started", threadId: "session-different" });
  });

  it("records an endpoint fingerprint from config and from what the provider reports", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      baseUrl: "http://127.0.0.1:15721/some/path?token=do-not-record",
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId, { claude_code_version: "2.1.283", apiKeySource: "none" });
        yield resultMessage(sessionId);
      }),
    });

    // 流起来之前只知道配置那一半：端点记 host（不含路径与查询串）、来源记 config、CLI 版本还没有。
    expect(gateway.describeEndpoint()).toEqual({
      backend: "claude-agent-sdk",
      endpoint: "127.0.0.1:15721",
      source: "config",
      cliVersion: null,
      credentialSource: null,
      providerModel: null,
    });

    const events = await collect(gateway.stream(explorerRequest()));

    // init 到达后另一半补齐：CLI 自报的版本、凭据来源与实际模型名，随 thread.started 一起进 Run 记录。
    expect(events[0]).toMatchObject({
      type: "thread.started",
      endpoint: { backend: "claude-agent-sdk", endpoint: "127.0.0.1:15721", source: "config", cliVersion: "2.1.283", credentialSource: "none", providerModel: "claude-opus-5" },
    });
    expect(gateway.describeEndpoint()).toMatchObject({ cliVersion: "2.1.283", credentialSource: "none", providerModel: "claude-opus-5" });
  });

  it("leaves the endpoint null when the CLI resolves it from its own settings", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId, { claude_code_version: "2.1.283", apiKeySource: "ANTHROPIC_API_KEY" });
        yield resultMessage(sessionId);
      }),
    });

    // 没有 baseUrl：端点由 ~/.claude/settings.json（cc-switch 那一层）解析。
    // 指纹必须如实记成 null + provider-settings，而不是把"未配置"美化成某个默认端点。
    expect(gateway.describeEndpoint()).toMatchObject({ endpoint: null, source: "provider-settings", cliVersion: null });
    const events = await collect(gateway.stream(explorerRequest()));
    expect(events[0]).toMatchObject({ endpoint: { endpoint: null, source: "provider-settings", cliVersion: "2.1.283", credentialSource: "ANTHROPIC_API_KEY" } });
  });

  it("reports a provider-side failure instead of finishing with an empty answer", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* () {
        yield initMessage("session-failed");
        yield message({ type: "assistant", session_id: "session-failed", uuid: "uuid-error", error: "authentication_failed", message: { role: "assistant", content: [] } });
        yield resultMessage("session-failed", { is_error: true, result: "Not logged in · Please run /login" });
      }),
    });

    const events = await collect(gateway.stream(explorerRequest()));

    expect(events).toContainEqual({ type: "turn.failed", error: "Claude Agent SDK assistant error: authentication_failed" });
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("cancels the turn when the loop aborts", async () => {
    const captures: Capture[] = [];
    const controller = new AbortController();
    const events: ModelEvent[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      // 真实 SDK 在 abort 时让消息迭代器以 AbortError 结束，这里照同样的语义复现：
      // 让 fake 假装"还在等模型"，abort 后抛错而不是继续把结果消息吐完。
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId);
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => undefined, 500);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        yield resultMessage(sessionId);
      }),
    });

    const consume = (async () => { for await (const event of gateway.stream(explorerRequest({ signal: controller.signal }))) events.push(event); })();
    await waitFor(() => events.some((event) => event.type === "thread.started"));
    controller.abort();
    await consume;

    expect(events.at(-1)).toEqual({ type: "turn.cancelled" });
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("strips inherited provider env and applies explicit overrides", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      baseUrl: "http://127.0.0.1:15721",
      authToken: "token-from-config",
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) {
        yield initMessage(sessionId);
        yield resultMessage(sessionId);
      }),
    });

    await collect(gateway.stream(explorerRequest()));

    const env = captures[0]?.options.env ?? {};
    // 父会话标记与 ANTHROPIC_* 都必须被剥掉：留着父会话标记会让子进程以为凭据由宿主注入，
    // 于是不去读 ~/.claude/settings.json（实测会报 "Not logged in"）。
    expect(env).not.toHaveProperty("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:15721");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("token-from-config");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("pipeline-factory/4.0.0");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("passes the configured model, effort and resume through to the SDK", async () => {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles: { explorer: { model: "claude-opus-5", reasoningEffort: "ultra" }, executor: { model: "claude-opus-5" } },
      maxTurns: 7,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* () {
        yield initMessage("session-model");
        yield resultMessage("session-model");
      }),
    });

    await collect(gateway.stream(explorerRequest()));

    expect(captures[0]?.options.model).toBe("claude-opus-5");
    expect(captures[0]?.options.maxTurns).toBe(7);
    expect(captures[0]?.options.includePartialMessages).toBe(true);
    // "ultra" 不是 SDK 认识的取值：不传，而不是映射成别的取值。
    expect(captures[0]?.options.effort).toBeUndefined();
  });
});

/**
 * 这一组钉的是**数据层曾经丢掉的东西**：推理整块没读、工具载荷没进事件、
 * 标签放在 title 位；以及二十几个 `system` 子类型里那几类值得往上传的运行事实。
 */
describe("Claude 侧的数据层：读什么、为什么读", () => {
  async function run(script: (sessionId: string) => AsyncIterable<SDKMessage>): Promise<ModelEvent[]> {
    const captures: Capture[] = [];
    const gateway = new ClaudeAgentSdkGateway({
      roles,
      sessionExists: async () => true,
      queryFactory: createFactory(captures, async function* ({ sessionId }) { yield* script(sessionId); }),
    });
    return await collect(gateway.stream(explorerRequest()));
  }

  it("**读 `thinking` 块** —— 此前整块被丢掉，Claude 侧的推理在界面上从来不存在", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "assistant", session_id: sessionId, uuid: "uuid-think", message: { role: "assistant", content: [{ type: "thinking", thinking: "先看订单与退款的耦合点。", signature: "sig" }] } });
      yield resultMessage(sessionId);
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "provider.activity", activityKind: "reasoning", outcome: "not-applicable", itemType: "thinking", summary: "先看订单与退款的耦合点。" }));
  });

  it("安全脱敏过的思考留下一条**看得见的事实**，而不是静默消失", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "assistant", session_id: sessionId, uuid: "uuid-redacted", message: { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] } });
      yield resultMessage(sessionId);
    });

    expect(events).toContainEqual(expect.objectContaining({ activityKind: "reasoning", itemId: "uuid-redacted:redacted:0" }));
  });

  it("一条空思考不留行（没有内容就没有可说的）", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "assistant", session_id: sessionId, uuid: "uuid-empty", message: { role: "assistant", content: [{ type: "thinking", thinking: "   " }] } });
      yield resultMessage(sessionId);
    });

    expect(events.some((event) => event.type === "provider.activity" && event.activityKind === "reasoning")).toBe(false);
  });

  it("工具调用的**参数与返回**各有各的字段，不再揉成一行摘要", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield assistantToolUse(sessionId, "tool-1", "Bash", { command: "pnpm test" });
      yield toolResult(sessionId, "tool-1", "3 passed");
      yield resultMessage(sessionId);
    });

    const started = events.find((event) => event.type === "provider.activity" && event.phase === "started");
    const completed = events.find((event) => event.type === "provider.activity" && event.phase === "completed");
    expect(started).toMatchObject({ type: "provider.activity", arguments: { command: "pnpm test" } });
    expect(completed).toMatchObject({ type: "provider.activity", status: "succeeded" });
    // `summary` 仍是一行的可读摘要（紧凑的动作行要它），`result` 是完整返回（展开后的详情要它）。
    expect(completed && "result" in completed ? completed.result : undefined).toEqual([{ type: "text", text: "3 passed" }]);
  });

  it("压缩边界带上 token 数 —— 与 OpenClaw 那条分隔线写的是同一件事", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "system", subtype: "compact_boundary", session_id: sessionId, uuid: "uuid-compact", compact_metadata: { trigger: "auto", pre_tokens: 120_000, post_tokens: 8_000, duration_ms: 900 } });
      yield resultMessage(sessionId);
    });

    expect(events).toContainEqual(expect.objectContaining({ type: "provider.activity", activityKind: "compaction", itemType: "compact_boundary", summary: "Provider 自动压缩了上下文：120000 → 8000 tokens。", durationMs: 900 }));
  });

  it("重试 / 权限被拒 / 配额 / 子任务 / 钩子 / 警告各归自己的类别", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "system", subtype: "api_retry", session_id: sessionId, uuid: "uuid-retry", attempt: 2, max_retries: 5, retry_delay_ms: 4_000, error_status: 529, error: "overloaded" });
      yield message({ type: "system", subtype: "permission_denied", session_id: sessionId, uuid: "uuid-perm", tool_name: "Bash", tool_use_id: "tool-2", message: "策略拒绝写入仓库之外的路径。" });
      yield message({ type: "rate_limit_event", session_id: sessionId, uuid: "uuid-rate", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } });
      yield message({ type: "system", subtype: "task_started", session_id: sessionId, uuid: "uuid-task", task_id: "task-1", tool_use_id: "tool-3", description: "扫描依赖", subagent_type: "Explore" });
      yield message({ type: "system", subtype: "task_notification", session_id: sessionId, uuid: "uuid-task-done", task_id: "task-1", tool_use_id: "tool-3", status: "completed", output_file: "/tmp/out", summary: "扫完了" });
      yield message({ type: "system", subtype: "hook_response", session_id: sessionId, uuid: "uuid-hook", hook_id: "hook-1", hook_name: "lint", hook_event: "PostToolUse", output: "ok", stdout: "ok", stderr: "", exit_code: 0, outcome: "success" });
      yield message({ type: "system", subtype: "informational", session_id: sessionId, uuid: "uuid-info", level: "warning", content: "配置里有一个不认识的键。" });
      yield resultMessage(sessionId);
    });

    const kinds = events.flatMap((event) => event.type === "provider.activity" ? [event.activityKind] : []);
    expect(kinds).toEqual(["retry", "permission", "rate-limit", "task", "task", "hook", "warning"]);
    // 被拒是一次**明确的失败**，不是"状态未知"。
    expect(events).toContainEqual(expect.objectContaining({ activityKind: "permission", status: "denied" }));
    expect(events).toContainEqual(expect.objectContaining({ activityKind: "permission", outcome: "failed" }));
    // 常态噪音不上传：`level: "info"` 的那一类一律不发。
    expect(events.some((event) => event.type === "provider.activity" && event.itemType === "informational" && event.summary === "info")).toBe(false);
  });

  it("每轮都来的 `allowed` 配额与 `info` 提示不上传（「常态收进诊断区」说的是记录，不是每次都浮现）", async () => {
    const events = await run(async function* (sessionId) {
      yield initMessage(sessionId);
      yield message({ type: "rate_limit_event", session_id: sessionId, uuid: "uuid-rate-ok", rate_limit_info: { status: "allowed" } });
      yield message({ type: "system", subtype: "informational", session_id: sessionId, uuid: "uuid-info-ok", level: "info", content: "你好" });
      yield resultMessage(sessionId);
    });

    expect(events.some((event) => event.type === "provider.activity" && (event.activityKind === "rate-limit" || event.activityKind === "warning"))).toBe(false);
  });
});
