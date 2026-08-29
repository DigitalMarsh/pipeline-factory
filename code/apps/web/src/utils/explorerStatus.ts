export function formatContextUsage(turns: Array<Pick<{ content: string }, "content">>): string {
  const characters = turns.reduce((total, turn) => total + turn.content.length, 0);
  const tokens = Math.ceil(characters / 4);
  return tokens >= 1_000 ? `~${(tokens / 1_000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

export function formatConversationId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 28)}…` : value;
}

export function formatRateLimit(limit: { remainingPercent: number; resetAt: string } | null): { remaining: string; reset: string } {
  if (!limit) return { remaining: "Unavailable", reset: "Not provided" };
  return { remaining: `剩余 ${limit.remainingPercent}%`, reset: `重置时间: ${limit.resetAt}` };
}
