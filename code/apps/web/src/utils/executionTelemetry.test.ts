import { describe, expect, it } from "vitest";
import { executionModelSourceNote, formatExecutionDuration, formatProviderContextUsage, formatTokenSummary, liveDurationMs, resolveExecutionModelIdentity, telemetryReasoning, usageDetailRows } from "./executionTelemetry";

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

  it("formats Provider input tokens as execution Context without estimating missing values", () => {
    expect(formatProviderContextUsage(1_234)).toBe("1,234 tokens");
    expect(formatProviderContextUsage(null)).toBe("未记录");
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

  it("answers which model is in use from the recorded turn, and says so", () => {
    const identity = resolveExecutionModelIdentity({ model: "gpt-5.6-luna", reasoningEffort: null, backend: "codex-app-server", startedAt: null, completedAt: null, durationMs: null, usage: null, usageSource: "provider", usageScope: null }, { model: "configured-model", backend: "claude-agent-sdk" });

    // 本次记录整份优先：model 与 backend 是同一次写入的一对，不跟配置混搭。
    expect(identity).toEqual({ model: "gpt-5.6-luna", backend: "codex-app-server", source: "recorded" });
  });

  it("falls back to the Run's executor config while a turn is still running", () => {
    // 运行中遥测还没落库——"现在用的是什么模型"正是此刻要问的问题，所以必须有答案，
    // 而且必须标明这是配置而不是跑过的记录。
    const identity = resolveExecutionModelIdentity(null, { model: "frozen-model", backend: "claude-agent-sdk" });

    expect(identity).toEqual({ model: "frozen-model", backend: "claude-agent-sdk", source: "configured" });
  });

  it("keeps saying 未记录 when neither the record nor the config exists", () => {
    expect(resolveExecutionModelIdentity(null, null)).toEqual({ model: "未记录", backend: "未记录", source: "unknown" });
    // 只有一半也不编造另一半。
    expect(resolveExecutionModelIdentity(null, { model: "m", backend: null })).toEqual({ model: "m", backend: "未记录", source: "configured" });
  });

  it("says where the value came from, and calls out a config that moved on", () => {
    const recorded = resolveExecutionModelIdentity({ model: "gpt-5.6-luna", reasoningEffort: null, backend: "codex-app-server", startedAt: null, completedAt: null, durationMs: null, usage: null, usageSource: "provider", usageScope: null }, null);

    expect(executionModelSourceNote(recorded, { model: "gpt-5.6-luna" })).toBe("本次执行记录");
    // 用户把项目模型换成 claude 之后最想问的那句：为什么这里还是旧的。
    expect(executionModelSourceNote(recorded, { model: "claude-opus-5" })).toBe("本次执行记录 · 项目当前配置 claude-opus-5（改在下一个 Plan Revision 生效）");
  });

  it("does not invent a config note when there is nothing to compare", () => {
    const configured = resolveExecutionModelIdentity(null, { model: "claude-opus-5", backend: "claude-agent-sdk" });
    const unknown = resolveExecutionModelIdentity(null, null);

    expect(executionModelSourceNote(configured, null)).toBe("按本 Run 冻结的项目配置");
    expect(executionModelSourceNote(configured, { model: "claude-opus-5" })).toBe("按本 Run 冻结的项目配置");
    expect(executionModelSourceNote(unknown, { model: "claude-opus-5" })).toBe("");
  });
});
