/**
 * 模块职责：模型层的公共契约 —— 角色与角色配置、Provider 能力声明、工具描述与消息，
 *   以及 ModelGateway 端口本身和它的输出事件 ModelEvent。
 *
 * 为什么从 index.ts 抽出来（批 E）：ModelGateway 是"换一个模型后端"的唯一集成点，
 *   而它的契约与三个实现（model/codex-app-server.ts、model/gateway-openai.ts、
 *   model/stub-gateway.ts）此前分散在 index.ts 与 model/ 两处。搬到一起后，
 *   "接口要求什么、各实现给到什么"可以在同一目录里逐个对照。
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
 *   6) ModelRequest.purpose 目前只有 "exploration" / "title" 两个值，用于让实现区分
 *      探索与自动起标题两种调用；新增用途时同步检查各实现是否真的按 purpose 分支。
 */
import type { MappedCodexRateLimits } from "./codex-rate-limits.js";
import type { ModelInputAnswers, ModelInputRequest } from "../explorer/types.js";
import type { ToolCall, ToolName } from "../tools/types.js";
import type { ModelUsage, ModelUsageScope } from "./usage.js";

/** 模型职责角色；Explorer 只读分析，Executor 在 Run Worktree 中执行。 */
export type ModelRole = "explorer" | "executor";
/** 一个角色的模型和推理/循环策略，来源可为全局默认或 Project 快照。 */
export type ModelRoleConfig = {
  model: string;
  mode?: "plan" | "default" | undefined;
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
  messages: ModelMessage[];
  conversationId?: string | undefined;
  providerThreadId?: string | undefined;
  cwd?: string | undefined;
  continuationPrompt?: string | undefined;
  tools?: ModelToolDefinition[] | undefined;
  signal?: AbortSignal | undefined;
};
/** ModelGateway 输出的统一流事件，供 Agent Loop 和消息流共同消费。 */
export type ModelEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "text.delta"; text: string; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "provider.activity"; phase: "started" | "completed"; itemId: string; itemType: string; title: string | null; summary: string | null; toolName?: string | undefined; serverName?: string | undefined; status?: string | undefined; error?: string | undefined; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "model.usage"; usage: ModelUsage; scope: ModelUsageScope; providerThreadId?: string | undefined; providerTurnId?: string | undefined }
  | { type: "tool.call"; call: ToolCall }
  | { type: "turn.input_required"; request: ModelInputRequest }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" };

export interface ModelGateway {
  /** 流式调用模型并按事件顺序返回文本、工具和输入请求。 */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** 将本地脱敏校验后的答案转交给 Provider。 */
  answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void>;
  /** 取消指定 Provider conversation/turn。 */
  cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void>;
  /** 返回指定角色当前生效的模型配置。 */
  configFor(role: ModelRole): ModelRoleConfig;
  capabilities?(role: ModelRole): ModelCapabilities;
  readRateLimits?(): Promise<MappedCodexRateLimits>;
}
