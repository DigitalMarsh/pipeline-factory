/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
/** 以近似 token 数显示上下文规模，避免把前端字符长度误认为 Provider 精确计费值。 */
export function formatContextUsage(turns: Array<Pick<{ content: string }, "content">>): string {
  const characters = turns.reduce((total, turn) => total + turn.content.length, 0);
  const tokens = Math.ceil(characters / 4);
  return tokens >= 1_000 ? `~${(tokens / 1_000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

/** 将可选的限流遥测转换为明确的可用/不可用文案。 */
export function formatRateLimit(limit: { remainingPercent: number; resetAt: string } | null): { remaining: string; reset: string } {
  if (!limit) return { remaining: "Unavailable", reset: "Not provided" };
  const resetMatch = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(limit.resetAt);
  const reset = resetMatch
    ? `${resetMatch[2]}-${resetMatch[3]} ${resetMatch[4]}:${resetMatch[5]}`
    : "Not provided";
  return { remaining: `剩余 ${limit.remainingPercent}%`, reset: `重置时间: ${reset}` };
}
