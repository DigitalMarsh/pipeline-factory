/**
 * 模块职责：Provider token 用量的规范化与聚合。Provider 各家字段命名不一致（OpenAI snake_case、
 *   App Server camelCase、以及嵌在 output_tokens_details 里的 reasoning 字段），统一在这里收敛成 ModelUsage。
 *
 * 为什么从 index.ts 抽出来：这几个符号是 index.ts 与 codex-app-server / executor-agent 之间
 *   值级循环依赖的另一半（前一半是 platform/plan-requirements.ts）。它们只吃 unknown 与普通对象、
 *   **零 import**，是第二片理想叶子。
 *
 * 维护提示：
 *   1) 这里**不做本地估算**：Provider 没返回就用 null，不拿字符数之类的启发式去猜。
 *      ExecutionTelemetry 的 usageSource 字段就是靠"是否为 null"来区分"Provider 没给"与"用量为零"的。
 *   2) mergeModelUsage 的 total scope 语义是"Provider 的累计值优先"，不是把 turn 值反复相加——
 *      改成相加会让长会话的用量统计单调膨胀。
 */
/** Provider 返回的精确 token 用量；null 表示 Provider 没有返回对应字段。 */
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};
export type ModelUsageScope = "turn" | "total";

const usageField = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** 兼容 OpenAI snake_case、App Server camelCase 及其嵌套 reasoning 字段。 */
export function normalizeModelUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const outputDetails =
    candidate.output_tokens_details && typeof candidate.output_tokens_details === "object"
      ? (candidate.output_tokens_details as Record<string, unknown>)
      : {};
  const outputDetailsCamel =
    candidate.outputTokensDetails && typeof candidate.outputTokensDetails === "object"
      ? (candidate.outputTokensDetails as Record<string, unknown>)
      : {};
  const usage: ModelUsage = {
    inputTokens: usageField(candidate.input_tokens ?? candidate.inputTokens),
    outputTokens: usageField(candidate.output_tokens ?? candidate.outputTokens),
    reasoningTokens: usageField(
      candidate.reasoning_tokens ??
        candidate.reasoningTokens ??
        candidate.reasoning_output_tokens ??
        candidate.reasoningOutputTokens ??
        outputDetails.reasoning_tokens ??
        outputDetailsCamel.reasoningTokens,
    ),
    totalTokens: usageField(candidate.total_tokens ?? candidate.totalTokens),
  };
  return Object.values(usage).some((item) => item !== null) ? usage : null;
}

/** 聚合多个 Provider turn；total scope 使用 Provider 的累计值而不是重复相加。 */
export function mergeModelUsage(previous: ModelUsage | null, incoming: ModelUsage, scope: ModelUsageScope): ModelUsage {
  if (scope === "total") {
    return {
      inputTokens: incoming.inputTokens ?? previous?.inputTokens ?? null,
      outputTokens: incoming.outputTokens ?? previous?.outputTokens ?? null,
      reasoningTokens: incoming.reasoningTokens ?? previous?.reasoningTokens ?? null,
      totalTokens: incoming.totalTokens ?? previous?.totalTokens ?? null,
    };
  }
  const add = (before: number | null | undefined, after: number | null): number | null =>
    before === null || before === undefined ? after : after === null ? before : before + after;
  return {
    inputTokens: add(previous?.inputTokens, incoming.inputTokens),
    outputTokens: add(previous?.outputTokens, incoming.outputTokens),
    reasoningTokens: add(previous?.reasoningTokens, incoming.reasoningTokens),
    totalTokens: add(previous?.totalTokens, incoming.totalTokens),
  };
}
