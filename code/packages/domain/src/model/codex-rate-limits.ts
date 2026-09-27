/**
 * 模块职责：定义 Codex 速率限制数据的解析和展示所需的领域规则。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
/** Provider 返回的一个限流窗口，时间戳以 Unix seconds 表示。 */
export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

/** 一组主/次级限流窗口。 */
export type CodexRateLimitBucket = {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
};

/** Codex rate-limit 原始响应，兼容单组和按 limit id 分组的返回形态。 */
export type CodexRateLimitsResponse = {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
};

/** 面向 UI 的限流展示值，使用剩余百分比和 ISO reset 时间。 */
export type MappedRateLimit = {
  remainingPercent: number;
  resetAt: string;
};

/** 归一化后的 Codex 限流结果；不可用时通过 available/reason 显式表达。 */
export type MappedCodexRateLimits = {
  available: boolean;
  fiveHour: MappedRateLimit | null;
  sevenDay: MappedRateLimit | null;
  reason: string | null;
};

/** 将 Provider 的原始限流窗口映射为 UI 可用的剩余比例和重置时间。 */
export function mapCodexRateLimits(response: CodexRateLimitsResponse | null): MappedCodexRateLimits {
  if (!response) return unavailable("Codex rate-limit telemetry is unavailable");
  const windows = [
    ...(response.rateLimits ? [response.rateLimits] : []),
    ...Object.values(response.rateLimitsByLimitId ?? {}),
  ].flatMap((bucket) => [bucket.primary, bucket.secondary].filter((window): window is CodexRateLimitWindow => window !== null && window !== undefined));
  const fiveHour = findWindow(windows, 300);
  const sevenDay = findWindow(windows, 10_080);
  if (!fiveHour && !sevenDay) return unavailable("Codex did not return exact 5-hour or 7-day windows");
  return {
    available: true,
    fiveHour,
    sevenDay,
    reason: null,
  };
}

function findWindow(windows: CodexRateLimitWindow[], duration: number): MappedRateLimit | null {
  const window = windows.find((candidate) => candidate.windowDurationMins === duration);
  if (!window) return null;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetAt: new Date(window.resetsAt * 1_000).toISOString(),
  };
}

function unavailable(reason: string): MappedCodexRateLimits {
  return { available: false, fiveHour: null, sevenDay: null, reason };
}
