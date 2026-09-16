import { describe, expect, it } from "vitest";
import { summarizeUserMessage } from "./messageSummary";

describe("user message summary", () => {
  it("uses the first non-empty line as the title and the remaining lines as the preview", () => {
    expect(summarizeUserMessage("\n是的，执行此计划\n\n请保留现有接口。\n继续使用 Vue。"))
      .toEqual({ title: "是的，执行此计划", preview: "请保留现有接口。 继续使用 Vue。" });
  });

  it("keeps a single-line message as the title without duplicating it in the preview", () => {
    expect(summarizeUserMessage("请检查这个 Explorer"))
      .toEqual({ title: "请检查这个 Explorer", preview: "" });
  });

  it("falls back to a readable title for whitespace-only content", () => {
    expect(summarizeUserMessage(" \n\t ")).toEqual({ title: "用户消息", preview: "" });
  });

  it("preserves long content for CSS-only visual clamping", () => {
    const source = `标题\n${"内容 ".repeat(200)}`;
    const summary = summarizeUserMessage(source);

    expect(summary.title).toBe("标题");
    expect(summary.preview.length).toBeGreaterThan(500);
  });
});
