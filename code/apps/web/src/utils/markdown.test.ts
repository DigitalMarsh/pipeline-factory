/**
 * 测试职责：验证 Markdown 渲染的输出结构与消毒边界。
 * 设计说明：只断言渲染结果中的关键结构，不锁定 marked 的具体 HTML 细节。
 * 维护提示：渲染选项或消毒规则变化时，应同步调整这些场景。
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders the GFM blocks that appear in Explorer messages", () => {
    const html = renderMarkdown([
      "## 问题清单",
      "",
      "**A 类：准确性错误**",
      "",
      "- `BOOLEAN` 只是别名",
      "",
      "1. 第一项",
      "",
      "> 引用",
      "",
      "---",
    ].join("\n"));

    expect(html).toContain("<h2");
    expect(html).toContain("问题清单");
    expect(html).toContain("<strong>A 类：准确性错误</strong>");
    expect(html).toContain("<code>BOOLEAN</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr");
  });

  it("renders fenced code, tables and task lists", () => {
    const html = renderMarkdown([
      "```sql",
      "SELECT 1;",
      "```",
      "",
      "| # | 位置 | 问题 |",
      "| --- | --- | --- |",
      "| A1 | L32 | 类型错误 |",
      "",
      "- [x] 已完成",
      "- [ ] 待处理",
    ].join("\n"));

    expect(html).toContain('class="language-sql"');
    expect(html).toContain("SELECT 1;");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>位置</th>");
    expect(html).toContain("<td>类型错误</td>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("disabled");
  });

  it("opens links in a new tab with a safe rel", () => {
    const html = renderMarkdown("[文档](https://example.com/docs)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps plain text without markdown intact", () => {
    const html = renderMarkdown("普通文本 没有 markdown");

    expect(html).toContain("普通文本 没有 markdown");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<table>");
  });

  it("removes scripts, event handlers, images and unsafe links", () => {
    const html = renderMarkdown([
      "<script>alert(1)</script>",
      "",
      "<img src=x onerror=alert(1)>",
      "",
      "[危险](javascript:alert(1))",
      "",
      "[数据](data:text/html;base64,PHNjcmlwdD4=)",
    ].join("\n"));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
