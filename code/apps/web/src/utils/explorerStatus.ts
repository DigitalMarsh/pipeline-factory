/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 * 维护提示：这里**故意没有**账号额度（5 小时 / 7 天）的格式化函数。额度面板与它的
 * `/api/v4/codex/rate-limits` 数据源已从页面与后端两侧移除；本文件只剩 provider 无关的
 * 上下文规模估算。
 */
/** 以近似 token 数显示上下文规模，避免把前端字符长度误认为 Provider 精确计费值。 */
export function formatContextUsage(turns: Array<Pick<{ content: string }, "content">>): string {
  const characters = turns.reduce((total, turn) => total + turn.content.length, 0);
  const tokens = Math.ceil(characters / 4);
  return tokens >= 1_000 ? `~${(tokens / 1_000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}
