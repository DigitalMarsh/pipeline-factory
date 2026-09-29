/**
 * 模块职责：把 Codex 的速率限制响应解析成 Provider 无关的额度快照（见 model/types.ts 的
 *   ProviderUsageSnapshot）。
 *
 * 维护提示：
 *   1) **本文件只负责"Codex 原始响应 → 快照"这一层映射**，面向 UI 的快照类型住在
 *      model/types.ts —— 它曾经定义在这里（MappedCodexRateLimits / MappedRateLimit），
 *      于是 ModelGateway 端口的 readRateLimits 直接写着 Codex 的形状，stub 与 openai 两个
 *      实现被迫返回 Codex 文案的"不可用"。加一个非 Codex 后端时不要把 Provider 名再带回来。
 *   2) 只认精确窗口（5 小时 = 300 分钟、7 天 = 10080 分钟），找不到就报 available:false 并给出
 *      reason，不做"取最接近窗口"之类的猜测：额度面板宁可显示"取不到"。
 */
import type { ProviderUsageSnapshot, ProviderUsageWindow } from "./types.js";

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

/** 将 Provider 的原始限流窗口映射为 UI 可用的剩余比例和重置时间。 */
export function mapCodexRateLimits(response: CodexRateLimitsResponse | null): ProviderUsageSnapshot {
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

function findWindow(windows: CodexRateLimitWindow[], duration: number): ProviderUsageWindow | null {
  const window = windows.find((candidate) => candidate.windowDurationMins === duration);
  if (!window) return null;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetAt: new Date(window.resetsAt * 1_000).toISOString(),
  };
}

function unavailable(reason: string): ProviderUsageSnapshot {
  return { available: false, fiveHour: null, sevenDay: null, reason };
}
