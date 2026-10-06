/**
 * 模块职责：把各 Provider 原生的"活动"词表翻译成 Factory 的中立词表——**类别**与**成败**。
 *
 * 为什么必须有这一层：两个后端的原生词表完全不通用，而消费方（执行会话投影、Agent Loop、
 *   TOOL_CALL 账本）此前是各自正则猜标签、各自维护成败白名单，于是"同一种活动换个 agent 就换
 *   个名字"，Codex 的 `completed`（它的正常结束词）不在成功白名单里，全库 `PROVIDER_ACTIVITY`
 *   343 条"状态未知"、**0 条成功**——成功从未被识别过。表集中在这里之后，"同一逻辑活动 →
 *   同一类别 + 同一成败"是可读、可测的一条断言，而不是散在两个 gateway 的 if 里。
 *
 * **类别分四组，对应消息大类的 ② ③ ④**（见 `docs/Provider消息格式与消息大类调研.md`）：
 *   - ② 内容流（`reasoning` / `message`）：模型说的。有顺序、没有成败。
 *   - ③ 动作（`command` / `file-change` / `tool` / `mcp` / `search` / `media` / `subagent`）：
 *     模型对外做的。**有成败**，会开始也会结束，可能要你批准。
 *   - ④ 运行事实（`session` / `compaction` / `hook` / `task` / `rate-limit` / `retry` /
 *     `permission` / `warning` / `review`）：会话设施在说话，不是模型做的。
 *     **这一类不进会话正文**，判据是 `isRuntimeKind()`。
 *   - 兜底 `other`。
 *
 * 维护提示：
 *   1) **`not-applicable` 与 `unknown` 是两件事，不要合并**：前者是"这类活动没有成败概念"
 *      （推理流、用户消息、会话重建），后者是"应该有成败但 Provider 没给"。UI 对前者的正确处理是
 *      **不渲染状态标签**；合并回一个值，噪音就回来了（全库 210/343 条属于前者）。
 *   2) **成败词表两个 Provider 共用**，因为 Codex 的 `completed` 与 Claude 的 `succeeded` 指的是
 *      同一件事。加新 Provider 时先看它的词能不能落进这张表，落不进再考虑新增分支——不要为它
 *      另起一套判定。**`declined` 曾经漏在这张表外**，于是 Codex 明确拒绝掉的命令显示成
 *      「状态未知」——"被拒"与"没记录到"是两句完全不同的话。（Codex 的 `CommandExecutionStatus`
 *      取值是 `inProgress` / `completed` / `failed` / `declined`。）
 *   3) 类别判定用**包含匹配**而不是等值匹配：Provider 的 itemType 会带前缀/后缀漂移
 *      （`commandExecution`、`mcpToolCall`、`tool_result`），等值匹配会在对方升级后静默退化成
 *      `other`。`other` 是兜底，不是正常值。**顺序即优先级**，见下面两个函数的注解。
 *   4) 本模块**不 import 任何 Provider 实现**，只吃普通字段；这样它可以在两个 gateway 之间共享，
 *      也不会把某个 SDK 的类型泄漏进领域契约。
 */

/**
 * 中立的活动类别。与 Provider 无关，UI 的展示词表按它取。
 *
 * **不要按字母序排列**——注释里的分组就是"这一类属于哪个消息大类"的答案，消费方据此决定
 * 它进不进会话正文（`isRuntimeKind`）、要不要画状态标签（`isOutcomeFreeKind`）。
 */
export type ProviderActivityKind =
  // ② 内容流：模型说的话。没有成败概念。
  | "reasoning"
  | "message"
  // ③ 动作：模型对外做的事。有成败、有生命周期。
  | "command"
  | "file-change"
  | "tool"
  | "mcp"
  | "search"
  | "media"
  | "subagent"
  // ④ 运行事实：会话设施在说话。**不进会话正文**，交 Run 头诊断区。
  | "session"
  | "compaction"
  | "hook"
  | "task"
  | "rate-limit"
  | "retry"
  | "permission"
  | "warning"
  | "review"
  // 兜底：Provider 给了这边还不认识的东西。它是**待办**，不是正常值。
  | "other";

/**
 * 中立的活动成败。
 * - `not-applicable`：这类活动没有成败概念（见维护提示 1）。
 * - `unknown`：应该有成败，但 Provider 没给——这是**值得显示**的信息，不要静默成成功。
 */
export type ProviderActivityOutcome = "running" | "succeeded" | "failed" | "unknown" | "not-applicable";

/**
 * 没有成败概念的类别。**④ 里也有一半属于这一档**：压缩、额度、重试、告警、评审是"发生了一件事"，
 * 不是"做成了没有"；会话重建同理。而钩子、子任务、权限被拒是有的（前两者会成功也会失败，
 * 后者本身就是"被拒"这个结论）。
 */
const OUTCOME_FREE_KINDS: readonly ProviderActivityKind[] = ["reasoning", "message", "session", "compaction", "rate-limit", "retry", "warning", "review"];

/** ④「Provider 说的」的运行事实。**这一类不进会话正文**——它是"机器在说话"，不是模型或你的发言。 */
const RUNTIME_KINDS: readonly ProviderActivityKind[] = ["session", "compaction", "hook", "task", "rate-limit", "retry", "permission", "warning", "review"];

/**
 * ④ 里**需要浮到用户眼前**的那几类：常态收进诊断区，这几类要在 Run 头上冒出来
 * （额度、重试、权限被拒、命令级告警、评审）。**"常态"与"异常"必须是一条判据**，
 * 否则每个新类别都要回来补一处 if。
 *
 * 注意它只是**其中一半**的判据：钩子与子任务本身不在这一组里，但它们**失败**时同样是异常——
 * 调用方要连 `outcome === "failed"` 一起看（见 `ExecutionHeaderStatus.vue` 的 `runtimeAlert`）。
 */
const RUNTIME_ALERT_KINDS: readonly ProviderActivityKind[] = ["rate-limit", "retry", "permission", "warning", "review"];

const ACTIVITY_KINDS: readonly ProviderActivityKind[] = [
  "reasoning", "message",
  "command", "file-change", "tool", "mcp", "search", "media", "subagent",
  "session", "compaction", "hook", "task", "rate-limit", "retry", "permission", "warning", "review",
  "other",
];
const ACTIVITY_OUTCOMES: readonly ProviderActivityOutcome[] = ["running", "succeeded", "failed", "unknown", "not-applicable"];

/**
 * 载荷里带的是不是合法类别。用于**读取历史数据**的路径（老 journal 事件没有这两个字段）：
 * 不合法就由调用方显式降级，而不是照着 Provider 原生词猜一个像样的答案。
 */
export function isProviderActivityKind(value: unknown): value is ProviderActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** 载荷里带的是不是合法成败。语义见 isProviderActivityKind。 */
export function isProviderActivityOutcome(value: unknown): value is ProviderActivityOutcome {
  return typeof value === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/** 该类别是否根本没有成败概念（UI 据此决定不渲染状态标签）。 */
export function isOutcomeFreeKind(kind: ProviderActivityKind): boolean {
  return OUTCOME_FREE_KINDS.includes(kind);
}

/**
 * 该类别是不是 ④「Provider 说的」运行事实。
 *
 * **两个消费方都问它，不各自列举**：执行会话投影据此把它挡在会话正文之外（见
 * `apps/web/src/utils/executionStream.ts` 的 `EXECUTION_DISPLAY_MODES`），Run 头诊断区据此
 * 把它收进「Provider 运行事实」一节、并在异常时浮现。
 * 分散成两处白名单，加一类就会漏一处——那正是这份调研要修的那类毛病。
 */
export function isRuntimeKind(kind: ProviderActivityKind): boolean {
  return RUNTIME_KINDS.includes(kind);
}

/** 该类别是不是"需要浮到用户眼前"的运行事实。语义与理由见 `RUNTIME_ALERT_KINDS`。 */
export function isRuntimeAlertKind(kind: ProviderActivityKind): boolean {
  return RUNTIME_ALERT_KINDS.includes(kind);
}

/** 一次 Provider 活动的原生事实；两个 Provider 各自把自己那份填进来。 */
export type ProviderActivityInput = {
  itemType: string;
  phase: "started" | "completed";
  /** Provider 原生状态字符串，原样传入（大小写与拼写由本模块归一）。 */
  status?: string | undefined;
  /** Provider 给出的失败原因；非空即判定失败。 */
  error?: string | undefined;
  /** Claude 侧才有：tool_use 的工具名，用于把类别判到 command / file-change / mcp 而不是笼统的 tool。 */
  toolName?: string | undefined;
};

/**
 * 成败判定：**两个 Provider 共用一张词表**。
 * 先看有没有明确的失败证据（Provider 的失败词或 error 原因），再看成功词，最后按阶段回落。
 */
export function activityOutcome(input: Pick<ProviderActivityInput, "phase" | "status" | "error"> & { kind: ProviderActivityKind }): ProviderActivityOutcome {
  if (isOutcomeFreeKind(input.kind)) return "not-applicable";
  const status = input.status?.trim().toLowerCase();
  // `declined` 与 `denied` 是同一件事的两个拼法：Codex 用前者的原生词表（CommandExecutionStatus），
  // Claude 用后者的 permission_denied。它是**明确的失败证据**，不能落进下面的"按阶段回落"。
  if (input.error || status === "failed" || status === "error" || status === "denied" || status === "declined" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "success" || status === "succeeded" || status === "completed" || status === "complete") return "succeeded";
  return input.phase === "started" ? "running" : "unknown";
}

/**
 * Codex App Server 的 item 类别 → 中立类别。
 *
 * 已知的 18 种 `ThreadItem.type` 逐条有归宿：
 * `userMessage` / `agentMessage` / `plan` → `message`（前两者是回声与正文，`plan` 是**规划文档的回声**，
 * 正文本就在助手消息里）；`reasoning` / `commandExecution` / `fileChange` / `mcpToolCall` /
 * `dynamicToolCall` / `collabAgentToolCall` / `subAgentActivity` / `webSearch` / `imageView` /
 * `imageGeneration` / `sleep` / `hookPrompt` / `enteredReviewMode` / `exitedReviewMode` /
 * `contextCompaction` → 各自的中立类别。
 *
 * **顺序即优先级**，两处不能动：
 *   - `mcp` 必须排在 `tool` 之前，否则 `mcpToolCall` 会被"tool"抢走（web 侧的镜像曾因此与这里不一致，
 *     被 parity 测试拦下）；
 *   - `subagent` / `search` / `media` 必须排在 `tool` / `file-change` 之前，
 *     否则 `collabAgentToolCall`（含 "tool"）与 `imageGeneration`（含... 无）会落到笼统的 tool。
 */
export function codexActivityKind(itemType: string): ProviderActivityKind {
  return matchKind(itemType, {
    mcp: ["mcp"],
    subagent: ["collab", "subagent"],
    search: ["websearch", "web_search"],
    media: ["imagegeneration", "image_generation"],
    command: ["command", "exec"],
    "file-change": ["file", "patch"],
    reasoning: ["reason"],
    // `plan` 是整篇规划文档：它的正文已经在那条助手消息里（实测 27/27 个产生 plan 项的 loop
    // 都有 MODEL_TEXT_DELTA），再摆一行是重复。归到 `message` → 呈现为 `hidden`，与
    // `userMessage`（你那句话的回声）同一个处置。
    message: ["message", "plan"],
    hook: ["hook"],
    compaction: ["compact"],
    task: ["task"],
    "rate-limit": ["ratelimit", "rate_limit"],
    retry: ["retry"],
    permission: ["permission", "approval"],
    warning: ["warning", "deprecation", "notice"],
    review: ["review"],
    session: ["session"],
    tool: ["tool", "imageview"],
  });
}

/**
 * Claude Agent SDK 的 item 类别 → 中立类别。
 * `tool_use` 与 `tool_result` **必须归到同一类别**，否则同一活动在 started/completed 两次事件里
 * 类别不同，投影合并时会闪变。`tool_result` 本身不带工具名，由 gateway 记住并传 `toolName`。
 *
 * 这里收的 itemType 来自本适配器自己发出的值（SDK 的消息种类见 `mapMessage`），
 * 不是 SDK 的 `type` 字段本身——`type: "system"` 下面还分二十几个 `subtype`。
 */
export function claudeActivityKind(itemType: string, toolName?: string): ProviderActivityKind {
  if (/tool/i.test(itemType)) return claudeToolKind(toolName);
  return matchKind(itemType, {
    session: ["session", "worker_shutting", "conversation_reset"],
    message: ["message"],
    reasoning: ["reason", "thinking"],
    hook: ["hook"],
    compaction: ["compact"],
    task: ["task"],
    "rate-limit": ["rate_limit", "ratelimit"],
    retry: ["retry"],
    permission: ["permission"],
    warning: ["warning", "informational"],
  });
}

/** 工具名 → 类别：让 Claude 的 Bash 与 Codex 的 commandExecution 落到同一个"命令"。 */
function claudeToolKind(toolName?: string): ProviderActivityKind {
  const name = toolName?.trim().toLowerCase() ?? "";
  if (!name) return "tool";
  if (name.startsWith("mcp__")) return "mcp";
  // 派生子代理与联网搜索在 Codex 那边是独立的 item 类型，Claude 这边只能从工具名认出来；
  // 认不出来就会和 `Bash` 一样显示成一行"工具调用"，看不出"它派了个子代理"。
  if (name === "task" || name.startsWith("agent") || name === "workflow") return "subagent";
  if (name === "websearch" || name === "webfetch") return "search";
  if (name === "bash" || name === "bashoutput" || name === "killshell") return "command";
  if (["write", "edit", "multiedit", "notebookedit"].includes(name)) return "file-change";
  return "tool";
}

function matchKind(itemType: string, table: Partial<Record<ProviderActivityKind, readonly string[]>>): ProviderActivityKind {
  const value = itemType.trim().toLowerCase();
  for (const [kind, needles] of Object.entries(table) as Array<[ProviderActivityKind, readonly string[]]>) {
    if (needles.some((needle) => value.includes(needle))) return kind;
  }
  return "other";
}

/** Codex 的完整分类；返回字段名与 `ModelEvent.provider.activity` 对齐，便于调用点直接展开。 */
export function classifyCodexActivity(input: ProviderActivityInput): { activityKind: ProviderActivityKind; outcome: ProviderActivityOutcome } {
  const activityKind = codexActivityKind(input.itemType);
  return { activityKind, outcome: activityOutcome({ kind: activityKind, phase: input.phase, ...(input.status === undefined ? {} : { status: input.status }), ...(input.error === undefined ? {} : { error: input.error }) }) };
}

/** Claude 的完整分类；返回字段名与 `ModelEvent.provider.activity` 对齐。 */
export function classifyClaudeActivity(input: ProviderActivityInput): { activityKind: ProviderActivityKind; outcome: ProviderActivityOutcome } {
  const activityKind = claudeActivityKind(input.itemType, input.toolName);
  return { activityKind, outcome: activityOutcome({ kind: activityKind, phase: input.phase, ...(input.status === undefined ? {} : { status: input.status }), ...(input.error === undefined ? {} : { error: input.error }) }) };
}
