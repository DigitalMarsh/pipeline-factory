import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
// 方案卡与行组件：**按形态分文件**，"这一行长什么样"要去各自的组件里看。
const explorerCandidatePlanCardSource = readFileSync(fileURLToPath(new URL("../components/ExplorerCandidatePlanCard.vue", import.meta.url)), "utf8");
const explorerTimelineSource = readFileSync(fileURLToPath(new URL("../utils/explorerTimeline.ts", import.meta.url)), "utf8");
// P7 第二级把这条投影链从视图搬进了 composable。下面的断言跟着代码走，
// **没有放宽**：正向断言改读新归属文件，负向断言（`syntheticPlanItems`）
// 在新旧两个文件上都必须成立，否则守卫会悄悄失效。
const explorerTimelineComposableSource = readFileSync(fileURLToPath(new URL("../composables/useExplorerTimeline.ts", import.meta.url)), "utf8");
// 同理，P7 第二级把会话状态与请求令牌守卫搬进了 useExplorerSession：
// 视图现在说 `invalidateProjectScope()`，原子句 `requestScope.invalidate()` 跟着代码
// 落到 composable 里。**两条都要断言**——只留视图那条，守卫就被削成"函数名还在"。
const explorerSessionComposableSource = readFileSync(fileURLToPath(new URL("../composables/useExplorerSession.ts", import.meta.url)), "utf8");
// 第三次出现同一类处置（P7-8）：输入请求整块搬进了 useExplorerInputRequests。
// 规则同前——**正向断言搬到 composable，视图这一侧换成委托语句，两条都留**。
const explorerInputRequestsComposableSource = readFileSync(fileURLToPath(new URL("../composables/useExplorerInputRequests.ts", import.meta.url)), "utf8");
// 第四次出现同一类处置（P7-9）：需求投影整块搬进了 usePlanProjection。
// 规则同前——**正向断言搬到 composable，视图这一侧换成委托语句，两条都留**。
const planProjectionComposableSource = readFileSync(fileURLToPath(new URL("../composables/usePlanProjection.ts", import.meta.url)), "utf8");
// 第五次出现同一类处置（P7-10）：Plan 生命周期写操作搬进了 usePlanLifecycleActions。
// 正向断言跟随 composable；视图保留动作解构与 template 的用户界面判据，两侧都留。
const planLifecycleActionsComposableSource = readFileSync(fileURLToPath(new URL("../composables/usePlanLifecycleActions.ts", import.meta.url)), "utf8");
const planDetailDrawerComposableSource = readFileSync(fileURLToPath(new URL("../composables/usePlanDetailDrawer.ts", import.meta.url)), "utf8");
// 第六次出现同一类处置（P7-11）：三条 SSE 通道与续传读侧搬进 useExplorerSse。
// 视图保留连接/断连方法的委托，EventSource 实例与 handler 不得回流。
const explorerSseComposableSource = readFileSync(fileURLToPath(new URL("../composables/useExplorerSse.ts", import.meta.url)), "utf8");
const explorerScopeSource = readFileSync(fileURLToPath(new URL("../utils/explorerScope.ts", import.meta.url)), "utf8");
const threadRailSource = readFileSync(fileURLToPath(new URL("../components/ThreadRail.vue", import.meta.url)), "utf8");
const explorerHeaderStatusSource = readFileSync(fileURLToPath(new URL("../components/ExplorerHeaderStatus.vue", import.meta.url)), "utf8");
const providerUsageFooterSource = readFileSync(fileURLToPath(new URL("../components/ProviderUsageFooter.vue", import.meta.url)), "utf8");
const projectCatalogSource = readFileSync(fileURLToPath(new URL("./ProjectCatalogView.vue", import.meta.url)), "utf8");

describe("Explorer thread actions", () => {
  it("uses a real dropdown menu with pause, rename, policy and refresh actions", () => {
    expect(explorerViewSource).not.toContain("thread-banner");
    expect(explorerViewSource).not.toContain("showThreadBanner");
    expect(explorerViewSource).not.toContain("dismissThreadBanner");
    expect(threadRailSource).toContain("<el-dropdown");
    expect(threadRailSource).toContain('popper-class="thread-action-popper"');
    expect(threadRailSource).toContain('command="rename"');
    expect(threadRailSource).toContain('command="policy"');
    expect(threadRailSource).toContain('command="refresh"');
    expect(threadRailSource).toContain('command="toggle-pause"');
    expect(threadRailSource).not.toContain('command="new-requirement"');
    expect(threadRailSource).toContain('command="delete"');
    expect(threadRailSource).toContain("删除线程");
    expect(threadRailSource).toContain("thread-action-danger");
    expect(explorerViewSource).not.toContain("<el-dropdown");
    expect(explorerViewSource).not.toContain('class="conversation-tools"');
    expect(explorerViewSource).toContain('if (command === "toggle-pause")');
    expect(explorerViewSource).toContain('if (command === "delete")');
    expect(explorerViewSource).toContain("api.deleteExplorer");
    expect(explorerViewSource).toContain("永久删除线程");
    expect(explorerViewSource).toContain("const loaded = await load();");
    expect(explorerViewSource).toContain("替代线程详情加载失败，请点击 Retry");
    expect(explorerViewSource).not.toContain("loadExplorerDetails(response.replacementExplorer");
    expect(explorerViewSource).toContain("suppressNextExplorerRouteReload");
    expect(threadRailSource).toContain('props.explorerPaused ? "恢复循环" : "暂停循环"');
    expect(threadRailSource).toContain("线程操作");
    expect(threadRailSource).toContain("重命名线程");
    expect(threadRailSource).toContain("查看策略");
    expect(threadRailSource).toContain("刷新线程");
    expect(explorerViewSource).toContain("ExplorerRenameDialog");
    expect(explorerViewSource).toContain("api.renameExplorer");
    expect(explorerViewSource).not.toContain("Manage read-only exploration without changing the repository.");
    expect(explorerViewSource).not.toContain("thread-more-menu");
  });

  it("provides focused styling hooks for the dropdown action rows", () => {
    expect(explorerStylesSource).toContain(".thread-action-popper");
    expect(explorerStylesSource).toContain(".thread-action-menu-item");
    expect(explorerStylesSource).toContain(".thread-action-danger");
    expect(explorerStylesSource).toContain("focus-visible");
  });
});

describe("Provider usage footer wiring", () => {
  it("uses the shared footer and shows only model/context facts", () => {
    expect(explorerViewSource).toContain('import ProviderUsageFooter from "../components/ProviderUsageFooter.vue"');
    expect(explorerViewSource).toContain('<ProviderUsageFooter :model="explorerModel" :backend="explorerBackendLabel" :context="contextUsage" context-note="estimated" />');
    expect(explorerViewSource).not.toContain('class="codex-status-popover"');
    expect(explorerViewSource).not.toContain("formatConversationId");
    // 5 小时 / 7 天额度已从页面与后端两侧移除，页面上不该再有它的任何痕迹（防回归）。
    // 先剥掉注释再断言：组件里那段"为什么删"的说明**故意**写着"5 小时限额 / 7 天限额"，
    // 它是要留下的事实，不能算痕迹；真正的痕迹在模板与脚本里。
    const providerUsageFooterMarkup = providerUsageFooterSource.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(providerUsageFooterMarkup).not.toContain("限额");
    expect(providerUsageFooterMarkup).not.toContain("codexRateLimits");
    expect(providerUsageFooterSource).not.toContain('class="provider-usage-limits"');
    expect(providerUsageFooterSource).not.toContain("provider-usage-status-trigger");
    expect(providerUsageFooterSource).not.toContain("el-popover");
    expect(providerUsageFooterSource).not.toContain("会话/对话串");
  });
});

describe("Explorer project selector wiring", () => {
  it("loads the project catalog and delegates thread navigation", () => {
    expect(explorerViewSource).toContain("api.projects()");
    expect(explorerViewSource).toContain(":panel=\"leftPanel\"");
    expect(explorerViewSource).toContain(":projects=\"projects\"");
    expect(explorerViewSource).toContain(":explorers=\"explorers\"");
    expect(explorerViewSource).toContain(":show-archived=\"showArchivedExplorers\"");
    expect(explorerViewSource).toContain(":explorer-action-id=\"explorerActionId\"");
    expect(explorerViewSource).toContain("@thread-action=\"handleThreadAction\"");
    expect(explorerViewSource).toContain("@select-panel=\"leftPanel = $event\"");
    expect(explorerViewSource).toContain("@select-project=\"switchProject\"");
    expect(explorerViewSource).toContain("@select-explorer=\"selectExplorer\"");
    expect(explorerViewSource).toContain("@toggle-show-archived=\"showArchivedExplorers = $event\"");
    expect(explorerViewSource).toContain("@archive-explorer=\"toggleExplorerArchive\"");
    expect(explorerViewSource).toContain("@create-explorer=\"createExplorer\"");
    expect(explorerViewSource).toContain("@create-project=\"openProjectCreateDialog\"");
    expect(explorerViewSource).toContain("@open-project=\"switchProject\"");
    expect(explorerViewSource).not.toContain(":requirements=\"explorerPlans\"");
    expect(explorerViewSource).not.toContain("@select-plan-center=");
    expect(explorerViewSource).not.toContain("@select-explorer-plan=");
  });

  it("renders Explorer threads inline without the history drawer", () => {
    expect(threadRailSource).toContain("explorer-list");
    expect(threadRailSource).toContain('class="left-panel-create"');
    expect(explorerViewSource).not.toContain("ExplorerHistoryDrawer");
    expect(explorerViewSource).not.toContain("historyOpen");
    expect(explorerViewSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("thread-identity");
  });
});

describe("Explorer requirement list and shared drawer", () => {
  it("shows the selected thread requirement projection in the center and removes old context panels", () => {
    expect(explorerViewSource).toContain('import ExplorerRequirementList from "../components/ExplorerRequirementList.vue"');
    expect(explorerViewSource).toContain('<ExplorerRequirementList');
    expect(explorerViewSource).toContain(":rows=\"requirementRows\"");
    expect(explorerViewSource).toContain('@add="openAddRequirementDialog"');
    expect(explorerViewSource).toContain('@explore="openRequirementChat"');
    expect(explorerViewSource).toContain('@view-plan="openRequirementPlan"');
    expect(explorerViewSource).toContain('@open-task="openRequirementTask"');
    expect(explorerViewSource).toContain("projectExplorerRequirementRows(");
    // ac4d794 把独立的 Plan Center 面板并进了需求工作区；那个组件本身已经删除，
    // 这条守卫现在的意思是**不要再长出第二套 Plan 中心**（与下面两条旧上下文面板同理）。
    expect(explorerViewSource).not.toContain("<PlanCenterPanel");
    expect(explorerViewSource).not.toContain('class="context-panel-shell"');
    expect(explorerViewSource).not.toContain('class="context-entry-rail"');
  });

  it("uses one shared drawer for Explorer chat, full Plan detail, and Run", () => {
    expect(explorerViewSource).toContain('import PlanDetailContent from "../components/PlanDetailContent.vue"');
    expect(explorerViewSource).toContain('import RunDetailView from "./RunDetailView.vue"');
    expect(explorerViewSource).toContain('const activeRunId = computed(() => typeof route.query.runId === "string" ? route.query.runId : null)');
    expect(explorerViewSource).toContain('<PlanDetailContent');
    expect(explorerViewSource).toContain('<RunDetailView v-if="activeRunId"');
    expect(explorerViewSource).toContain('@close="closeRunView"');
    expect(explorerViewSource).toContain('role="tablist" aria-label="需求详情类型"');
    expect(explorerViewSource).toContain("探索对话");
    expect(explorerViewSource).toContain("Plan 详情");
    expect(explorerViewSource).toContain("Run");
    expect(explorerViewSource).toContain("delete query.runId");
    expect(explorerViewSource).toContain('@open-plan="openPlanDetail"');
  });

  it("shows the selected Plan immediately while full details load and ignores stale detail responses", () => {
    // 抽屉详情已抽到 composable（P7 第三级），断言跟着搬过去——校验的性质不变：
    // 先把已知的 Plan 落进抽屉再等接口，以及用请求代际丢弃过期响应。
    const openPlanDetailSource = planDetailDrawerComposableSource.match(/async function openPlanDetail\(plan: Plan\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(openPlanDetailSource).toContain("detailPlan.value = plan");
    expect(openPlanDetailSource.indexOf("detailPlan.value = plan")).toBeLessThan(openPlanDetailSource.indexOf("await api.getPlan(planId)"));
    expect(openPlanDetailSource).toContain("requestVersion === detailRequestVersion");
    expect(openPlanDetailSource).toContain("currentRevisionDraft.status !== \"CONFIRMED\"");
    expect(openPlanDetailSource).toContain("detailPlan.value = deps.planFromRevisionDraft(currentRevisionDraft)");
    expect(openPlanDetailSource).toContain("const generatedSpec = response.plan.generatedSpec ?? plan.generatedSpec");
  });

  it("creates a requirement once and keeps failed first messages available for retry", () => {
    expect(explorerViewSource).toContain("async function openAddRequirementDialog()");
    expect(explorerViewSource).toContain("api.createExplorerPlan(projectId.value, currentThread.id)");
    expect(explorerViewSource).toContain("await sendTurn()");
    expect(explorerViewSource).toContain("async function sendTurn(): Promise<boolean>");
    expect(explorerViewSource).toContain("failedExplorerSends");
    expect(explorerViewSource).toContain("clientTurnId");
    expect(explorerViewSource).toContain("draft.value = content");
  });

  it("warns inline when the card is a conversation artifact", () => {
    // 对话产物确认后进不了执行：卡片上（方案卡只有助手消息里那一处）在按钮旁边就说清，
    // 而不是等人切到 Run 页签。原先还有一张独立的 PLAN CREATED 卡也带这条警告，那张卡已删除。
    expect(explorerCandidatePlanCardSource).toContain('v-if="conversationArtifact" class="candidate-notice"');
    expect(explorerViewSource).not.toContain("plan-created-event");
  });

  it("preserves confirm and enqueue order while opening the task tab", () => {
    // P7-10：写操作的正向守卫跟随 composable，视图这一侧锁住"组合根把六个动作
    // 接回来"；模板里的 task drawer 与对话产物文案仍由视图锁住。
    expect(planLifecycleActionsComposableSource).toContain("async function confirmPlan(plan: Plan | null = deps.candidate.value)");
    expect(planLifecycleActionsComposableSource).toContain("api.confirmPlan(");
    // 抽屉里的 "Confirm V2" 必须确认**它显示的那一版**：已确认 Plan 上挂修订草稿时
    // `candidate` 是 null，回落到 candidate 会让按钮静默失效。
    expect(explorerViewSource).toContain("@confirm=\"confirmPlan(detailPlan)\"");
    expect(explorerViewSource).toContain("@discard=\"discardPlan(detailPlan)\"");
    expect(planLifecycleActionsComposableSource).toContain("async function enqueuePlan(");
    expect(planLifecycleActionsComposableSource).toContain("api.enqueuePlan(id)");
    expect(planLifecycleActionsComposableSource).toContain("if (isConversationArtifactPlan(plan))");
    expect(planLifecycleActionsComposableSource).toContain("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    expect(planLifecycleActionsComposableSource).toContain("async function startPlanRun(plan: Plan): Promise<void>");
    expect(planLifecycleActionsComposableSource).toContain("async function revisePlanConfiguration(plan: Plan): Promise<void>");
    expect(planLifecycleActionsComposableSource).toContain("function handlePlanCenterConfigurationRevised(): void");
    expect(planLifecycleActionsComposableSource).toContain("async function discardPlan(plan: Plan | null = deps.candidate.value)");
    expect(explorerViewSource).toContain("const { confirmPlan, enqueuePlan, startPlanRun, revisePlanConfiguration, discardPlan } = usePlanLifecycleActions(");
    expect(explorerViewSource).toContain('drawerTab.value = "task"');
    expect(explorerViewSource).toContain("taskPanelPlan.status === 'READY' && isConversationArtifactPlan(taskPanelPlan)");
    expect(explorerViewSource).toContain("返回探索对话修订");
    expect(explorerViewSource).toContain("此 Plan 是对话产物，不能入队执行。");
    expect(explorerViewSource).toContain("taskPanelPlan.status === 'READY'");
    expect(explorerViewSource).toContain("入队和开始运行是两个独立步骤。");
  });

  it("routes drawer tabs to the selected requirement's existing Plan and Run", () => {
    const switchTabSource = explorerViewSource.match(/function switchDrawerTab\(tab: SharedDrawerTab\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(switchTabSource).toContain("void openPlanDetail(selectedRequirementRow.value.plan)");
    expect(switchTabSource).toContain("row?.run?.id ?? row?.plan?.runId ?? row?.plan?.dispatch?.runId");
    expect(switchTabSource).toContain("void openRunView(runId, thread.value?.id, row?.explorerPlan.id)");
  });
});

describe("Explorer thread and drawer state", () => {
  it("keeps thread navigation separate and preserves the per-thread selected requirement", () => {
    expect(explorerViewSource).toContain('type LeftPanel = "projects" | "explorers"');
    expect(explorerViewSource).toContain('const leftPanel = ref<LeftPanel>("explorers")');
    expect(explorerViewSource).toContain("function explorerRouteQuery");
    expect(explorerViewSource).toContain("query.explorerPlanId");
    expect(explorerViewSource).toContain("selected.activeExplorerPlanId");
    expect(explorerViewSource).toContain("explorerPlans.value[0]?.id ?? null");
    expect(explorerViewSource).toContain("function resetThreadState()");
    expect(explorerViewSource).toContain("drawerOpen.value = false");
    expect(explorerViewSource).toContain('drawerTab.value = "explorer"');
  });

  it("closes and clears the drawer when switching threads", () => {
    // 切换线程时抽屉必须清空。这条性质现在跨两个文件：视图的 resetThreadState 委托，
    // composable 的 resetDetailState 执行——两半都要断言，只测一半会让另一半能悄悄漏掉。
    const resetSource = explorerViewSource.match(/function resetThreadState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("resetDetailState()");
    const resetDetailSource = planDetailDrawerComposableSource.match(/function resetDetailState\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(resetDetailSource).toContain("drawerOpen.value = false");
    expect(resetDetailSource).toContain("detailPlan.value = null");
    // 同时作废在途请求，否则切换线程后旧线程的响应会回填进新线程的抽屉。
    expect(resetDetailSource).toContain("detailRequestVersion += 1");
    expect(explorerViewSource).toContain("function selectExplorer(explorerId: string)");
    expect(explorerViewSource).toContain("void reloadSelectedExplorer()");
  });
});

describe("Explorer requirement actions", () => {
  it("does not offer an unrelated manual candidate creation action", () => {
    expect(explorerViewSource).not.toContain("candidateEmptyOpen");
    expect(explorerViewSource).not.toContain("candidateTitle");
    expect(explorerViewSource).not.toContain("createCandidate");
    expect(explorerViewSource).not.toContain("api.createExplorerCandidate");
  });
});

describe("Explorer rail layout", () => {
  it("uses a two-column shell and adapts the requirement list for narrow screens", () => {
    expect(explorerStylesSource).toContain(".left-entry-rail");
    expect(explorerStylesSource).toContain(".console-layout { grid-template-columns: 330px minmax(0, 1fr); }");
    expect(explorerStylesSource).toContain(".shared-drawer-shell");
    expect(explorerStylesSource).toContain(".shared-drawer-tabs");
    expect(explorerStylesSource).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.shared-drawer-header/);
    expect(explorerStylesSource).toContain(".timeline { flex: 1 1 auto;");
    expect(explorerStylesSource).toContain(".composer { flex: 0 0 auto;");
  });

  it("narrow screens collapse the rail to its icon strip instead of squeezing the panel", () => {
    // ≤720px 时左列只有 58px，只装得下图标栏。此前只改了外层列宽、没管 rail 内部的
    // `64px minmax(0,1fr)`：面板列被挤到 0 宽而内容照常溢出，那条「项目执行线程」入口
    // 变成十几像素的竖条、还被中栏盖住，窄屏下根本点不到。两条要一起在。
    expect(explorerStylesSource).toContain(".console-layout:not(.project-execution-mode) .thread-rail { grid-template-columns: minmax(0, 1fr); }");
    expect(explorerStylesSource).toContain(".console-layout:not(.project-execution-mode) .thread-rail .left-panel { display: none; }");
  });
});

describe("Explorer inline message presentation", () => {
  it("用户消息是「› + 纯文本」的一行，靠右，不再是可以折叠的卡片", () => {
    expect(threadRailSource).not.toContain("<el-tree");
    expect(threadRailSource).not.toContain("explorer-thread-tree");
    expect(threadRailSource).not.toContain('command="new-requirement"');
    expect(explorerViewSource).toContain("activityMode(item.activity) === 'text'");
    expect(explorerViewSource).toContain('class="timeline-user-mark"');
    // 卡片那一套（头像 + 首行摘要 + 展开按钮）已经删掉：用户输入是一行原文，不是一份要点提要。
    expect(explorerViewSource).not.toContain("user-message-summary");
    expect(explorerViewSource).not.toContain("isUserMessageExpanded");
    expect(explorerStylesSource).not.toContain(".user-message-summary");
    // 我的消息靠右（与执行线程的 `.execution-message.mine` 同一套读法）：那个 `auto` 左外边距掉了
    // 就会悄悄退回左对齐——那不是"没样式"，是读起来像两个人在同一侧说话。
    expect(explorerStylesSource).toMatch(/\.timeline-user-text \{[^}]*margin: 0 0 18px auto;/);
  });

  it("centers the latest-message prompt within the chat timeline", () => {
    expect(explorerViewSource).toContain('class="scroll-to-latest"');
    expect(explorerStylesSource).toMatch(/\.scroll-to-latest \{[^}]*left: 50%;[^}]*right: auto;[^}]*transform: translateX\(-50%\);/);
  });

  it("renders each bound plan only in its generating assistant message", () => {
    expect(explorerTimelineComposableSource).toContain("const planBindings = computed(() => buildPlanActivityBindings");
    expect(explorerTimelineComposableSource).toContain("const activeTaskPlans = computed<Plan[]>(() => deps.allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId)))");
    expect(explorerTimelineComposableSource).toContain("buildPlanActivityBindings(activeTaskPlans.value, visibleActivity.value)");
    expect(explorerTimelineComposableSource).toContain("buildExplorerTimeline(visibleActivity.value, visibleInputRequests.value)");
    expect(explorerTimelineComposableSource).not.toContain("syntheticPlanItems");
    // 方案卡只挂在产出它的那条助手消息里；此前还有一条"绑不上就单独渲染一张 PLAN CREATED 卡"
    // 的时间线分支，现代代码里绑不上是不可能的，已删除（见 docs/消息类型及事件状态机流程图.md）。
    expect(explorerTimelineComposableSource).not.toContain("detachedPlans");
    expect(explorerViewSource).not.toContain("item.kind === 'plan'");
    expect(explorerViewSource).not.toContain("plan-created-event");
    expect(explorerViewSource).toContain('v-if="showCandidatePlanCard && planForActivity(item.activity)"');
    expect(explorerViewSource).not.toContain("syntheticPlanItems");
    expect(explorerViewSource).not.toContain("v-for=\"item in syntheticPlanItems\"");
  });

  it("时间线的显隐与内嵌方案卡都问同一张清单表", () => {
    // 呈现方式表（`EXPLORER_DISPLAY_MODES`）必须是**唯一**的判据：模板里再自己写一遍
    // "哪些 kind 要显示"，就等于把表绕过去了——改表不再生效，而且没人会发现。
    expect(explorerViewSource).toContain('v-for="(item, index) in renderedTimelineItems"');
    expect(explorerViewSource).toContain("explorerDisplayMode(explorerTimelineMessageType(item))");
    expect(explorerViewSource).toContain('explorerDisplayMode("CANDIDATE_PLAN")');
    expect(explorerViewSource).not.toContain('v-for="(item, index) in timelineItems"');
    // 被输入卡取代的那两类生命周期行只写在表里（和投影层），视图不该认得它们的名字。
    expect(explorerViewSource).not.toContain("INPUT_REQUIRED");
    expect(explorerViewSource).not.toContain("INPUT_RESOLVED");
  });

  it("过程活动各走各的行组件，兜底会当场显示出来", () => {
    // 视图这一层只做一件事：按行型选分支。**摆哪些字段**在 `explorerActivityLine()`，
    // **长什么样**在各自的组件里（`components/Explorer*Row.vue`）——视图不再自己翻 kind 决定显示什么。
    expect(explorerViewSource).toContain("activityMode(item.activity) === 'reasoning'");
    expect(explorerViewSource).toContain("activityMode(item.activity) === 'divider'");
    expect(explorerViewSource).toContain("<ExplorerReasoningRow");
    expect(explorerViewSource).toContain("<ExplorerDividerRow");
    expect(explorerViewSource).toContain("<ExplorerActivityRow");
    // 兜底：行型掉到这里说明映射与模板没跟上，**当场显示**，不要静默渲染成一张裸卡。
    expect(explorerViewSource).toContain("timeline-unknown-row");
    expect(explorerStylesSource).toContain(".timeline-unknown-row");
    expect(explorerViewSource).not.toContain("activityKindLabel");
    expect(explorerStylesSource).toContain(".timeline-note");
    expect(explorerStylesSource).toContain(".timeline-divider-label");
    expect(explorerStylesSource).toContain(".activity-turn-status");
  });

  it("does not infer missing Task ownership and scopes Candidate refreshes", () => {
    // P7-8：归属判据随输入请求搬进 composable，**形参改名的部分是必要的**——
    // composable 收的是"已解析"的需求 id，解析链（activeExplorerPlan → thread →
    // explorerPlans[0]）留在视图。所以两侧各锁一条，缺任何一侧都盖不住回归。
    expect(explorerInputRequestsComposableSource).toContain("return belongsToExplorerPlan(planId, deps.activeExplorerPlanId.value);");
    expect(explorerViewSource).toContain("activeExplorerPlanId: computed(() => activeExplorerPlan.value?.id ?? null)");
    expect(explorerViewSource).not.toContain('(planId ?? explorerPlans.value[0]?.id) === activeId');
    expect(explorerViewSource).not.toContain('api.explorerCandidate(requestProjectId, explorerId, activeExplorerPlanId.value ?? undefined)');
    expect(explorerViewSource).not.toContain('api.explorerCandidate(requestProjectId, selected.id, selected.activeExplorerPlanId ?? undefined)');
    expect(explorerScopeSource).toContain('return itemPlanId === activePlanId;');
  });

  it("projects one accessible center row per current-thread requirement", () => {
    const listSource = readFileSync(fileURLToPath(new URL("../components/ExplorerRequirementList.vue", import.meta.url)), "utf8");
    // P7-9：投影状态与 workspace 加载搬进 usePlanProjection。正向断言跟着代码走，
    // 视图这一侧换成"解构了哪些状态"与"委托给了谁"（`api.explorerPlanWorkspace` 在视图里
    // 已经一个字都不剩，只断言"视图里没有"是不够的——那样空文件也能过）。
    expect(planProjectionComposableSource).toContain("const explorerPlans = ref<ExplorerPlan[]>([]);");
    expect(explorerViewSource).toContain("enqueued, explorerEventSequence, activeExplorerPlan, allPlans, planFromRevisionDraft, applyPlanProjection, loadActivePlanWorkspace, refreshPlanProjection");
    expect(explorerViewSource).toContain("api.explorerPlanGroups(requestProjectId, selected.id)");
    expect(explorerViewSource).toContain("api.createExplorerPlan(projectId.value, currentThread.id)");
    expect(planProjectionComposableSource).toContain("api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId)");
    expect(explorerViewSource).toContain("const workspaceLoaded = await loadActivePlanWorkspace(selected.id, activeExplorerPlanId.value, requestProjectId, requestToken)");
    expect(explorerViewSource).toContain("route.query.explorerPlanId");
    expect(explorerViewSource).toContain("const requirementRows = computed(() => projectExplorerRequirementRows(");
    expect(listSource).toContain('aria-label="当前探索线程的需求清单"');
    expect(listSource).toContain("row.planStatus.label");
    expect(listSource).toContain("row.taskStatus.label");
    expect(listSource).toContain("查看 V{{ row.plan.revision }}");
    expect(listSource).toContain("新增需求");
    expect(listSource).toContain("这个探索线程还没有需求");
    expect(explorerViewSource).toContain("requirementDrafts");
    expect(explorerViewSource).not.toContain('aria-label="Plan timeline"');
  });
});

describe("Explorer requirement and drawer styling", () => {
  it("styles the center list, shared drawer and actionable statuses", () => {
    expect(explorerStylesSource).toContain(".requirement-list-panel");
    expect(explorerStylesSource).toContain(".requirement-table-row");
    expect(explorerStylesSource).toContain(".shared-drawer-shell");
    expect(explorerStylesSource).toContain(".shared-drawer-tabs button:focus-visible");
    expect(explorerStylesSource).toContain(".task-action-panel");
  });
});

describe("Explorer thread switching", () => {
  it("reloads the current conversation when the selected thread changes", () => {
    expect(explorerViewSource).toContain("async function selectExplorer(explorerId: string)");
    expect(explorerViewSource).toContain("query: explorerRouteQuery(explorerId), hash: \"\" });");
    expect(explorerViewSource).toContain("void reloadSelectedExplorer();");
    // P7-9：workspace 加载的 API 调用搬进了 composable，视图这一侧只留委托调用。
    expect(planProjectionComposableSource).toContain("api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId)");
    expect(explorerViewSource).toContain("await loadActivePlanWorkspace(currentThread.id, selectedPlan.id, requestProjectId, requestToken)");
  });

  it("separates Explorer creation from turn busy state and clears stale thread data", () => {
    expect(explorerViewSource).toContain("const creatingExplorer = ref(false)");
    expect(explorerViewSource).toContain("if (creatingExplorer.value) return;");
    expect(explorerViewSource).not.toContain("async function createExplorer() {\n  if (busy.value) return;");
    expect(explorerViewSource).toContain("function resetThreadState()");
    expect(explorerViewSource).toContain("invalidateProjectScope();");
    expect(explorerSessionComposableSource).toContain("requestScope.invalidate();");
    // 线程级字段的清空已经搬进 composable，视图这一侧必须真的委托过去，
    // 而不是留着几个"看起来清过"的赋值。
    const resetSource = explorerViewSource.match(/function resetThreadState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("resetSessionState();");
    expect(resetSource).not.toContain("turns.value = []");
    expect(resetSource).not.toContain("activity.value = []");
    expect(explorerSessionComposableSource).toContain("turns.value = [];");
    expect(explorerSessionComposableSource).toContain("activity.value = [];");
    // P7-8 同一条处置：输入请求的四个清空赋值 + 两个对话框字段也搬走了。
    // 正负两侧都断言——只断言"composable 里有"，抓不到"视图里还留了一半"。
    expect(resetSource).toContain("resetInputState();");
    expect(resetSource).not.toContain("inputRequests.value = []");
    expect(resetSource).not.toContain("pendingInput.value = null");
    expect(resetSource).not.toContain("inputDialogOpen.value = false");
    expect(explorerInputRequestsComposableSource).toContain("inputRequests.value = [];");
    expect(explorerInputRequestsComposableSource).toContain("pendingInput.value = null;");
    expect(explorerInputRequestsComposableSource).toContain("inputDialogOpen.value = false;");
    // P7-9 同一条处置：投影的九个清空赋值与"让在途刷新作废"的世代自增也搬走了。
    // 同样正负两侧都断言——`planProjectionVersion` 在视图里必须一个字都不剩。
    expect(resetSource).toContain("resetPlanProjection();");
    expect(resetSource).not.toContain("explorerPlans.value = []");
    expect(resetSource).not.toContain("threadPlans.value = []");
    expect(resetSource).not.toContain("candidate.value = null");
    expect(resetSource).not.toContain("explorerEventSequence");
    expect(planProjectionComposableSource).toContain("explorerPlans.value = [];");
    expect(planProjectionComposableSource).toContain("activeExplorerPlanId.value = null;");
    expect(planProjectionComposableSource).toContain("beginPlanProjection();");
    expect(explorerViewSource).toContain(":creating-explorer=\"creatingExplorer\"");
  });

  it("keeps message navigation keys unique when a turn has multiple assistant activities", () => {
    // 锚点用**活动 id** 而不是 turnId：同一个回合里的多条助手活动因此各有各的锚点。
    expect(explorerTimelineSource).toContain("return `message-${item.id}`;");
    expect(explorerViewSource).toContain(':id="activityTarget(item.activity, index)"');
    expect(explorerViewSource).toContain(':data-nav-key="activityTarget(item.activity, index)"');
  });

  it("resets archived-thread visibility when switching projects", () => {
    expect(explorerViewSource).toContain('const showArchivedExplorers = ref(false)');
    expect(explorerViewSource).toContain('const explorerActionId = ref<string | null>(null)');
    const resetSource = explorerViewSource.match(/function resetProjectState\(nextProjectId = projectId\.value\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("showArchivedExplorers.value = false");
  });

  it("keeps the directory visible when a selected thread projection fails", () => {
    expect(explorerViewSource).toContain("const explorerLoading = ref(true)");
    expect(explorerViewSource).toContain("const explorerError = ref<string | null>(null)");
    expect(explorerViewSource).toContain("async function loadExplorerDetails");
    expect(explorerViewSource).toContain("async function loadExplorerDirectory");
    const loadCatch = explorerViewSource.match(/async function loadExplorerDirectory[\s\S]*?\n\}/)?.[0] ?? "";
    expect(loadCatch).not.toContain("explorers.value = []");
  });

  it("loads route-selected threads without reloading the whole directory", () => {
    expect(explorerViewSource).toContain("loadExplorerDetails");
    expect(explorerViewSource).toContain("watch(() => route.query.explorerId");
    expect(explorerViewSource).toContain("routeExplorerId === thread.value?.id");
    expect(explorerViewSource).not.toContain("watch(() => route.query.explorerId, () => { if (mounted.value) reloadExplorer(); });");
  });

  it("keeps thread loading compatible with API instances without confirmed-plan projection", () => {
    const detailSource = explorerViewSource.match(/async function loadExplorerDetails[\s\S]*?\n\}/)?.[0] ?? "";
    // P7-9：`refreshPlanProjection` 整块搬进了 usePlanProjection，这一侧改读新归属文件。
    // 注意：如果只把正则的搜索对象留在视图上，匹配不到时会得到空字符串，
    // **而下面那两条 `not.toContain` 会照样通过**——那才是这条守卫真正会悄悄失效的地方。
    const refreshSource = planProjectionComposableSource.match(/async function refreshPlanProjection[\s\S]*?\n\}/)?.[0] ?? "";
    expect(refreshSource).not.toBe("");
    expect(detailSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id))");
    expect(detailSource).toContain("confirmedResponse?.items ?? []");
    expect(refreshSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId))");
    expect(refreshSource).toContain("confirmedResponse?.items ?? []");
    // 视图这一侧换成"委托给了谁"+"旧写法不许长回来"。
    expect(explorerViewSource).toContain("applyPlanProjection(projection, confirmedResponse?.items ?? [], null)");
    // 只否掉**搬走的那一处**：视图的 `loadExplorerDetails` 仍然自己发这个可选请求
    // （它的 key 是 `selected.id`），否掉整个方法名会误伤。
    expect(explorerViewSource).not.toContain("api.explorerConfirmedPlans(requestProjectId, explorerId)");
    expect(detailSource).not.toContain("api.explorerCandidate");
    expect(detailSource).not.toContain("api.explorerRevisionDraft");
    expect(refreshSource).not.toContain("api.explorerCandidate");
    expect(refreshSource).not.toContain("api.explorerRevisionDraft");
  });

  it("wires directory state into ThreadRail and creates a selected thread", () => {
    expect(explorerViewSource).toContain(":explorer-loading=\"explorerLoading\"");
    expect(explorerViewSource).toContain(":explorer-error=\"explorerError\"");
    expect(explorerViewSource).toContain("explorers.value = [created.explorer");
    expect(explorerViewSource).toContain("thread.value = created.explorer");
  });
});

describe("Explorer plan projection extraction", () => {
  it("captures the projection generation through named accessors and keeps the counter private", () => {
    // P7-9：视图里 `selectExplorerPlan` 也在用同一套"发起时捕获、返回后比对"的世代守卫，
    // 所以 composable 以两个具名函数暴露，**不暴露可写计数器**——否则视图那三处会比
    // composable 内部的比对多出第二种写法（`requestVersion !== planProjectionVersion`），
    // 而它读的是另一个模块的 let，谁也拦不住。
    expect(explorerViewSource).toContain("const requestVersion = beginPlanProjection();");
    expect(explorerViewSource).toContain("!isCurrentPlanProjection(requestVersion)");
    expect(explorerViewSource).not.toContain("planProjectionVersion");
    expect(planProjectionComposableSource).toContain("function isCurrentPlanProjection(version = planProjectionVersion): boolean {");
    expect(planProjectionComposableSource).toContain("return version === planProjectionVersion;");
  });

  it("keeps the SSE resume cursor owned by the projection composable", () => {
    // 写侧的两条响应更新与复位仍锁在 usePlanProjection，读侧锁在 useExplorerSse，
    // 两边都留才能防止游标被复制或责任倒置。
    expect(planProjectionComposableSource).toContain("explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, workspace.lastEventSequence ?? 0);");
    expect(planProjectionComposableSource).toContain("explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, response.lastEventSequence ?? 0);");
    expect(planProjectionComposableSource).toContain("    explorerEventSequence.value = null;");
    // P7-11：游标的写侧仍全在 usePlanProjection，三条 SSE 通道的读侧已经一起搬进
    // useExplorerSse。视图只解构生命周期方法，不持有 EventSource 或 handler。
    expect(explorerSseComposableSource).toContain("if (deps.explorerEventSequence.value !== null) replayGate.markReady();");
    expect(explorerSseComposableSource).toContain("deps.explorerEventSequence.value ?? undefined");
    expect(explorerSseComposableSource).toContain("new EventSource(api.explorerEventsUrl");
    expect(explorerSseComposableSource).toContain("eventSource.addEventListener(\"turn.input_required\"");
    expect(explorerViewSource).toContain("const { connectEvents, connectLoopEvents, connectLoopEventsIfConnected, closeEvents, closeRequirementStatusEvents } = useExplorerSse(");
    expect(explorerViewSource).not.toContain("new EventSource(");
    expect(explorerViewSource).not.toContain("let eventSource");
    expect(explorerViewSource).not.toContain("function refreshTurnsAfterEvent");
    expect(explorerViewSource).not.toContain("replayGate.markReady");
  });
});

describe("Explorer project management wiring", () => {
  it("uses inline project actions instead of a Manage Projects dialog", () => {
    expect(explorerViewSource).not.toContain("projectManagementOpen");
    expect(explorerViewSource).not.toContain("@manage-projects");
    expect(explorerViewSource).not.toContain("ProjectManagementDialog");
    expect(explorerViewSource).toContain("@open-project=\"switchProject\"");
    expect(explorerViewSource).toContain("@create-project=\"openProjectCreateDialog\"");
    expect(explorerViewSource).toContain("ProjectCreateDialog");
    expect(explorerViewSource).toContain("@open-project-settings=\"openProjectSettingsDialog\"");
    expect(explorerViewSource).toContain("@archive-project=\"toggleProjectArchive\"");
    expect(explorerViewSource).not.toContain('void router.push("/projects")');
  });

  it("opens project creation in the current Explorer dialog", () => {
    expect(explorerViewSource).toContain("projectCreateOpen");
    expect(explorerViewSource).toContain("function openProjectCreateDialog()");
    expect(explorerViewSource).not.toContain('void router.push("/projects/new")');
    expect(explorerViewSource).toContain("@project-created=\"handleProjectCreated\"");
  });

  it("preserves the project catalog while clearing the old Explorer projection", () => {
    const resetSource = explorerViewSource.match(/function resetProjectState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).not.toContain("projects.value = []");
    expect(explorerViewSource).toContain("projects.value.find((item) => item.id === nextProjectId)");
    expect(explorerViewSource).toContain("resetThreadState();");
  });
});

describe("Explorer project settings wiring", () => {
  it("opens project settings in a modal without leaving the Explorer", () => {
    expect(explorerViewSource).toContain("projectSettingsOpen");
    expect(explorerViewSource).toContain("ProjectSettingsDialog");
    expect(explorerViewSource).toContain("@open-project-settings=\"openProjectSettingsDialog\"");
    expect(explorerViewSource).not.toContain("/settings`);");
  });

  /**
   * 旧 `/projects/:id/settings(/*)` 重定向过来时带的 `settings=1`。三处缺一不可，而且每一处
   * 缺了都只表现为"某个入口打不开设置"，不会报错：
   *   - onMounted 里那次调用：整页 → Explorer 的**冷**跳转（书签、外链）；
   *   - `watch(route.query.settings)`：已经在 Explorer 里时再跳到这个地址，组件不重挂；
   *   - `delete query.settings`：一次性消费，否则关掉对话框后一刷新它又自己弹开。
   */
  it("consumes the retired settings address exactly once, and on both entry paths", () => {
    expect(explorerViewSource).toContain("watch(() => route.query.settings, consumeSettingsQuery)");
    expect(explorerViewSource).toContain("syncPanelStateFromRoute(); consumeSettingsQuery();");
    expect(explorerViewSource).toContain("delete query.settings");
    expect(explorerViewSource).toContain(':initial-tab="projectSettingsInitialTab"');
  });
});

describe("Project catalog project creation wiring", () => {
  it("uses the shared creation dialog instead of navigating to a standalone page", () => {
    expect(projectCatalogSource).toContain("ProjectCreateDialog");
    expect(projectCatalogSource).toContain("createOpen");
    expect(projectCatalogSource).not.toContain('void router.push("/projects/new")');
    expect(projectCatalogSource).toContain("@project-created=\"handleProjectCreated\"");
  });
});

describe("Explorer provider loop layout", () => {
  it("moves the provider loop into the compact header status details without changing its controls", () => {
    expect(explorerViewSource).toContain("<ExplorerHeaderStatus");
    expect(explorerViewSource).toContain(":agent-loop=\"agentLoop\"");
    expect(explorerViewSource).toContain("@toggle-pause=\"toggleExplorerPause\"");
    expect(explorerHeaderStatusSource).toContain('<div class="agent-loop-summary">');
    expect(explorerHeaderStatusSource).toContain('class="agent-loop-status"');
    expect(explorerHeaderStatusSource).toContain('class="agent-loop-action"');
    expect(explorerStylesSource).toContain(".agent-loop-strip { display: grid;");
    expect(explorerStylesSource).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(explorerStylesSource).toContain(".agent-loop-status {");
    expect(explorerStylesSource).toContain("overflow-wrap: anywhere;");
  });
});

describe("Explorer header status layout", () => {
  it("renders three compact status cards with independent floating detail surfaces", () => {
    expect(explorerHeaderStatusSource).toContain("必填项");
    expect(explorerHeaderStatusSource).toContain("Provider 循环");
    expect(explorerHeaderStatusSource).toContain("探索进度");
    expect((explorerHeaderStatusSource.match(/trigger="click"/g) ?? [])).toHaveLength(3);
    expect(explorerHeaderStatusSource).toContain('data-status-card="requirements"');
    expect(explorerHeaderStatusSource).toContain('data-status-card="provider-loop"');
    expect(explorerHeaderStatusSource).toContain('data-status-card="exploration"');
    expect(explorerHeaderStatusSource).toContain('aria-controls="explorer-header-requirements-details"');
    expect(explorerHeaderStatusSource).toContain('aria-controls="explorer-header-provider-loop-details"');
    expect(explorerHeaderStatusSource).toContain('aria-controls="explorer-header-exploration-details"');
    expect(explorerHeaderStatusSource).toContain('popper-class="explorer-header-status-popper"');
    expect(explorerHeaderStatusSource).toContain('initially-expanded');
    expect(explorerHeaderStatusSource).toContain('watch(() => props.threadId');
  });

  it("keeps the title compact and leaves transient notices outside the moved status group", () => {
    expect(explorerViewSource).toContain('class="conversation-header-copy"');
    expect(explorerViewSource).toContain(':title="explorerDisplayTitle(thread)"');
    expect(explorerViewSource).toContain("{{ explorerDisplayTitle(thread) }}");
    expect(explorerViewSource).not.toContain("PLAN MODE · READ ONLY");
    expect(explorerViewSource).not.toContain("Shape the work before anything changes in the repository.");
    expect(explorerViewSource).not.toContain('<ExplorerPlanRequirements v-if=');
    expect(explorerViewSource).toContain('class="demo-notice pause-notice"');
    expect(explorerViewSource).toContain('class="demo-notice"');
    expect(explorerStylesSource).toContain(".conversation-header-copy h1");
    expect(explorerStylesSource).toContain(".explorer-header-status-trigger { display: grid;");
    expect(explorerStylesSource).toContain(".explorer-header-status-popper");
  });
});

describe("Explorer thread memory removal", () => {
  it("removes the obsolete thread memory entries and drawer", () => {
    expect(threadRailSource).not.toContain("THREAD MEMORY");
    expect(threadRailSource).not.toContain("Successor threads");
    expect(threadRailSource).not.toContain("Context summary");
    expect(explorerViewSource).not.toContain("memoryPanel");
    expect(explorerViewSource).not.toContain("#summary");
    expect(explorerViewSource).not.toContain("#successors");
    expect(explorerViewSource).not.toContain("closeMemoryPanel");
    expect(explorerViewSource).not.toContain("setMemoryPanelOpen");
  });
});

describe("Explorer header actions", () => {
  it("does not render a standalone new Explorer button", () => {
    expect(explorerViewSource).not.toContain('class="new-thread-button"');
    expect(explorerViewSource).not.toContain('aria-label="新建 Explorer"');
  });
});

describe("Explorer composer availability", () => {
  it("keeps the composer editable and locks sending only for the active requirement", () => {
    expect(explorerViewSource).toContain(`<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused"`);
    expect(explorerViewSource).not.toContain(`<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused || busy"`);
    expect(explorerViewSource).toContain(`:loading="activePlanBusy && !activePlanWaitingForInput || sendingCurrentPlan"`);
    expect(explorerViewSource).toContain(`|| explorerPaused || activePlanBusy || sendingCurrentPlan || busy"`);
  });

  it("explains why the send button is unavailable while the selected requirement is running", () => {
    expect(explorerViewSource).toContain(`:title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : '发送消息'"`);
    expect(explorerViewSource).toContain(`if (!content || activePlanBusy.value || sendingCurrentPlan.value || busy.value || !thread.value || thread.value.state === "ARCHIVED"`);
  });

  it("restores saved answers after refresh and explains submissions still awaiting provider confirmation", () => {
    // P7-8：三条语句随输入请求搬进 composable（字符串逐字未改），
    // 视图这一侧换成"不再自己持有 + 已委托给谁"两条负/正断言。
    expect(explorerInputRequestsComposableSource).toContain("loadExplorerInputProgressDraft(scope, draftRequest)");
    expect(explorerInputRequestsComposableSource).toContain("saveExplorerInputProgressDraft(scope, request, progress)");
    expect(explorerInputRequestsComposableSource).toContain("item.status === \"SUBMITTING\"");
    expect(explorerViewSource).not.toContain("loadExplorerInputProgressDraft");
    expect(explorerViewSource).not.toContain("saveExplorerInputProgressDraft");
    expect(explorerViewSource).toContain("inputCardRequest, setInputRequests, adoptInputRequest, resetInputState, inputAnswerLabelsFor, inputAnswerText, inputStatusLabel, openInputRequest, updateInputProgress, submitInput, cancelInput } = useExplorerInputRequests(");
    // 这两条测的是**模板**里的用户可见文案，留在视图。
    expect(explorerViewSource).toContain("正在提交结构化答案，确认后本轮会继续");
    expect(explorerViewSource).toContain("inputCardRequest?.status === 'SUBMITTING'");
  });
});

describe("Explorer markdown rendering", () => {
  it("renders message bodies through the shared Markdown component", () => {
    expect(explorerViewSource).toContain('import MarkdownMessage from "../components/MarkdownMessage.vue"');
    expect(explorerViewSource).toContain('<MarkdownMessage :source="item.activity.summary" />');
    expect(explorerViewSource).toContain('<MarkdownMessage :source="readableAssistantText(item.activity.summary)" :streaming="item.activity.status === \'RUNNING\'" />');
    expect(explorerViewSource).not.toContain(`: item.activity.summary }}<span v-if="item.activity.status === 'RUNNING'" class="processing-dots"`);
  });
});

/**
 * 推理行的两条分支。这一组是**跑真实数据之后补的**：Codex 的推理只有加密内容，
 * 于是所有推理行都没有正文——而它们没正文时看着像"本来就没话说"，不容易被发现。
 */
const explorerReasoningRowSource = readFileSync(fileURLToPath(new URL("../components/ExplorerReasoningRow.vue", import.meta.url)), "utf8");

describe("推理行：有正文可折叠，没有正文就明说", () => {
  it("有正文时是折叠卡，没有正文时不摆折叠", () => {
    expect(explorerReasoningRowSource).toContain('<details v-if="hasBody"');
    expect(explorerReasoningRowSource).toContain(":open=\"running\"");
    // **没有正文时不摆 `<details>`**：一个点开只有空白的展开区比没有更糟。
    expect(explorerReasoningRowSource).toContain('v-else class="timeline-reasoning-plain"');
  });

  it("**两种「没正文」要分得开**：Provider 没给 vs Factory 自己的标记", () => {
    // 前者明说「未提供正文」——否则那一行就是一个光秃秃的「推理」，看着像这一轮根本没推理过。
    // 后者（`MODEL_STARTED`，"这一轮跑起来了"）留空，不编句子。
    expect(explorerReasoningRowSource).toContain("isProviderControlled");
    expect(explorerReasoningRowSource).toContain("未提供正文");
    // **正文过一遍展示边界的脱敏**：模型可能把它读到的令牌、邮箱原样复述出来。
    expect(explorerReasoningRowSource).toContain("presentableText");
    expect(explorerStylesSource).toContain(".timeline-reasoning-unreadable");
  });
});
