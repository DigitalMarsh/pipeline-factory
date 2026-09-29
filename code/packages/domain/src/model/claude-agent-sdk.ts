/**
 * 模块职责：Claude Agent SDK 的 ModelGateway 适配器 —— 把 ModelRequest 交给
 *   `@anthropic-ai/claude-agent-sdk` 的 query()，再把 SDK 的消息流映射成 ModelEvent。
 *
 * 为什么用官方 SDK 而不是照抄 codex 那条自驱 CLI 的路子：Codex 侧那 600 多行里，协议客户端、
 *   通知订阅队列、重启与超时、pending 请求表占了大半（见 codex-app-server.ts）。Claude 这边
 *   这些正是 SDK 已经拥有并版本化的东西 —— 会话、权限回调、resume、hooks、部分消息流都在
 *   query() 的 Options 里。自己 spawn `claude -p --output-format stream-json` 等于把 SDK 的协议
 *   实现再写一遍，还要自己扛 CLI 版本漂移。两种做法的进程模型相同（都是子进程），差别只在谁维护协议。
 *   本文件因此与 CodexAppServerGateway **同构**：注入式 query 工厂、同样的 ModelEvent 契约。
 *
 * 维护提示：
 *   1) **凭据不由本文件解析**。Options.env 一旦给出就**整体替换**子进程环境（SDK 文档原话：
 *      "this value REPLACES the subprocess environment entirely — it is not merged with process.env"），
 *      所以 buildEnvironment() 先 spread process.env 再叠加改动。这里同时剥掉两类变量：
 *      (a) 父进程是"另一个 Claude Code 会话"的标记（CLAUDECODE / CLAUDE_CODE_ENTRYPOINT /
 *      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 等）—— 带着它们启动的子会话会以为自己由宿主托管，
 *      于是不去读 ~/.claude/settings.json，直接报 "Not logged in"（实测踩过）；
 *      (b) 全部 ANTHROPIC_* —— 与 README "API 不读取环境变量" 一致：模型、端点、令牌一律来自
 *      Factory 配置或 CLI 自己的 settings，不来自父进程环境。
 *      要显式指定端点/令牌，只在 options 里传 baseUrl/authToken（组合根是唯一读取处）。
 *   2) **AskUserQuestion 走 canUseTool（权限回调）**，不是专门的 SDK 选项：sdk.d.ts 里没有任何
 *      AskUserQuestion 类型，而 CLI 内部有 `permission_ask_user_question` 决策分类与
 *      "User answers collected by the permission component" 的输入字段描述。因此答案以
 *      `{behavior:'allow', updatedInput: {...input, answers}}` 回传，answers 的键是**题目原文**、
 *      多选以逗号连接（CLI 的输出契约逐字如此）。toProviderAnswers() 是唯一需要跟着改的地方。
 *   3) **Executor 不给 AskUserQuestion**：它的答案没有回传通道（API 侧只有 explorer-thread 的
 *      input-requests 路由），模型一旦提问就会卡到 loop 的截止时间。capabilities 与工具集两处
 *      都按角色收紧，别只改一处。
 *   4) **沙箱边界是会话 cwd**：Explorer 恒为 plan（只读）并把探索约束交给 planModeInstructions，
 *      Executor 用 acceptEdits 且 cwd 是 Run Worktree。canUseTool 对任何带 blockedPath
 *      （要越出会话目录）的请求一律拒绝 —— 这是本适配器唯一的安全策略，不要放宽成"一律 allow"。
 *   5) 会话丢失（换供应商、清目录、换机器）时用本地 turns 重建：SDK 的会话记录落在
 *      ~/.claude/projects/ 下，所以重建前先用 getSessionInfo 确认它在不在，见 resolveResume()。
 */

import { getSessionInfo, query, type CanUseTool, type Options, type PermissionMode, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EXPLORER_PLAN_INSTRUCTIONS } from "../platform/plan-requirements.js";
import { replayConversation, resolveModelMode } from "./provider-session.js";
import { normalizeModelUsage } from "./usage.js";
import type { ModelInputAnswers, ModelInputQuestion, ModelInputRequest } from "../explorer/types.js";
import type { ModelCapabilities, ModelEvent, ModelGateway, ModelMessage, ModelRequest, ModelMode, ModelRole, ModelRoleConfig, ProviderEndpoint, ProviderUsageSnapshot } from "./types.js";

type JsonObject = Record<string, unknown>;

/** 一次 query() 调用的句柄；Domain 通过它隔离 SDK 版本差异并便于测试注入。 */
export type ClaudeQueryHandle = {
  stream(): AsyncIterable<SDKMessage>;
  interrupt?(): Promise<unknown>;
};

/** 创建一次 Provider 会话的工厂，便于重启和测试注入。 */
export type ClaudeQueryFactory = (input: { prompt: string; options: Options }) => Promise<ClaudeQueryHandle>;

/** Claude Agent SDK Gateway 的运行参数；凭据只从这里进来，不落库。 */
export type ClaudeAgentSdkGatewayOptions = {
  roles: Record<ModelRole, ModelRoleConfig>;
  /** 端点覆盖；缺省时不传 env，由 CLI 自己解析 settings（cc-switch 就作用在这一层）。 */
  baseUrl?: string | undefined;
  authToken?: string | undefined;
  /** 传给 CLI 的 --settings（flag 层设置，优先级高于 user/project/local）。 */
  settingsPath?: string | undefined;
  /** 额外的环境变量覆盖；叠加在 buildEnvironment() 的结果之上。 */
  env?: Record<string, string> | undefined;
  /** 每次 query 的最大回合数；作为 loop 步数上限之外的二级保护。 */
  maxTurns?: number | undefined;
  /** 测试注入；缺省用 SDK 的 query()。 */
  queryFactory?: ClaudeQueryFactory | undefined;
  /** 测试注入；缺省用 SDK 的 getSessionInfo()。返回 false 表示会话记录已不在磁盘上。 */
  sessionExists?: ((sessionId: string, cwd: string) => Promise<boolean>) | undefined;
};

const CLIENT_APP = "pipeline-factory/4.0.0";

/** 父进程若本身是 Claude Code 会话，这些变量会让子会话认为凭据由宿主注入。 */
const NESTED_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
];

/** 每个角色可用的内置工具；按"这一侧到底有没有人接得住"来定，不是按能力清单抄。 */
const ROLE_TOOLS: Record<ModelRole, string[]> = {
  explorer: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Task", "AskUserQuestion"],
  executor: ["Read", "Write", "Edit", "NotebookEdit", "Bash", "Grep", "Glob", "TodoWrite"],
};

/** 每个角色显式禁用的内置工具；plan 审批门与提问在工厂侧另有契约，不交给 CLI 自己走。 */
const ROLE_DISALLOWED_TOOLS: Record<ModelRole, string[]> = {
  explorer: ["ExitPlanMode"],
  executor: ["ExitPlanMode", "AskUserQuestion", "WebFetch", "WebSearch", "Task"],
};

/** Provider 侧本次提问的原始题目：生成 Domain 结构、回译答案、以及 init 状态都用它。 */
type ProviderQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
};

/** 一次待答复的结构化提问；答案由 answerUserInput 送达，取消由 canUseTool 的 signal 送达。 */
type PendingQuestion = {
  resolve: (answers: ModelInputAnswers | null) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

/** 本次 query 要不要续接已有会话，以及是否需要回放本地历史重建。 */
type ResumeContext = {
  sessionId?: string | undefined;
  rebuilt: boolean;
};

/** Provider 在 init 消息里自报的端点事实；这些字段只有会话起来之后才有值。 */
type ReportedEndpoint = {
  cliVersion: string | null;
  credentialSource: string | null;
  providerModel: string | null;
};

/** 把"配置里写了什么"与"Provider 自报了什么"合成端点指纹；两边都不知道的字段留 null。 */
function endpointOf(baseUrl: string | undefined, reported: ReportedEndpoint): ProviderEndpoint {
  return {
    backend: "claude-agent-sdk",
    // 有 baseUrl 才谈得上"Factory 担保端点"；否则端点由 CLI 的 settings 解析（cc-switch 那一层），
    // 这正是要如实记成 null 的情形 —— 见 ProviderEndpoint 的文档。
    endpoint: baseUrl ? hostOf(baseUrl) : null,
    source: baseUrl ? "config" : "provider-settings",
    cliVersion: reported.cliVersion,
    credentialSource: reported.credentialSource,
    providerModel: reported.providerModel,
  };
}

/** 只取 host[:port]：端点指纹用于区分"打到哪台"，不记录路径与查询串（里面可能带令牌）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 把 Claude Agent SDK 的事件流映射成 ModelGateway 事件。 */
export class ClaudeAgentSdkGateway implements ModelGateway {
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly sessionExists: (sessionId: string, cwd: string) => Promise<boolean>;
  private readonly activeTurns = new Map<string, { handle: ClaudeQueryHandle; controller: AbortController }>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** SDK 的 init 消息给出会话 id；缓存下来供结构化提问填 threadId。 */
  private readonly sessionIds = new Map<string, string>();
  /** 端点指纹里只有 Provider 自报的字段需要跨 query 累计（CLI 版本与凭据来源与单次会话无关）。 */
  private readonly reported: ReportedEndpoint = { cliVersion: null, credentialSource: null, providerModel: null };

  constructor(private readonly options: ClaudeAgentSdkGatewayOptions) {
    this.queryFactory = options.queryFactory ?? (async ({ prompt, options: queryOptions }) => {
      const handle = query({ prompt, options: queryOptions });
      return { stream: () => handle, interrupt: () => handle.interrupt() };
    });
    this.sessionExists = options.sessionExists ?? (async (sessionId, cwd) => (await getSessionInfo(sessionId, { dir: cwd })) !== undefined);
  }

  configFor(role: ModelRole): ModelRoleConfig { return this.options.roles[role]; }

  capabilities(role: ModelRole): ModelCapabilities {
    // 结构化提问只有 Explorer 有回传通道（见维护提示 3）；工具循环归 Claude 引擎自己管，
    // 与 Codex 一样只支持 provider-controlled，能力不足时不静默降级成 factory-controlled。
    return { supportsStructuredUserInput: role === "explorer", supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async readRateLimits(): Promise<ProviderUsageSnapshot> {
    // Claude 侧没有账号级额度查询接口（SDK 只有会话内的限流提醒事件）。宁可显式报"取不到"，
    // 也不要按 5 小时/7 天窗口去编一个数字。
    return { available: false, fiveHour: null, sevenDay: null, reason: "Claude Agent SDK does not expose account rate limits" };
  }

  /** 端点指纹：配置里写到哪一层，加上 init 消息自报的 CLI 版本/凭据来源/模型名。 */
  describeEndpoint(): ProviderEndpoint { return endpointOf(this.options.baseUrl, this.reported); }

  async answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void> {
    const pending = this.pendingQuestions.get(String(input.requestId));
    if (!pending) throw new Error(`No active Claude Agent SDK input request ${String(input.requestId)}`);
    this.pendingQuestions.delete(String(input.requestId));
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(input.answers);
  }

  async cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void> {
    const active = this.activeTurns.get(request.conversationId);
    if (!active) return;
    // abortController 是 SDK 文档化的取消手段；interrupt() 只在流式输入模式下可用，作为尽力而为。
    active.controller.abort();
    await active.handle.interrupt?.().catch(() => undefined);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    const roleConfig = { ...this.configFor(request.role), ...(request.modelConfig ?? {}) };
    const mode = resolveModelMode(request, roleConfig);
    const conversationId = request.conversationId ?? request.role;
    const cwd = request.cwd ?? process.cwd();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const events = new ModelEventQueue();
    const stderrTail: string[] = [];

    const consume = (async () => {
      const resume = await this.resolveResume(request, cwd);
      if (resume.rebuilt) {
        // 让时间线上能看出"会话为什么换了"，而不是静默开一条新会话。
        events.push({ type: "provider.activity", phase: "completed", itemId: resume.sessionId ?? "provider-session", itemType: "providerSession", title: "Provider session rebuilt", summary: "The previous provider session was no longer on disk; the local transcript was replayed into a new one.", providerItemId: resume.sessionId ?? "provider-session" });
      }
      const prompt = resume.rebuilt ? replayConversation(request.messages) : (request.continuationPrompt ?? latestUserMessage(request.messages));
      const handle = await this.queryFactory({ prompt, options: this.buildOptions(request, roleConfig, mode, controller, conversationId, cwd, resume, events, stderrTail) });
      this.activeTurns.set(conversationId, { handle, controller });
      for await (const message of handle.stream()) {
        for (const event of mapMessage(message, { role: request.role, resumedSessionId: resume.rebuilt ? undefined : resume.sessionId, conversationId, sessionIds: this.sessionIds, reported: this.reported, endpoint: () => this.describeEndpoint() })) events.push(event);
      }
    })();

    void consume
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) events.push({ type: "turn.cancelled" });
        else events.push({ type: "turn.failed", error: describeFailure(error, stderrTail) });
      })
      .finally(() => {
        this.activeTurns.delete(conversationId);
        request.signal?.removeEventListener("abort", onAbort);
        events.end();
      });

    try {
      for await (const event of events) yield event;
    } finally {
      // 消费方提前 break（loop 取消/超时）时不能留下一个还在跑的 Provider 会话。
      if (!controller.signal.aborted) controller.abort();
      this.activeTurns.delete(conversationId);
      request.signal?.removeEventListener("abort", onAbort);
      events.end();
    }
  }

  /**
   * 决定这次是续接还是重建：会话记录不在磁盘上（换供应商、清目录、换机器）时重建，
   * 并把本地 turns 回放进去（见 provider-session.ts 的 replayConversation）。
   */
  private async resolveResume(request: ModelRequest, cwd: string): Promise<ResumeContext> {
    const sessionId = request.providerThreadId;
    if (!sessionId) return { rebuilt: false };
    // 探测失败（权限/编码问题等）不能把一次正常续接变成重建，所以失败按"还在"处理。
    const exists = await this.sessionExists(sessionId, cwd).catch(() => true);
    return exists ? { rebuilt: false, sessionId } : { rebuilt: true, sessionId };
  }

  private buildOptions(
    request: ModelRequest,
    roleConfig: ModelRoleConfig,
    mode: ModelMode,
    controller: AbortController,
    conversationId: string,
    cwd: string,
    resume: ResumeContext,
    events: ModelEventQueue,
    stderrTail: string[],
  ): Options {
    const systemPromptAppend = [systemInstructions(request.messages), roleConfig.developerInstructions].filter(Boolean).join("\n\n");
    const effort = asEffort(roleConfig.reasoningEffort);
    return {
      cwd,
      model: roleConfig.model,
      tools: ROLE_TOOLS[request.role],
      disallowedTools: ROLE_DISALLOWED_TOOLS[request.role],
      // AskUserQuestion 不进 allowedTools：它必须经 canUseTool 才能拿到答案，白名单会绕过回调。
      allowedTools: ROLE_TOOLS[request.role].filter((tool) => tool !== "AskUserQuestion"),
      permissionMode: permissionModeFor(request.role, mode),
      abortController: controller,
      includePartialMessages: true,
      env: this.buildEnvironment(),
      canUseTool: this.buildCanUseTool(request, conversationId, events),
      stderr: (data: string) => { pushBounded(stderrTail, data.trim()); },
      systemPrompt: { type: "preset", preset: "claude_code", ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
      ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
      ...(this.options.settingsPath ? { settings: this.options.settingsPath } : {}),
      ...(effort ? { effort } : {}),
      // plan 模式下 CLI 会用它替换默认的"写代码"工作流正文，同时保留只读约束与协议外壳：
      // Explorer 的产出契约是 pipeline-factory-plan，不是 Claude 自己的 plan 审批。
      ...(request.role === "explorer" ? { planModeInstructions: EXPLORER_PLAN_INSTRUCTIONS } : {}),
      ...(!resume.rebuilt && resume.sessionId ? { resume: resume.sessionId } : {}),
    };
  }

  /** 构造子进程环境：剥掉父会话标记与 ANTHROPIC_*，再叠加配置里的显式覆盖。 */
  private buildEnvironment(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (NESTED_SESSION_ENV_KEYS.includes(key)) continue;
      if (key.startsWith("ANTHROPIC_")) continue;
      env[key] = value;
    }
    env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP;
    if (this.options.baseUrl) env.ANTHROPIC_BASE_URL = this.options.baseUrl;
    if (this.options.authToken) env.ANTHROPIC_AUTH_TOKEN = this.options.authToken;
    for (const [key, value] of Object.entries(this.options.env ?? {})) env[key] = value;
    return env;
  }

  private buildCanUseTool(request: ModelRequest, conversationId: string, events: ModelEventQueue): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      // 越出会话目录的请求一律拒绝：cwd 就是沙箱边界（Explorer = 仓库根只读，
      // Executor = Run Worktree）。这是本适配器唯一的安全策略。
      if (options.blockedPath) {
        return { behavior: "deny", message: `${toolName} would access ${options.blockedPath}, which is outside this session's working directory.` };
      }
      if (toolName !== "AskUserQuestion") return { behavior: "allow" };
      if (request.role !== "explorer") {
        return { behavior: "deny", message: "Structured questions are not available in this session; continue with the information you already have." };
      }
      const questions = readQuestions(input);
      if (questions.length === 0) return { behavior: "deny", message: "AskUserQuestion was called without usable questions." };
      const answers = await this.awaitAnswers(conversationId, options, events, questions);
      if (!answers) return { behavior: "deny", message: "The question was cancelled before the user answered." };
      return { behavior: "allow", updatedInput: { ...input, answers: toProviderAnswers(answers, questions) } };
    };
  }

  /** 把一次结构化提问挂成待答复的 promise，并把请求推给 Agent Loop。 */
  private async awaitAnswers(
    conversationId: string,
    options: { signal: AbortSignal; requestId: string; toolUseID: string },
    events: ModelEventQueue,
    questions: ProviderQuestion[],
  ): Promise<ModelInputAnswers | null> {
    const requestId = String(options.requestId);
    const inputRequest: ModelInputRequest = {
      requestId,
      threadId: this.sessionIds.get(conversationId) ?? "",
      // Claude 侧一次 query 就是一个 turn，没有独立的 turn id；itemId 用工具调用 id 即可定位。
      turnId: "",
      itemId: options.toolUseID,
      questions: toDomainQuestions(questions),
      isBlocking: true,
      // "用户离开后自动继续"由 CLI 自己处理，宿主拿不到这个时长。
      autoResolutionMs: null,
    };
    events.push({ type: "turn.input_required", request: inputRequest });
    const signal = options.signal;
    return await new Promise<ModelInputAnswers | null>((resolve) => {
      // 取消时 resolve(null) 而不是 reject：调用方据此返回一个正常的 deny 结果，
      // 权限回调抛异常会让 CLI 侧的取消路径多一条没人处理的错误。
      const onAbort = () => {
        if (!this.pendingQuestions.delete(requestId)) return;
        resolve(null);
      };
      this.pendingQuestions.set(requestId, { resolve, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

type MapContext = {
  role: ModelRole;
  resumedSessionId?: string | undefined;
  conversationId: string;
  sessionIds: Map<string, string>;
  reported: ReportedEndpoint;
  endpoint: () => ProviderEndpoint;
};

/** 把 SDK 的一条消息映射成 0..n 个 ModelEvent；未知消息安全忽略而不伪造模型输出。 */
function* mapMessage(message: SDKMessage, context: MapContext): Generator<ModelEvent> {
  if (message.type === "system") {
    if (message.subtype !== "init") return;
    const sessionId = message.session_id;
    context.sessionIds.set(context.conversationId, sessionId);
    // init 是唯一能拿到"端点的另一半"的地方：CLI 自报版本、凭据来源与实际模型名。
    // 只在这里读、不做任何推断 —— 字段缺失就留 null。
    context.reported.cliVersion = typeof message.claude_code_version === "string" ? message.claude_code_version : null;
    context.reported.credentialSource = typeof message.apiKeySource === "string" ? message.apiKeySource : null;
    context.reported.providerModel = typeof message.model === "string" ? message.model : null;
    // 只有新建会话（或 resume 落到了另一个会话）才重新声明线程：否则 loop 会在每轮都覆写一次
    // providerThreadId，看不出会话是真的换了还是照旧。
    if (context.resumedSessionId !== sessionId) yield { type: "thread.started", threadId: sessionId, endpoint: context.endpoint() };
    return;
  }
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
      yield { type: "text.delta", text: event.delta.text, providerThreadId: message.session_id };
    }
    return;
  }
  if (message.type === "assistant") {
    if (message.error) {
      // SDK 把 Provider 侧的鉴权/额度失败标在 assistant 消息上（实测：error="authentication_failed"）；
      // 不处理的话这一轮会以"成功的空回答"结束，错误在现场之外完全不可见。
      yield { type: "turn.failed", error: `Claude Agent SDK assistant error: ${message.error}` };
      return;
    }
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      yield { type: "provider.activity", phase: "started", itemId: block.id, itemType: "tool_use", title: block.name, summary: summarizeToolInput(block.name, block.input as JsonObject), toolName: block.name, status: "started", providerItemId: block.id, providerThreadId: message.session_id };
    }
    return;
  }
  if (message.type === "user") {
    for (const block of readToolResults(message.message.content)) {
      yield { type: "provider.activity", phase: "completed", itemId: block.toolUseId, itemType: "tool_result", title: block.toolUseId, summary: block.summary, status: block.isError ? "failed" : "succeeded", ...(block.isError ? { error: block.summary ?? "Tool call failed" } : {}), providerItemId: block.toolUseId, providerThreadId: message.session_id };
    }
    return;
  }
  if (message.type !== "result") return;
  const usage = normalizeModelUsage(message.usage);
  if (usage) yield { type: "model.usage", usage, scope: "turn", providerThreadId: message.session_id };
  if (message.subtype !== "success") {
    // 错误子类型把原因放在 errors 数组里（成功子类型才有 result 字符串）。
    const detail = message.errors.join("; ").trim() || message.subtype;
    yield { type: "turn.failed", error: detail };
    return;
  }
  // 实测：Provider 侧鉴权失败时 subtype 仍是 "success"，只有 is_error 为 true、result 带错误文案。
  if (message.is_error) {
    const detail = message.result.trim() || "Claude Agent SDK reported an error without a message";
    yield { type: "turn.failed", error: detail };
    return;
  }
  yield { type: "turn.completed" };
}

/** 本适配器内部的事件队列；把回调式事件（canUseTool）与生成器式事件合到一条流上。 */
class ModelEventQueue implements AsyncIterable<ModelEvent> {
  private readonly queue: ModelEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ModelEvent>) => void> = [];
  private ended = false;

  push(event: ModelEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<ModelEvent>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Explorer 恒为 plan（只读）；Executor 在会话目录内自动接受编辑，mode 只用于把 Executor 收紧到 plan。 */
function permissionModeFor(role: ModelRole, mode: ModelMode): PermissionMode {
  if (role === "explorer" || mode === "plan") return "plan";
  return "acceptEdits";
}

/** reasoningEffort 只透传 SDK 认识的档位，不认识就不传（不映射成别的档位）。 */
function asEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}

function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? messages.at(-1)?.content ?? "Continue.";
}

function systemInstructions(messages: ModelMessage[]): string {
  return messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}

/** 读取 AskUserQuestion 的输入；形状见 Claude Code 的 AskUserQuestionInput（1-4 题、每题 2-4 选项）。 */
function readQuestions(input: JsonObject): ProviderQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const value = question as JsonObject;
    const text = typeof value.question === "string" ? value.question.trim() : "";
    if (!text) return [];
    const options = Array.isArray(value.options) ? value.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const item = option as JsonObject;
      const label = typeof item.label === "string" ? item.label : "";
      if (!label) return [];
      return [{ label, description: typeof item.description === "string" ? item.description : "" }];
    }) : [];
    return [{ question: text, header: typeof value.header === "string" ? value.header : "", options }];
  });
}

/** 把 Provider 的题目映射成 Domain 结构；id 用序号，回译时按序号取回题目原文。 */
function toDomainQuestions(questions: ProviderQuestion[]): ModelInputQuestion[] {
  return questions.map((question, index) => ({
    id: String(index),
    header: question.header,
    question: question.question,
    // Claude Code 的 AskUserQuestion 会自动补一个"其他"选项，且没有 Codex 那套 secret 语义。
    isOther: true,
    isSecret: false,
    options: question.options.length > 0 ? question.options : null,
  }));
}

/** 把 Domain 的答案回译成 CLI 期望的 `{题目原文: 答案}`；多选以逗号连接。 */
function toProviderAnswers(answers: ModelInputAnswers, questions: ProviderQuestion[]): Record<string, string> {
  const mapped: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = answers[String(index)];
    if (!answer) return;
    const value = answer.answers.filter((item) => item && item.trim()).join(", ");
    if (value) mapped[question.question] = value;
  });
  return mapped;
}

function readToolResults(content: unknown): Array<{ toolUseId: string; summary: string | null; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as JsonObject;
    if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") return [];
    return [{ toolUseId: value.tool_use_id, summary: summarizeToolResult(value.content), isError: value.is_error === true }];
  });
}

function summarizeToolInput(toolName: string, input: JsonObject): string | null {
  for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `${toolName}: ${value.trim().slice(0, 200)}`;
  }
  return null;
}

function summarizeToolResult(content: unknown): string | null {
  if (typeof content === "string") return content.trim().slice(0, 200) || null;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((part) => part && typeof part === "object" && typeof (part as JsonObject).text === "string" ? [(part as JsonObject).text as string] : []).join("\n").trim();
  return text ? text.slice(0, 200) : null;
}

function pushBounded(buffer: string[], line: string): void {
  if (!line) return;
  buffer.push(line);
  while (buffer.length > 5) buffer.shift();
}

function describeFailure(error: unknown, stderrTail: string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = stderrTail.join("\n").trim();
  // SDK 抛出的多是通用文案；子进程 stderr 往往才是"为什么"（鉴权、代理不可达等）。
  return stderr && !message.includes(stderr) ? `${message} (stderr: ${stderr})` : message;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}
