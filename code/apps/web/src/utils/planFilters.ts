const statStatusMap = {
  all: "all",
  queued: "QUEUED",
  running: "IN_PROGRESS",
  verifying: "VERIFYING",
  review: "MERGE_READY",
  merged: "MERGED",
  blocked: "BLOCKED",
} as const;

export function planStatusForStat(statKey: string): string {
  return statStatusMap[statKey as keyof typeof statStatusMap] ?? "all";
}
