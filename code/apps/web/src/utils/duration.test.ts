/**
 * 测试职责：钉住"毫秒说成人话"的两种说法，以及**拿不到时长就不给**这条判据。
 *
 * 为什么值得有自己的测试：三处在用（动作行的耗时、执行步骤的用时、Run 遥测的时长），
 * 各写一份就会出现"1.2s" / "1.2 秒" / "1200ms" 三种说法指同一个数。
 */
import { describe, expect, it } from "vitest";
import { durationBetween, formatDuration } from "./duration";

describe("时长的说法", () => {
  it("秒级以内保留一位小数，超过一分钟说成「X 分 Y 秒」", () => {
    expect(formatDuration(500)).toBe("不足 1 秒");
    expect(formatDuration(1_000)).toBe("1.0 秒");
    expect(formatDuration(9_400)).toBe("9.4 秒");
    expect(formatDuration(45_000)).toBe("45 秒");
    // OpenClaw 那句 `Worked for 2 minutes, 3 seconds` 的同形说法。
    expect(formatDuration(123_000)).toBe("2 分 3 秒");
    expect(formatDuration(120_000)).toBe("2 分");
  });

  it("拿不到就是拿不到，不编一个数出来", () => {
    expect(formatDuration(Number.NaN)).toBe("未知");
    expect(formatDuration(-1)).toBe("未知");
  });
});

describe("两个时间戳之间的时长", () => {
  it("正常区间给出毫秒数", () => {
    expect(durationBetween("2026-09-19T00:00:00.000Z", "2026-09-19T00:00:03.000Z")).toBe(3_000);
  });

  it("**倒着的区间与读不出的时间都给 null** —— 宁可那一格不出现，也不要一个负的用时", () => {
    expect(durationBetween("2026-09-19T00:00:03.000Z", "2026-09-19T00:00:00.000Z")).toBeNull();
    expect(durationBetween("不是时间", "2026-09-19T00:00:00.000Z")).toBeNull();
  });
});
