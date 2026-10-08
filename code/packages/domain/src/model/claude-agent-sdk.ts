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

import {
  getSessionInfo,
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EXPLORER_PLAN_INSTRUCTIONS } from "../platform/plan-requirements.js";
import { replayConversation, resolveModelMode } from "./provider-session.js";
import { classifyClaudeActivity, type ProviderActivityKind } from "./provider-activity.js";
import { normalizeModelUsage } from "./usage.js";
import type { ModelInputAnswers, ModelInputQuestion, ModelInputRequest } from "../explorer/types.js";
import type {
  ModelCapabilities,
  ModelEvent,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelMode,
  ModelRole,
  ModelRoleConfig,
  ProviderEndpoint,
} from "./types.js";

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
    this.queryFactory =
      options.queryFactory ??
      (async ({ prompt, options: queryOptions }) => {
        const handle = query({ prompt, options: queryOptions });
        return { stream: () => handle, interrupt: () => handle.interrupt() };
      });
    this.sessionExists = options.sessionExists ?? (async (sessionId, cwd) => (await getSessionInfo(sessionId, { dir: cwd })) !== undefined);
  }

  configFor(role: ModelRole): ModelRoleConfig {
    return this.options.roles[role];
  }

  capabilities(role: ModelRole): ModelCapabilities {
    // 结构化提问只有 Explorer 有回传通道（见维护提示 3）；工具循环归 Claude 引擎自己管，
    // 与 Codex 一样只支持 provider-controlled，能力不足时不静默降级成 factory-controlled。
    return { supportsStructuredUserInput: role === "explorer", supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  /** 端点指纹：配置里写到哪一层，加上 init 消息自报的 CLI 版本/凭据来源/模型名。 */
  describeEndpoint(): ProviderEndpoint {
    return endpointOf(this.options.baseUrl, this.reported);
  }

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
        // 会话重建没有成败概念 → activityKind: "session"，outcome 由分类器判为 not-applicable（UI 不显示状态）。
        events.push({
          type: "provider.activity",
          phase: "completed",
          itemId: resume.sessionId ?? "provider-session",
          itemType: "providerSession",
          ...classifyClaudeActivity({ itemType: "providerSession", phase: "completed" }),
          title: "Provider session rebuilt",
          summary: "The previous provider session was no longer on disk; the local transcript was replayed into a new one.",
          providerItemId: resume.sessionId ?? "provider-session",
        });
      }
      const prompt = resume.rebuilt
        ? replayConversation(request.messages)
        : (request.continuationPrompt ?? latestUserMessage(request.messages));
      const handle = await this.queryFactory({
        prompt,
        options: this.buildOptions(request, roleConfig, mode, controller, conversationId, cwd, resume, events, stderrTail),
      });
      this.activeTurns.set(conversationId, { handle, controller });
      // tool_use 带工具名、tool_result 不带。这张表让两者归到**同一个类别**、并让合并后的标题保持
      // 工具名而不是退化成 toolUseId。**每轮一张**（不是实例级）：随流结束一起释放，不跨轮泄漏。
      const toolCalls = new Map<string, string>();
      for await (const message of handle.stream()) {
        for (const event of mapMessage(message, {
          role: request.role,
          resumedSessionId: resume.rebuilt ? undefined : resume.sessionId,
          conversationId,
          sessionIds: this.sessionIds,
          reported: this.reported,
          toolCalls,
          endpoint: () => this.describeEndpoint(),
        }))
          events.push(event);
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
      stderr: (data: string) => {
        pushBounded(stderrTail, data.trim());
      },
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
        return {
          behavior: "deny",
          message: `${toolName} would access ${options.blockedPath}, which is outside this session's working directory.`,
        };
      }
      if (toolName !== "AskUserQuestion") return { behavior: "allow" };
      if (request.role !== "explorer") {
        return {
          behavior: "deny",
          message: "Structured questions are not available in this session; continue with the information you already have.",
        };
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
      // "用户离开后自动继续"由 CLI 自己处理，宿主拿不到这个时长——这也是它当初在 Claude 侧
      // 只能硬编码 null 的原因（字段本身已在 2026-10-07 清掉，见 explorer/types.ts）。
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
  /** 本轮 toolUseId → 工具名；让 tool_result 能与它的 tool_use 归到同一类别（见 stream() 里的说明）。 */
  toolCalls: Map<string, string>;
  reported: ReportedEndpoint;
  endpoint: () => ProviderEndpoint;
};

/**
 * 把 SDK 的一条消息映射成 0..n 个 ModelEvent；未知消息安全忽略而不伪造模型输出。
 *
 * **读哪些、为什么不读其余**（SDK 的 `SDKMessage` 有 39 个成员，这里只认其中的一部分）：
 *   - `assistant` 里的 `text` 块**不读**：正文由 `stream_event` 的 `text_delta` 累积，
 *     同一个字节流读两遍会在时间线上出现两遍。
 *   - `assistant` 里的 `thinking` 块**读**（见下）。
 *   - `stream_event` 的 `thinking_delta` 不单独读：与正文同理，accumulate 在整块上更省事，
 *     而且 Codex 那边推理也只有"整条 item"一种形态，两边行为因此一致。
 *   - `type: "system"` 下面二十几个 `subtype` 大多落进 ④「跑模型的程序报的」，见 `systemRuntimeFact()`。
 */
function* mapMessage(message: SDKMessage, context: MapContext): Generator<ModelEvent> {
  if (message.type === "system") {
    if (message.subtype === "init") {
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
    const runtime = systemRuntimeFact(message);
    if (runtime) yield runtime;
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
    let blockIndex = 0;
    for (const block of message.message.content) {
      const index = blockIndex++;
      if (block.type === "tool_use") {
        context.toolCalls.set(block.id, block.name);
        // `input` 是这次调用的**结构化参数**（文件路径、命令原文、查询串…）。此前它只被揉成一行
        // 摘要塞进 title，界面上"这次调用到底传了什么"没有原料。原样落库，展示时脱敏+截断。
        yield {
          type: "provider.activity",
          phase: "started",
          itemId: block.id,
          itemType: "tool_use",
          ...classifyClaudeActivity({ itemType: "tool_use", phase: "started", status: "started", toolName: block.name }),
          title: block.name,
          summary: summarizeToolInput(block.name, block.input as JsonObject),
          arguments: block.input,
          toolName: block.name,
          status: "started",
          providerItemId: block.id,
          providerThreadId: message.session_id,
        };
        continue;
      }
      // **推理（②）**：`thinking` 块此前整块被丢掉——全仓 `grep thinking` 在 domain/web 的 src 里
      // 0 命中，所以 Claude 侧的推理在界面上从来不存在（Codex 侧有）。它没有 id，用"哪条消息的第几块"
      // 造一个稳定身份键；标题留空让呈现层退回"推理"标签，正文就是思考原文。
      if (block.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
        if (!text) continue;
        yield reasoningActivity(`${message.uuid}:thinking:${index}`, text, message.session_id);
        continue;
      }
      // 安全脱敏过的思考：内容不可读，但"这里有一段看不见的推理"是可说的事实。
      if (block.type === "redacted_thinking") {
        yield reasoningActivity(`${message.uuid}:redacted:${index}`, "这段思考被 Provider 安全脱敏，内容不可读。", message.session_id);
      }
    }
    return;
  }
  if (message.type === "user") {
    for (const block of readToolResults(message.message.content)) {
      // 工具名在这一侧拿不到（SDK 的 tool_result 只有 toolUseId），从本轮的表里取回来：
      // 标题用工具名而不是 toolUseId，类别也与它的 tool_use 保持一致。
      const toolName = context.toolCalls.get(block.toolUseId);
      context.toolCalls.delete(block.toolUseId);
      const status = block.isError ? "failed" : "succeeded";
      const error = block.isError ? (block.summary ?? "Tool call failed") : undefined;
      // `summary` 是**一行的可读摘要**（两个 Provider 同义），`result` 是**完整返回**。
      // 两者都留：前者给紧凑的动作行，后者给展开后的详情。此前只有前者，于是"结果"没有原料。
      yield {
        type: "provider.activity",
        phase: "completed",
        itemId: block.toolUseId,
        itemType: "tool_result",
        ...classifyClaudeActivity({
          itemType: "tool_result",
          phase: "completed",
          status,
          ...(toolName === undefined ? {} : { toolName }),
          ...(error === undefined ? {} : { error }),
        }),
        title: toolName ?? block.toolUseId,
        summary: block.summary,
        result: block.result,
        status,
        ...(toolName === undefined ? {} : { toolName }),
        ...(error === undefined ? {} : { error }),
        providerItemId: block.toolUseId,
        providerThreadId: message.session_id,
      };
    }
    return;
  }
  // 限流与鉴权是顶层 type（不在 `system` 下面），同一个处置。
  if (message.type === "rate_limit_event") {
    const info = message.rate_limit_info;
    // `allowed` 是常态，每轮都来——记下来只是噪音。"常态收进诊断区"指的是**记录**，
    // 不是**每次都浮现**：这里只送值得看一眼的两档。
    if (info.status === "allowed") return;
    const rejected = info.status === "rejected";
    yield runtimeActivity(
      {
        id: `rate-limit:${message.uuid}`,
        itemType: "rate_limit",
        kind: "rate-limit",
        title: rejected ? "配额已用尽" : "配额接近上限",
        summary:
          [
            info.rateLimitType ? `窗口 ${info.rateLimitType}` : null,
            info.utilization === undefined ? null : `已用 ${Math.round(info.utilization * 100)}%`,
            info.resetsAt === undefined ? null : `重置于 ${new Date(info.resetsAt * 1000).toLocaleString("zh-CN")}`,
          ]
            .filter(Boolean)
            .join(" · ") || "Provider 上报了配额状态。",
        status: "warning",
      },
      message.session_id,
    );
    return;
  }
  if (message.type === "auth_status") {
    if (!message.error) return;
    yield runtimeActivity(
      { id: `auth:${message.uuid}`, itemType: "auth_status", kind: "warning", title: "鉴权异常", summary: message.error, status: "failed" },
      message.session_id,
    );
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

/** 一段推理。它是 ②「模型说的」，但**不是对你说的话**——呈现层据此给它更淡的一档。 */
function reasoningActivity(itemId: string, text: string, sessionId: string): ModelEvent {
  return {
    type: "provider.activity",
    phase: "completed",
    itemId,
    itemType: "thinking",
    ...classifyClaudeActivity({ itemType: "thinking", phase: "completed" }),
    title: null,
    summary: text,
    providerItemId: itemId,
    providerThreadId: sessionId,
  };
}

/** 一条 ④「跑模型的程序报的」运行事实（不是模型做的，也不是你说的）。形态与 item 那条一致。 */
function runtimeActivity(
  input: {
    id: string;
    itemType: string;
    kind: ProviderActivityKind;
    title: string;
    summary: string;
    status?: string;
    error?: string;
    durationMs?: number;
  },
  sessionId: string | undefined,
): ModelEvent {
  const classification = classifyClaudeActivity({
    itemType: input.itemType,
    phase: "completed",
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.error === undefined ? {} : { error: input.error }),
  });
  return {
    type: "provider.activity",
    phase: "completed",
    itemId: input.id,
    itemType: input.itemType,
    ...classification,
    title: input.title,
    summary: input.summary,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.status ? { status: input.status } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(sessionId ? { providerThreadId: sessionId } : {}),
    providerItemId: input.id,
  };
}

/**
 * `type: "system"` 下面那二十几个 `subtype` 里，哪些值得往上传。
 *
 * 判据是"用户会不会因为看到它而改变动作"：压缩（这次对话的成本基线变了）、重试（不是我卡住，
 * 是它在等）、权限被拒（我得去改策略）、后台子任务（还有东西在跑）、钩子（工厂配的那段脚本
 * 跑了/挂了）、命令级告警（配置写错了）。**其余一律不传**——`status` / `files_persisted` /
 * `memory_recall` / `elicitation_complete` / `commands_changed` / `worker_shutting_down` 这些
 * 每次都要来，传上去只是噪音。
 */
function systemRuntimeFact(message: SDKMessage & { type: "system"; session_id?: string }): ModelEvent | null {
  const sessionId = typeof message.session_id === "string" ? message.session_id : undefined;
  const subtype = (message as { subtype?: string }).subtype;
  switch (subtype) {
    case "compact_boundary": {
      const meta = (
        message as unknown as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number; duration_ms?: number } }
      ).compact_metadata;
      const before = meta?.pre_tokens;
      const after = meta?.post_tokens;
      const size = before === undefined ? null : after === undefined ? `压缩前 ${before} tokens` : `${before} → ${after} tokens`;
      return runtimeActivity(
        {
          id: `compaction:${(message as unknown as { uuid?: string }).uuid ?? String(before ?? "")}`,
          itemType: "compact_boundary",
          kind: "compaction",
          title: "上下文已压缩",
          // `pre_tokens → post_tokens` 是 OpenClaw 那条压缩分隔线上写的同一件事：
          // "上下文在这里变小了"。拿不到 token 数就只说压缩发生了，不编一个数字。
          summary: `Provider ${meta?.trigger === "manual" ? "手动" : "自动"}压缩了上下文${size ? `：${size}` : ""}。`,
          ...(typeof meta?.duration_ms === "number" ? { durationMs: meta.duration_ms } : {}),
        },
        sessionId,
      );
    }
    case "api_retry": {
      const m = message as unknown as {
        attempt?: number;
        max_retries?: number;
        retry_delay_ms?: number;
        error?: string;
        error_status?: number | null;
      };
      return runtimeActivity(
        {
          id: `retry:${sessionId ?? ""}:${m.attempt ?? 0}:${m.error_status ?? ""}`,
          itemType: "api_retry",
          kind: "retry",
          title: "正在自动重试",
          summary:
            [
              `第 ${m.attempt ?? "?"}/${m.max_retries ?? "?"} 次`,
              typeof m.retry_delay_ms === "number" ? `${Math.round(m.retry_delay_ms / 1000)} 秒后重试` : null,
              m.error ? `原因 ${m.error}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Provider 正在自动重试。",
          status: "warning",
        },
        sessionId,
      );
    }
    case "permission_denied": {
      const m = message as unknown as { tool_name?: string; message?: string; decision_reason?: string };
      return runtimeActivity(
        {
          id: `permission:${(message as unknown as { uuid?: string }).uuid ?? m.tool_name ?? "denied"}`,
          itemType: "permission_denied",
          kind: "permission",
          title: `权限被拒 · ${m.tool_name ?? "工具"}`,
          summary: m.message ?? m.decision_reason ?? "这一次工具调用被权限策略拒绝。",
          status: "denied",
        },
        sessionId,
      );
    }
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification": {
      const m = message as unknown as {
        task_id?: string;
        tool_use_id?: string;
        description?: string;
        summary?: string;
        status?: string;
        subagent_type?: string;
        patch?: { status?: string; description?: string; error?: string };
        usage?: { duration_ms?: number };
      };
      const id = m.tool_use_id ?? m.task_id ?? "task";
      const status = m.status ?? m.patch?.status;
      const label = m.description ?? m.patch?.description ?? m.summary ?? "后台子任务";
      return runtimeActivity(
        {
          id: `task:${id}`,
          itemType: `task_${subtype.slice(5)}`,
          kind: "task",
          title: `子任务 · ${label}`,
          summary:
            [m.subagent_type ? `类型 ${m.subagent_type}` : null, status ? `状态 ${status}` : null, m.patch?.error ?? null]
              .filter(Boolean)
              .join(" · ") || "后台子任务有更新。",
          ...(status ? { status } : {}),
          ...(typeof m.usage?.duration_ms === "number" ? { durationMs: m.usage.duration_ms } : {}),
        },
        sessionId,
      );
    }
    case "background_tasks_changed": {
      const m = message as unknown as { tasks?: Array<{ task_id: string; description: string }> };
      const count = m.tasks?.length ?? 0;
      return runtimeActivity(
        {
          id: `background-tasks:${sessionId ?? ""}`,
          itemType: "background_tasks_changed",
          kind: "task",
          title: "后台任务已变化",
          summary: count > 0 ? `${count} 个后台任务在跑：${m.tasks?.map((t) => t.description).join(" · ")}` : "当前没有后台任务。",
        },
        sessionId,
      );
    }
    case "hook_started":
    case "hook_progress":
    case "hook_response": {
      const m = message as unknown as {
        hook_id?: string;
        hook_name?: string;
        hook_event?: string;
        output?: string;
        exit_code?: number;
        outcome?: string;
      };
      const name = m.hook_name ?? m.hook_event ?? "hook";
      const failed = m.outcome === "error" || (m.exit_code !== undefined && m.exit_code !== 0);
      return runtimeActivity(
        {
          id: `hook:${m.hook_id ?? name}`,
          itemType: `hook_${subtype.slice(5)}`,
          kind: "hook",
          title: `钩子 · ${name}`,
          summary: m.output?.trim() || (subtype === "hook_started" ? "钩子开始执行。" : "钩子执行结束。"),
          status: subtype === "hook_started" ? "started" : failed ? "failed" : "succeeded",
          ...(failed ? { error: m.output?.trim() || `钩子以退出码 ${m.exit_code} 结束。` } : {}),
        },
        sessionId,
      );
    }
    case "informational": {
      const m = message as unknown as { content?: string; level?: string };
      // `info` / `notice` / `suggestion` 每轮都有，只有 `warning` 值得往上传。
      if (m.level !== "warning") return null;
      return runtimeActivity(
        {
          id: `informational:${(message as unknown as { uuid?: string }).uuid ?? ""}`,
          itemType: "informational",
          kind: "warning",
          title: "Provider 警告",
          summary: m.content || "Provider 报告了一条警告。",
          status: "warning",
        },
        sessionId,
      );
    }
    default:
      return null;
  }
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

/** reasoningEffort 只透传 SDK 认识的取值，不认识就不传（不映射成别的取值）。 */
function asEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}

function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? messages.at(-1)?.content ?? "Continue.";
}

function systemInstructions(messages: ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

/** 读取 AskUserQuestion 的输入；形状见 Claude Code 的 AskUserQuestionInput（1-4 题、每题 2-4 选项）。 */
function readQuestions(input: JsonObject): ProviderQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const value = question as JsonObject;
    const text = typeof value.question === "string" ? value.question.trim() : "";
    if (!text) return [];
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!option || typeof option !== "object") return [];
          const item = option as JsonObject;
          const label = typeof item.label === "string" ? item.label : "";
          if (!label) return [];
          return [{ label, description: typeof item.description === "string" ? item.description : "" }];
        })
      : [];
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

/**
 * 读出这一条 `tool_result`。
 * - `summary` 是**一行的可读摘要**（截断到 200 字），给紧凑的动作行用；
 * - `result` 是**完整返回**，给展开后的详情用。
 * 两者都留：此前只有前者，于是"这次调用结果是什么"在界面上没有原料。
 * 落库保留原样，**脱敏与截断发生在展示边界**（`apps/web/src/utils/sensitiveValue.ts`）。
 */
function readToolResults(content: unknown): Array<{ toolUseId: string; summary: string | null; result: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as JsonObject;
    if (value.type !== "tool_result" || typeof value.tool_use_id !== "string") return [];
    return [
      {
        toolUseId: value.tool_use_id,
        summary: summarizeToolResult(value.content),
        result: value.content,
        isError: value.is_error === true,
      },
    ];
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
  const text = content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as JsonObject).text === "string" ? [(part as JsonObject).text as string] : [],
    )
    .join("\n")
    .trim();
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
