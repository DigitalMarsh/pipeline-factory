/**
 * 测试职责：聊天行时间格式只有一种——两份格式器都锁住。
 */
import { describe, expect, it } from "vitest";
import { formatMessageTime, messageTimeTitle } from "./messageTime";

describe("聊天行时间", () => {
  it("行内只显示到分钟", () => {
    expect(formatMessageTime("2026-10-29T21:31:42.000Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatMessageTime("2026-10-29T21:31:42.000Z")).not.toContain(":42");
  });

  it("非法时间串原样返回", () => {
    expect(formatMessageTime("")).toBe("");
    expect(formatMessageTime("not-a-date")).toBe("not-a-date");
  });

  it("悬停标题带完整日期与时间", () => {
    const title = messageTimeTitle("2026-10-29T21:31:42.000Z");
    expect(title).toContain("2026");
    expect(title).not.toBe(formatMessageTime("2026-10-29T21:31:42.000Z"));
  });
});
