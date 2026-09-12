/**
 * 测试职责：校验 Run 详情页执行对话的 Markdown 渲染装配。
 * 设计说明：只做组件源码级断言，运行行为由 MarkdownMessage 单测覆盖。
 * 维护提示：执行对话渲染方式变化时，应同步调整这里的断言。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runDetailSource = readFileSync(fileURLToPath(new URL("./RunDetailView.vue", import.meta.url)), "utf8");

describe("Run detail execution conversation", () => {
  it("renders executor model and guidance text through the shared Markdown component", () => {
    expect(runDetailSource).toContain('import MarkdownMessage from "../components/MarkdownMessage.vue"');
    expect(runDetailSource).toContain("<MarkdownMessage v-if=\"item.kind === 'model' || item.kind === 'guidance'\" :source=\"item.content\" :streaming=\"item.status === 'RUNNING'\" />");
    expect(runDetailSource).not.toContain("{{ item.content }}<span v-if=\"item.status === 'RUNNING'\"");
  });

  it("keeps execution activity details as plain text", () => {
    expect(runDetailSource).toContain('class="execution-activity-detail"');
  });
});
