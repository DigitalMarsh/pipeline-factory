/**
 * 测试职责：校验 Run 详情页执行对话的 Markdown 渲染装配。
 * 设计说明：只做组件源码级断言，运行行为由 MarkdownMessage 单测覆盖。
 * 维护提示：执行对话渲染方式变化时，应同步调整这里的断言。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runDetailSource = readFileSync(fileURLToPath(new URL("./RunDetailView.vue", import.meta.url)), "utf8");
const runDetailStyles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("Run detail execution conversation", () => {
  it("renders executor model and guidance text through the shared Markdown component", () => {
    expect(runDetailSource).toContain('import MarkdownMessage from "../components/MarkdownMessage.vue"');
    expect(runDetailSource).toContain('<template v-else-if="item.kind === \'model\'">');
    // 你自己说的话不走卡片、也不带头像：Codex 那种「› + 纯文本」，仍然靠右。
    expect(runDetailSource).toContain('class="execution-user-mark"');
    expect(runDetailSource).toContain('<div v-if="item.kind !== \'user\'" class="execution-message-avatar">');
    expect(runDetailSource).toContain('<MarkdownMessage :source="item.content" :streaming="item.status === \'RUNNING\'" />');
    expect(runDetailSource).not.toContain("{{ item.content }}<span v-if=\"item.status === 'RUNNING'\"");
  });

  it("呈现方式的判据不是白名单：新增一种就不会有消息从会话里消失", () => {
    // `text`（你自己说的话）就是这么漏过一次的——`visibleItems` 当时写死"属于 card 或 line"，
    // 于是那类消息在页面上直接不见了，而类型、模板、样式都对着。
    expect(runDetailSource).toContain('return mode !== "folded" && mode !== "hidden";');
    expect(runDetailSource).not.toContain('return mode === "card" || mode === "line";');
  });

  it("keeps execution activity details as plain text", () => {
    expect(runDetailSource).toContain('class="execution-activity-detail"');
  });

  it("supports embedding the complete Run surface and opening Plan in the shared drawer", () => {
    expect(runDetailSource).toContain("defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>");
    expect(runDetailSource).toContain('defineEmits<{ (event: "close"): void; (event: "open-plan", plan: Plan): void }>()');
    expect(runDetailSource).toContain("detail-page-embedded");
    expect(runDetailSource).toContain('emit("open-plan", planDetail.value)');
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
    expect(runDetailSource).not.toContain("open-diagnostics");
    expect(runDetailSource).not.toContain('class="run-actions"');
    expect(runDetailSource).not.toContain('class="execution-telemetry-panel"');
    expect(runDetailSource).not.toContain('class="execution-steps-panel"');
    expect(runDetailSource).not.toContain('class="agent-loop-detail"');
    expect(runDetailSource).not.toContain('class="evidence-card"');
    expect(runDetailSource).not.toContain('class="diagnostics-teaser"');
    expect(runDetailSource).toContain('class="execution-conversation-panel"');
  });

  it("renders the shared Provider footer with execution telemetry Context", () => {
    expect(runDetailSource).toContain('import ProviderUsageFooter from "../components/ProviderUsageFooter.vue"');
    expect(runDetailSource).toContain('formatProviderContextUsage');
    expect(runDetailSource).toContain('const executionContextUsage = computed(() => formatProviderContextUsage(executionTelemetry.value?.usage?.inputTokens));');
    // 模型/agent 由"本次记录优先、否则用这次 Run 冻结的配置"回答——遥测要这一轮跑完才有值，
    // 运行中只读 telemetry 会得到一片"未记录"。
    expect(runDetailSource).toContain('resolveExecutionModelIdentity(executionTelemetry.value, executionExecutorConfig.value, modelCatalog.value)');
    // 项目没覆盖 backend 时快照里是 null，生效的是该角色的全局后端——不回退这步运行中 AGENT 一栏是空的。
    expect(runDetailSource).toContain('backend: configured?.backend ?? roleBackend');
    expect(runDetailSource).toContain('<ProviderUsageFooter :model="executionModelIdentity.model" :backend="executionModelIdentity.backend" :context="executionContextUsage" context-note="仅结束时由 provider 上报" :source-note="executionModelSourceNote" />');
  });

  it("puts my messages on the right and collapses provider diagnostics", () => {
    // 左右分栏：我的消息（role=user）靠右，执行者的靠左。
    expect(runDetailSource).toContain("mine: item.role === 'user'");
    // 诊断字段默认收起（Turn #/Call/Provider item/Provider session），hover 与"详情"里才看得到。
    expect(runDetailSource).toContain(':title="executionMessageDiagnosticsTitle(item)"');
    expect(runDetailSource).toContain('v-if="executionMessageDetails(item).length"');
    expect(runDetailSource).toContain('class="execution-message-toggle"');
    expect(runDetailSource).toContain('v-if="isExecutionItemExpanded(item.id)"');
    // 常驻元信息里不再直接铺这些字段。
    expect(runDetailSource).not.toContain("Turn #{{ item.modelStep }}");
    expect(runDetailSource).not.toContain("Provider item {{ item.providerItemId }}");
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

  it("collapses a task group from its heading and separates tasks with a rule instead of a rail", () => {
    // 步骤头本身是折叠开关：整条可点、带 aria-expanded，收起的是这一组的消息。
    expect(runDetailSource).toContain('<button v-if="group.task" type="button" class="execution-task-stream-heading"');
    expect(runDetailSource).toContain(':aria-expanded="!isTaskGroupCollapsed(group.id)"');
    expect(runDetailSource).toContain('@click="toggleTaskGroup(group.id)"');
    expect(runDetailSource).toContain('class="execution-task-stream-items"');
    // 从状态卡跳到被收起的步骤时先展开，否则"跳过去"看着像没反应。
    expect(runDetailSource).toContain("expandTaskGroup(`task-${task.id}`)");
    // 左边那根竖线不再回来（它把整组往右推 53px）：任务之间用一条横线分段。
    expect(runDetailStyles).not.toMatch(/\.execution-conversation-group-task \{[^}]*border-left/);
    expect(runDetailStyles).toMatch(/\.execution-conversation-group-task[^{]*\{[^}]*border-top: 2px solid/);
  });

  it("projects the frozen Plan Revision as the first conversation message", () => {
    expect(runDetailSource).toContain('type ExecutionPlanSnapshot');
    expect(runDetailSource).toContain('executionPlan.value = executionPlanSnapshot(response.run, revisionResponse.revision)');
    expect(runDetailSource).toContain('projectExecutionJournal(currentThread?.journal ?? [], currentThread?.state ?? run.value?.status ?? "ACTIVE", executionPlan.value ?? undefined)');
    expect(runDetailSource).toContain('class="execution-plan-message"');
    expect(runDetailSource).toContain('class="execution-plan-toggle"');
    expect(runDetailSource).toContain('View full plan');
  });

  it("uses a persistent Explorer-style composer for execution messages", () => {
    expect(runDetailSource).toContain('import { shouldSubmitComposer } from "../utils/composerKeyboard"');
    expect(runDetailSource).toContain('const executionDraft = ref("")');
    expect(runDetailSource).toContain('const canSendExecutionMessage = computed(() => Boolean(thread.value && !["CANCELLED", "COMPLETED"].includes(thread.value.state)))');
    expect(runDetailSource).toContain('class="execution-conversation-stage"');
    expect(runDetailSource).toContain('class="composer execution-composer"');
    expect(runDetailSource).toContain('placeholder="与执行线程沟通，或提出修改…"');
    expect(runDetailSource).toContain('<span class="composer-mode">Run Mode</span>');
    expect(runDetailSource).toContain('@keydown="handleExecutionComposerKeydown"');
    expect(runDetailSource).toContain('function handleExecutionComposerKeydown(event: KeyboardEvent): void');
    expect(runDetailSource).toContain('class="composer-send"');
    expect(runDetailSource).toContain('aria-label="Send message"');
    expect(runDetailSource).toContain('context-note="仅结束时由 provider 上报"');
    expect(runDetailSource).not.toContain("guidanceComposerOpen");
    expect(runDetailSource).not.toContain('class="execution-guidance-shell"');
    expect(runDetailSource).not.toContain("Add guidance");
    expect(runDetailSource).not.toContain("Guidance is read-only");
  });

  it("把 Run 级活动移出执行会话：时间线只留执行步骤与你说的话", () => {
    // 判据是 "activity 且无 taskId"——不再按事件类型列举，否则每加一种 Run 级事件都要回来补。
    expect(runDetailSource).toContain("function isRunActivity(item: ExecutionStreamItem): boolean {");
    expect(runDetailSource).toContain('return item.kind === "activity" && !item.taskId;');
    // 它们改由顶部 RUN CONTEXT 卡片承载。
    expect(runDetailSource).toContain(':run-activity="runActivityItems"');
    // 旧标题与旧说明不再出现：它们把一个常态（Run 的创建 / 钩子 / 验证）写成了异常。
    // 断言的是标题元素本身，不是这四个字——注释里仍会引用旧名说明改了什么。
    expect(runDetailSource).not.toContain("<strong>未关联执行步骤</strong>");
    expect(runDetailSource).not.toContain("此处保留旧 Run 或未提供执行步骤标识的事件。");
    // 归因缺口组换名，模板与样式两侧一起改，不留死样式。
    expect(runDetailSource).toContain("group.kind === 'unattributed'");
    expect(runDetailSource).toContain("未归属事件");
    expect(runDetailStyles).toContain(".execution-unattributed-heading");
    expect(runDetailStyles).not.toContain(".execution-unassigned-heading");
    // 你在执行线程里发的消息独立成组：此前它挂在「未关联执行步骤」下面，
    // 等于把用户自己说的话标成了"没有归属的执行步骤"。
    expect(runDetailSource).toContain('groups.push({ id: "user", kind: "user", items: userMessages })');
    expect(runDetailStyles).toContain(".execution-conversation-group-user");
  });

  it("执行过程有阶段感，且呈现方式由一张表统一决定", () => {
    // 四阶段条：回答"现在在干什么、下一步是什么"——此前页面最缺的就是这一句。
    expect(runDetailSource).toContain('class="execution-phase-strip"');
    expect(runDetailSource).toContain("executionPhaseSteps");
    expect(runDetailStyles).toContain(".execution-phase.current");
    // **呈现方式不再散在视图里**：视图只问呈现方式表，那张表是那个"消息清单"的唯一落点。
    expect(runDetailSource).toContain("function visibleItems(group: ExecutionConversationGroup)");
    expect(runDetailSource).toContain("function foldedItems(group: ExecutionConversationGroup)");
    expect(runDetailSource).toContain("executionDisplayMode(item)");
    expect(runDetailSource).not.toContain("isActivityNoise");
    expect(runDetailStyles).toContain(".execution-folded-log");
    expect(runDetailStyles).not.toContain(".execution-activity-noise");
    // 折叠区是"过程记录"，不是"活动噪音"——措辞跟着语义走。
    expect(runDetailSource).toContain("条过程记录");
    // 连续的空执行步骤折成一行，只在**连续**时合并（中间夹着有内容的步骤要分开）。
    expect(runDetailSource).toContain("function collapsePendingTaskGroups");
    expect(runDetailSource).toContain('group.kind === "task" && group.task && group.items.length === 0');
    expect(runDetailSource).toContain("个执行步骤尚未开始");
  });
});
