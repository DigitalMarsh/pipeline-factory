import { describe, expect, it } from "vitest";
import { mapCodexRateLimits, type CodexRateLimitsResponse } from "./codex-rate-limits.js";

describe("Codex rate-limit mapping", () => {
  it("maps the exact five-hour and seven-day windows to remaining percentages", () => {
    const response: CodexRateLimitsResponse = {
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_781_654_400 },
          secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_782_259_200 },
        },
      },
    };

    expect(mapCodexRateLimits(response)).toEqual({
      available: true,
      fiveHour: { remainingPercent: 77, resetAt: "2026-06-17T00:00:00.000Z" },
      sevenDay: { remainingPercent: 39, resetAt: "2026-06-24T00:00:00.000Z" },
      reason: null,
    });
  });

  it("does not substitute another window when an exact window is absent", () => {
    const response: CodexRateLimitsResponse = {
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1_781_654_400 }, secondary: null },
    };

    expect(mapCodexRateLimits(response)).toEqual({
      available: false,
      fiveHour: null,
      sevenDay: null,
      reason: "Codex did not return exact 5-hour or 7-day windows",
    });
  });

  it("returns a transparent unavailable response for missing telemetry", () => {
    expect(mapCodexRateLimits(null)).toEqual({
      available: false,
      fiveHour: null,
      sevenDay: null,
      reason: "Codex rate-limit telemetry is unavailable",
    });
  });
});
