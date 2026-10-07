/**
 * 模块职责：模型层的公共契约 —— 角色与角色配置、Provider 能力声明、工具描述与消息，
 *   以及 ModelGateway 端口本身和它的输出事件 ModelEvent。
 *
 * 为什么从 index.ts 抽出来（批 E）：ModelGateway 是"换一个模型后端"的唯一集成点，
 *   而它的契约与四个实现（model/codex-app-server.ts、model/claude-agent-sdk.ts、
 *   model/gateway-openai.ts、model/stub-gateway.ts）此前分散在 index.ts 与 model/ 两处。
 *   搬到一起后，"接口要求什么、各实现给到什么"可以在同一目录里逐个对照。
 *
 * 维护提示：
 *   1) **ModelEvent 的每一种都是 Agent Loop 的输入，增删即改状态机。** 新增一种事件要同时
 *      检查两处：agent/agent-loop.ts 的事件分派，以及 run/dispatch-coordinator.ts 的
 *      isStreamingEvent —— 后者把 `agent.*` 前缀与 `run.executor.event`（payload.type 为
 *      MODEL_OUTPUT）判为**高频流式事件**，只做防抖唤醒、不走逐条 handleEvent。
 *      一种新的高频事件若没被它认出来，每个增量都会触发一次完整调度处理。
 *   2) **turn.cancelled 与 turn.failed 不是一回事**：前者是用户/上游主动取消，后者是失败。
 *      model/gateway-openai.ts 的 stream() 在 catch 里先判断 signal.aborted 再决定 yield
 *      哪一个，就是为了不让"用户取消"被显示成错误。
 *   3) **capabilities() 是可选的，且缺省等于"不支持"**：agent/executor-agent.ts 据此判定
 *      factory-controlled 循环模式能否使用（不支持则抛 MODEL_CAPABILITY_UNAVAILABLE）。
 *      **不要把"Provider 没声明"当成"能力齐全"。** supportedLoopModes 的内联 import 类型
 *      指向 agent/agent-loop.ts，与实现里用的值是同一处定义，搬迁时注意保持相对路径有效。
 *   4) **ModelGateway 不持有凭据**：configFor 返回的 ModelRoleConfig 里**没有 apiKey 字段**。
 *      Provider 密钥由组合根（apps/api）在构造具体实现时注入，且不落库 ——
 *      "Factory 不读取、不存储 API key"这条承诺的具体形态，就是这里少一个字段。
 *      往 ModelRoleConfig 上加凭据字段前，先读 README 的相关说明。
 *   5) **answerUserInput 只对 supportsStructuredUserInput 为 true 的后端可用**；
 *      model/gateway-openai.ts 的实现是**故意抛错**而不是空实现，与它 capabilities() 的
 *      返回值配套。改成 no-op 会让上层以为答案已送达 Provider。
 *   6) ModelRequest.purpose 目前只有 "exploration" / "title" 两个值，**只表达"这次调用是干什么用的"**，
 *      不再被任何实现用来推断运行模式 —— 起标题要不要进 plan 模式由调用方显式传 `mode: "default"`
 *      （见下一条）。新增用途时同步检查各实现是否真的按 purpose 分支。
 *   7) **ModelRequest.mode 是唯一一次调用级的模式覆盖**，优先于 roleConfig.mode。它与 Codex 的
 *      `collaborationMode.mode`、Claude Agent SDK 的 `permissionMode` 是同一件事的两处投影：
 *      加一个后端时不要各自另造字段，否则"配置里写了 plan、实际按角色硬编码"这类分歧会再次出现
 *      （P9 前 codex 实现就是硬编码按角色决定 plan，roleConfig.mode 整个是死配置）。
 *   8) **本端口不提供账号级用量/额度**：这里曾经有一个 `readRateLimits()` 与
 *      `ProviderUsageSnapshot`，它们唯一的数据源是 Codex App Server 的账号额度接口。
 *      删掉的理由不是"Claude 侧暂时没有"，而是**账号额度与端口语义不相称**：这个端口描述的是
 *      "一次模型调用"，而额度是账号级、跨会话、且取不到时无法用事件表达的东西。
 *      要用量，读 `model.usage` 事件（按回合/累计，见 model/usage.ts）；要加回账号额度，
 *      先回答"没有该接口的后端显示什么"，不要退回到静默的 `available:false`。
 *   9) **`ModelRoleConfig.backend` 只在组合根被消费，Provider 实现一律不读它。** 它标识
 *      "这次调用该交给哪个后端"，由 apps/api 的路由网关按"请求覆盖 → 角色默认"解析后委派给
 *      具体实现；某个实现自己再看这个字段，等于把"谁来路由"这件事分裂成两处。
 *      `capabilities(role, config?)` 与 `describeEndpoint(role?)` 之所以多了可选参数，是因为
 *      路由之后"哪个后端生效"取决于调用点带来的角色配置（Project 可以覆盖）——不传就是
 *      用角色默认值判定，传了就必须按传进来的那个后端回答。
 */
import type { ModelInputAnswers, ModelInputRequest } from "../explorer/types.js";
import type { ToolCall, ToolName } from "../tools/types.js";
import type { ProviderActivityKind, ProviderActivityOutcome } from "./provider-activity.js";
import type { ModelUsage, ModelUsageScope } from "./usage.js";

/** 模型职责角色；Explorer 只读分析，Executor 在 Run Worktree 中执行。 */
export type ModelRole = "explorer" | "executor";
/** 模型运行模式；plan 只读分析、default 允许按权限策略执行。 */
export type ModelMode = "plan" | "default";
/** 一个角色的模型和推理/循环策略，来源可为全局默认或 Project 快照。 */
export type ModelRoleConfig = {
  model: string;
  /**
   * 本角色使用哪个后端（后端 id）。**由组合根的路由网关消费，Provider 实现不读。**
   * 缺省表示跟随全局默认；Project 的同名字段可以覆盖它。
   */
  backend?: string | undefined;
  mode?: ModelMode | undefined;
  loopMode?: "provider-controlled" | "factory-controlled" | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
};
/** Provider 能力声明，决定结构化输入、工具和 Loop 模式是否可用。 */
export type ModelCapabilities = {
  supportsStructuredUserInput: boolean;
  supportsToolCalls: boolean;
  supportedLoopModes: import("../agent/agent-loop.js").AgentLoopMode[];
};
/** 传给模型的受控工具描述和输入 schema。 */
export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};
/** Provider 会话中的规范化消息。 */
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string };

/** 一次 Explorer/Executor 模型调用的完整上下文。 */
export type ModelRequest = {
  role: ModelRole;
  modelConfig?: ModelRoleConfig | undefined;
  purpose?: "exploration" | "title" | undefined;
  /** 本次调用的模式覆盖，优先于 roleConfig.mode；缺省时由实现按角色取默认。 */
  mode?: ModelMode | undefined;
  messages: ModelMessage[];
  conversationId?: string | undefined;
  providerThreadId?: string | undefined;
  cwd?: string | undefined;
  continuationPrompt?: string | undefined;
  tools?: ModelToolDefinition[] | undefined;
  signal?: AbortSignal | undefined;
};
/** 一条正文是"过程叙述"还是"最终回答"。**两个 Provider 只有 Codex 给**（`MessagePhase`）。 */
export type ModelMessagePhase = "commentary" | "final_answer";

/** ModelGateway 输出的统一流事件，供 Agent Loop 和消息流共同消费。 */
export type ModelEvent =
  | { type: "thread.started"; threadId: string; endpoint?: ProviderEndpoint | undefined }
  | { type: "text.delta"; text: string; phase?: ModelMessagePhase | undefined; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  /**
   * **这一段正文属于哪一类**。Codex 的 `agentMessage` item 带 `phase`，而它的
   * `item/agentMessage/delta` 载荷里**没有**这个字段（见 `AgentMessageDeltaNotification`），
   * 所以它只能从 `item/started` / `item/completed` 单独送一趟。
   *
   * 为什么要它：`commentary`（中途的叙述）与 `final_answer`（这一轮真正的回答）在界面上的
   * 重量完全不同——前者是"过程"，任务完成后折进折叠组；后者常驻。这正是 OpenClaw
   * 「Worked for …」那条折叠线的判据。**Provider 不保证给**（schema 原话：callers must treat
   * `None` as "phase unknown"），拿不到就不给，界面按"未知"处理而不是猜一个。
   */
  | { type: "text.phase"; providerItemId: string; phase: ModelMessagePhase }
  /**
   * `provider.activity` 的 `itemType` / `status` 是 **Provider 的原生词表**（Codex 与 Claude 完全不同），
   * 消费方不得直接拿它们判断语义。`activityKind` / `outcome` 是翻译后的中立词表，**必填**：
   * 每个 gateway 都必须能回答"这是什么活动、成没成"，回答不了就显式给 `unknown` / `other`。
   * 字段可选会让某个 Provider 悄悄漏填，而漏填的后果是 UI 退回到"状态未知"——那正是本次要修的缺陷。
   *
   * `arguments` / `result` / `output` / `exitCode` / `durationMs` 是**这一动作的结构化载荷**：
   * 它们此前一个都没进业务层，于是"这条命令到底跑了什么、结果是什么"在界面上没有原料。
   * 展示前一律过 `apps/web/src/utils/sensitiveValue.ts` 的脱敏与截断——**落库保留原样，
   * 脱敏发生在展示边界**（这样审计与排障仍有全量数据）。
   */
  | { type: "provider.activity"; phase: "started" | "completed"; itemId: string; itemType: string; activityKind: ProviderActivityKind; outcome: ProviderActivityOutcome; title: string | null; summary: string | null; toolName?: string | undefined; serverName?: string | undefined; arguments?: unknown; result?: unknown; output?: string | undefined; exitCode?: number | undefined; durationMs?: number | undefined; status?: string | undefined; error?: string | undefined; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "model.usage"; usage: ModelUsage; scope: ModelUsageScope; providerThreadId?: string | undefined; providerTurnId?: string | undefined }
  | { type: "tool.call"; call: ToolCall }
  | { type: "turn.input_required"; request: ModelInputRequest }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" };

/**
 * 一次 Run 生效的 Provider 端点指纹：模型请求实际打到哪里、端点与凭据由谁解析，
 * 以及 Provider 自己上报的 CLI 版本与模型名。**只记来源标识，不含任何凭据**。
 *
 * `endpoint: null` 是一个有信息量的事实而不是缺省值：它表示端点由 Provider 自己的设置解析
 * （例如 cc-switch 写进 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL）—— Factory 无法为
 * 这次 Run 担保端点，换供应商会同时影响所有在跑的 Run（见 README「接入 Claude Agent」）。
 */
export type ProviderEndpoint = {
  /** 后端标识：codex-app-server / claude-agent-sdk / openai-responses / stub。 */
  backend: string;
  /** 生效端点（host[:port]）或该后端自己的 CLI 命令；由 Provider 自行解析时为 null。 */
  endpoint: string | null;
  /** 端点来源：config = 本配置文件显式给出；provider-settings = Provider 自己的设置/登录态。 */
  source: "config" | "provider-settings";
  /** Provider 上报的 CLI 版本；尚未上报或该后端没有 CLI 时为 null。 */
  cliVersion: string | null;
  /** 凭据来源标识（如 ANTHROPIC_API_KEY、none、model.openai.apiKey）；未知为 null。 */
  credentialSource: string | null;
  /** Provider 上报的实际模型名；与控制面请求的 slug 可能不同（网关或代理会做映射）。 */
  providerModel: string | null;
};

export interface ModelGateway {
  /** 流式调用模型并按事件顺序返回文本、工具和输入请求。 */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** 将本地脱敏校验后的答案转交给 Provider。 */
  answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void>;
  /** 取消指定 Provider conversation/turn。 */
  cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void>;
  /** 返回指定角色当前生效的模型配置。 */
  configFor(role: ModelRole): ModelRoleConfig;
  /**
   * 返回指定角色的 Provider 能力声明。
   * `config` 是调用点已合并的**有效**角色配置（含 Project 覆盖）：路由之后不同后端的能力不同，
   * 判定必须针对真正会执行这一次调用的那个后端；不传则按角色默认后端回答。
   */
  capabilities?(role: ModelRole, config?: ModelRoleConfig): ModelCapabilities;
  /**
   * 返回本实现当前生效的端点指纹，供 Loop 记进 Run 事件；未知字段用 null 而不是猜。
   * `role` 用于多后端路由：同一进程内不同角色可能打向不同后端。
   */
  describeEndpoint?(role?: ModelRole, config?: ModelRoleConfig): ProviderEndpoint;
}
