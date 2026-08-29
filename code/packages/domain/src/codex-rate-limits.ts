export type CodexRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
};

export type CodexRateLimitBucket = {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
};

export type CodexRateLimitsResponse = {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
};

export type MappedRateLimit = {
  remainingPercent: number;
  resetAt: string;
};

export type MappedCodexRateLimits = {
  available: boolean;
  fiveHour: MappedRateLimit | null;
  sevenDay: MappedRateLimit | null;
  reason: string | null;
};

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
