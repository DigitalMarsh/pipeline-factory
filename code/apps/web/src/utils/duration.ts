/**
 * 模块职责：把毫秒说成人话。
 *
 * 为什么单独一个模块：三处在用（动作行的耗时、执行步骤的用时、Run 遥测的时长），
 * 各写一份就会出现"1.2s" / "1.2 秒" / "1200ms" 三种说法指同一个数——那正是这个仓在
 * 状态文案上已经修过一遍的毛病。
 */

/** 秒级以内保留一位小数；超过一分钟说成"X 分 Y 秒"，与 OpenClaw 那句 `Worked for 2 minutes, 3 seconds` 同形。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "未知";
  if (ms < 1_000) return "不足 1 秒";
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 两个时间戳之间的时长。**拿不到就不给**——宁可这一格不出现，也不要估一个数出来（见 RunDetailView）。 */
export function durationBetween(startedAt: string, completedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}
