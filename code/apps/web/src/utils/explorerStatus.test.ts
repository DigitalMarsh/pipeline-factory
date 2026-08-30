/**
 * 测试职责：验证 explorerStatus 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { formatContextUsage, formatConversationId, formatRateLimit } from "./explorerStatus";

describe("Codex usage status", () => {
  it("formats the loaded conversation as an estimated context usage", () => {
    expect(formatContextUsage([{ content: "a".repeat(400) }])).toBe("~100 tokens");
    expect(formatContextUsage([{ content: "a".repeat(4_800) }])).toBe("~1.2k tokens");
  });

  it("shortens a conversation id for the compact status row", () => {
    expect(formatConversationId("01a04b03-3cfb-7c41-84a3-c8df417925b5")).toBe("01a04b03-3cfb-7c41-84a3-c8df…");
  });

  it("does not invent rate-limit values when Codex telemetry is unavailable", () => {
    expect(formatRateLimit(null)).toEqual({ remaining: "Unavailable", reset: "Not provided" });
  });

  it("formats exact Codex rate-limit values for the status popover", () => {
    expect(formatRateLimit({ remainingPercent: 77, resetAt: "2026-06-17T00:00:00.000Z" })).toEqual({
      remaining: "剩余 77%",
      reset: "重置时间: 2026-06-17T00:00:00.000Z",
    });
  });
});
