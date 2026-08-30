/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
const statStatusMap = {
  all: "all",
  queued: "QUEUED",
  running: "IN_PROGRESS",
  verifying: "VERIFYING",
  review: "MERGE_READY",
  merged: "MERGED",
  blocked: "BLOCKED",
} as const;

/** 把统计卡片的前端 key 映射为 API/Domain 状态，未知 key 回到全量筛选。 */
export function planStatusForStat(statKey: string): string {
  return statStatusMap[statKey as keyof typeof statStatusMap] ?? "all";
}
