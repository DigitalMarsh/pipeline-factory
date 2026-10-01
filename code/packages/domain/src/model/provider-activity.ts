/**
 * 模块职责：把各 Provider 原生的"活动"词表翻译成 Factory 的中立词表——**类别**与**成败**。
 *
 * 为什么必须有这一层：两个后端的原生词表完全不通用，而消费方（执行会话投影、Agent Loop、
 *   TOOL_CALL 账本）此前是各自正则猜标签、各自维护成败白名单，于是"同一种活动换个 agent 就换
 *   个名字"，Codex 的 `completed`（它的正常结束词）不在成功白名单里，全库 `PROVIDER_ACTIVITY`
 *   343 条"状态未知"、**0 条成功**——成功从未被识别过。表集中在这里之后，"同一逻辑活动 →
 *   同一类别 + 同一成败"是可读、可测的一条断言，而不是散在两个 gateway 的 if 里。
 *
 * 维护提示：
 *   1) **`not-applicable` 与 `unknown` 是两件事，不要合并**：前者是"这类活动没有成败概念"
 *      （推理流、用户消息、会话重建），后者是"应该有成败但 Provider 没给"。UI 对前者的正确处理是
 *      **不渲染状态 chip**；合并回一个值，噪音就回来了（全库 210/343 条属于前者）。
 *   2) **成败词表两个 Provider 共用**，因为 Codex 的 `completed` 与 Claude 的 `succeeded` 指的是
 *      同一件事。加新 Provider 时先看它的词能不能落进这张表，落不进再考虑新增分支——不要为它
 *      另起一套判定。
 *   3) 类别判定用**包含匹配**而不是等值匹配：Provider 的 itemType 会带前缀/后缀漂移
 *      （`commandExecution`、`mcpToolCall`、`tool_result`），等值匹配会在对方升级后静默退化成
 *      `other`。`other` 是兜底，不是正常值。
 *   4) 本模块**不 import 任何 Provider 实现**，只吃普通字段；这样它可以在两个 gateway 之间共享，
 *      也不会把某个 SDK 的类型泄漏进领域契约。
 */

/** 中立的活动类别。与 Provider 无关，UI 的展示词表按它取。 */
export type ProviderActivityKind = "command" | "file-change" | "tool" | "mcp" | "reasoning" | "message" | "session" | "other";

/**
 * 中立的活动成败。
 * - `not-applicable`：这类活动没有成败概念（见维护提示 1）。
 * - `unknown`：应该有成败，但 Provider 没给——这是**值得显示**的信息，不要静默成成功。
 */
export type ProviderActivityOutcome = "running" | "succeeded" | "failed" | "unknown" | "not-applicable";

/** 没有成败概念的类别；顺序无关，只用于判定。 */
const OUTCOME_FREE_KINDS: readonly ProviderActivityKind[] = ["reasoning", "message", "session"];

const ACTIVITY_KINDS: readonly ProviderActivityKind[] = ["command", "file-change", "tool", "mcp", "reasoning", "message", "session", "other"];
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

/** 该类别是否根本没有成败概念（UI 据此决定不渲染状态 chip）。 */
export function isOutcomeFreeKind(kind: ProviderActivityKind): boolean {
  return OUTCOME_FREE_KINDS.includes(kind);
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
  if (input.error || status === "failed" || status === "error" || status === "denied" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "success" || status === "succeeded" || status === "completed" || status === "complete") return "succeeded";
  return input.phase === "started" ? "running" : "unknown";
}

/**
 * Codex App Server 的 item 类别 → 中立类别。
 * 已知的 itemType：`reasoning` / `commandExecution` / `fileChange` / `userMessage` / `mcpToolCall`，
 * 以及消息类（`agentMessage`）。**顺序即优先级**：`tool` 必须排在 `mcp` 之后，否则 `mcpToolCall`
 * 会被"tool"抢走（web 侧的镜像曾因此与这里不一致，被 parity 测试拦下）。
 */
export function codexActivityKind(itemType: string): ProviderActivityKind {
  return matchKind(itemType, { mcp: ["mcp"], command: ["command", "exec"], "file-change": ["file", "patch"], reasoning: ["reason"], message: ["message"], session: ["session"], tool: ["tool"] });
}

/**
 * Claude Agent SDK 的 item 类别 → 中立类别。
 * `tool_use` 与 `tool_result` **必须归到同一类别**，否则同一活动在 started/completed 两次事件里
 * 类别不同，投影合并时会闪变。`tool_result` 本身不带工具名，由 gateway 记住并传 `toolName`。
 */
export function claudeActivityKind(itemType: string, toolName?: string): ProviderActivityKind {
  if (/tool/i.test(itemType)) return claudeToolKind(toolName);
  return matchKind(itemType, { session: ["session"], message: ["message"], reasoning: ["reason"] });
}

/** 工具名 → 类别：让 Claude 的 Bash 与 Codex 的 commandExecution 落到同一个"命令"。 */
function claudeToolKind(toolName?: string): ProviderActivityKind {
  const name = toolName?.trim().toLowerCase() ?? "";
  if (!name) return "tool";
  if (name.startsWith("mcp__")) return "mcp";
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
