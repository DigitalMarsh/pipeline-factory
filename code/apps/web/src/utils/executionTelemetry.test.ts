import { describe, expect, it } from "vitest";
import { formatExecutionDuration, formatTokenSummary, liveDurationMs, telemetryReasoning, usageDetailRows } from "./executionTelemetry";

describe("execution telemetry formatting", () => {
  it("formats exact token totals and keeps missing usage explicit", () => {
    expect(formatTokenSummary({ inputTokens: 12, outputTokens: 8, reasoningTokens: 3, totalTokens: 23 })).toBe("23 tokens");
    expect(formatTokenSummary(null)).toBe("未记录");
    expect(usageDetailRows({ inputTokens: 12, outputTokens: null, reasoningTokens: 3, totalTokens: 15 })).toEqual([
      { label: "输入 token", value: "12" },
      { label: "输出 token", value: "未记录" },
      { label: "推理 token", value: "3" },
      { label: "总 token", value: "15" },
    ]);
  });

  it("formats completed and live wall-clock duration", () => {
    expect(formatExecutionDuration({ model: "m", reasoningEffort: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:02.000Z", durationMs: 62_000, usage: null, usageSource: "not-recorded", usageScope: null })).toBe("1m 02s");
    const telemetry = { model: "m", reasoningEffort: null, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, durationMs: null, usage: null, usageSource: "not-recorded" as const, usageScope: null };
    expect(liveDurationMs(telemetry, Date.parse("2026-01-01T00:00:07.500Z"))).toBe(7500);
    expect(formatExecutionDuration(telemetry, Date.parse("2026-01-01T00:00:07.500Z"))).toBe("7s");
  });

  it("uses a clear default label when reasoning effort is not present", () => {
    expect(telemetryReasoning(null)).toBe("默认");
  });
});
