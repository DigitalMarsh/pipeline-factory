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

  it("supports embedding the complete Run surface inside an Explorer conversation", () => {
    expect(runDetailSource).toContain("defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>");
    expect(runDetailSource).toContain("defineEmits<{ (event: \"close\"): void }>");
    expect(runDetailSource).toContain("detail-page-embedded");
    expect(runDetailSource).toContain("@click=\"closeView\"");
  });

  it("hides the standalone navigation header in embedded Run mode", () => {
    expect(runDetailSource).toContain('<div v-if="!embedded" class="detail-top">');
  });

  it("uses the compact execution header as the details entry point", () => {
    expect(runDetailSource).toContain('import ExecutionHeaderStatus from "../components/ExecutionHeaderStatus.vue"');
    expect(runDetailSource).toContain("<ExecutionHeaderStatus");
    expect(runDetailSource).toContain('@focus-task="focusExecutionTask"');
    expect(runDetailSource).toContain('@run-action="handleRunAction"');
    expect(runDetailSource).toContain('@loop-action="handleLoopAction"');
    expect(runDetailSource).toContain('@open-diagnostics="diagnosticsOpen = true"');
    expect(runDetailSource).not.toContain('class="run-actions"');
    expect(runDetailSource).not.toContain('class="execution-telemetry-panel"');
    expect(runDetailSource).not.toContain('class="execution-steps-panel"');
    expect(runDetailSource).not.toContain('class="agent-loop-detail"');
    expect(runDetailSource).not.toContain('class="evidence-card"');
    expect(runDetailSource).not.toContain('class="diagnostics-teaser"');
    expect(runDetailSource).toContain('class="execution-conversation-panel"');
  });

  it("keeps the execution title focused and opens the current Plan revision read only", () => {
    expect(runDetailSource).toContain('import PlanDetailDrawer from "../components/PlanDetailDrawer.vue"');
    expect(runDetailSource).toContain('class="execution-plan-link"');
    expect(runDetailSource).toContain("api.getPlan(currentRun.planId)");
    expect(runDetailSource).toContain("api.planRevisions(currentRun.planId)");
    expect(runDetailSource).toContain("api.getPlanRevision(currentRun.planId, currentRun.planRevision)");
    expect(runDetailSource).toContain(':read-only="true"');
    expect(runDetailSource).not.toContain("RUN · {{ run.id }}");
    expect(runDetailSource).not.toContain("EXECUTION THREAD");
    expect(runDetailSource).not.toContain("· <code>{{ run.branch }}</code>");
  });

  it("routes status-card Plan actions and keeps stale Plan drawers isolated", () => {
    expect(runDetailSource).toContain('@open-plan="openPlanDetail"');
    expect(runDetailSource).toContain("function resetPlanDetail()");
    expect(runDetailSource).toContain("watch([projectId, runId], () => { resetPlanDetail();");
    expect(runDetailSource).toContain("let planDetailRequestToken = 0;");
  });

  it("keeps the title and Plan in the first column of the two-row header grid", () => {
    expect(runDetailSource).toContain('class="detail-heading-title"');
    expect(runDetailSource).toContain('class="detail-heading-plan"');
    expect(runDetailSource).toContain("<h1>Execution run</h1>");
    expect(runDetailSource).toContain('class="execution-plan-link"');
    expect(runDetailSource).not.toContain('class="detail-heading-copy"');
  });
});
