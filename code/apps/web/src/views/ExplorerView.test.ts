import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **换行与缩进不是这些断言的判据**：Prettier 会把源码与 CSS 重排（一行拆成多行、缩进改变），
 * 而断言要证的是"这里接上了某个东西"，不是"它是怎么排版的"。所以两边都先把连续空白压成单个空格
 * 再比——否则每次格式化都要回来把一批断言重打一遍，而它们本来就没打算测排版。
 */
const flat = (text: string) =>
  text
    .replace(/\s+/g, " ")
    // 断行会在**下一个 token 前面**留下一个空格（`foo(\n  bar,` -> `foo( bar,`）。只吃掉这些
    // "断行带进来的"空格：开括号/花括号之后，闭括号/花括号/方括号/分号/逗号/引号之前。
    // **不要**动别处——尤其别去掉 `(` 前面的空格：正则断言不会被折叠，`@media (max-width:` 那样
    // 一改就再也匹配不上。
    .replace(/([({])\s+/g, "$1")
    .replace(/\s+([)}\]);,"'])/g, "$1")
    .replace(/,([)}\]])/g, "$1")
    .trim();
const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
/**
 * **时间线上的"一条"现在住在行组件里**（`components/ExplorerMessageRow.vue`）：视图只过一遍隐显、
 * 算好这一条该配哪张方案卡，然后把它交给这个壳——执行侧早就是这个形状（`ExecutionMessageRow.vue`）。
 * 所以行型的断言从视图搬到了这里。
 */
const explorerMessageRowSource = readFileSync(fileURLToPath(new URL("../components/ExplorerMessageRow.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
/**
 * **CSS 的换行与缩进不是这些断言的判据**：Prettier 会把一条规则从"一行写完"重排成"一行一声明"，
 * 而规则本身一个字都没变。断言的是**声明序列**，所以两边都先把连续空白压成单个空格再比——
 * 这样它测的是样式，不是排版（否则每次格式化都要回来改一批断言，而它们本来就没打算测排版）。
 */
// 方案卡与行组件：**按形态分文件**，"这一行长什么样"要去各自的组件里看。
const explorerCandidatePlanCardSource = readFileSync(
  fileURLToPath(new URL("../components/ExplorerCandidatePlanCard.vue", import.meta.url)),
  "utf8",
);
const explorerTimelineSource = readFileSync(fileURLToPath(new URL("../utils/explorerTimeline.ts", import.meta.url)), "utf8");
// P7 第二级把这条投影链从视图搬进了 composable。下面的断言跟着代码走，
// **没有放宽**：正向断言改读新归属文件，负向断言（`syntheticPlanItems`）
// 在新旧两个文件上都必须成立，否则守卫会悄悄失效。
const explorerTimelineComposableSource = readFileSync(
  fileURLToPath(new URL("../composables/useExplorerTimeline.ts", import.meta.url)),
  "utf8",
);
// 同理，P7 第二级把会话状态与请求令牌守卫搬进了 useExplorerSession：
// 视图现在说 `invalidateProjectScope()`，原子句 `requestScope.invalidate()` 跟着代码
// 落到 composable 里。**两条都要断言**——只留视图那条，守卫就被削成"函数名还在"。
const explorerSessionComposableSource = readFileSync(
  fileURLToPath(new URL("../composables/useExplorerSession.ts", import.meta.url)),
  "utf8",
);
// 第三次出现同一类处置（P7-8）：输入请求整块搬进了 useExplorerInputRequests。
// 规则同前——**正向断言搬到 composable，视图这一侧换成委托语句，两条都留**。
const explorerInputRequestsComposableSource = readFileSync(
  fileURLToPath(new URL("../composables/useExplorerInputRequests.ts", import.meta.url)),
  "utf8",
);
// 第四次出现同一类处置（P7-9）：需求投影整块搬进了 usePlanProjection。
// 规则同前——**正向断言搬到 composable，视图这一侧换成委托语句，两条都留**。
const planProjectionComposableSource = readFileSync(fileURLToPath(new URL("../composables/usePlanProjection.ts", import.meta.url)), "utf8");
// 第五次出现同一类处置（P7-10）：Plan 生命周期写操作搬进了 usePlanLifecycleActions。
// 正向断言跟随 composable；视图保留动作解构与 template 的用户界面判据，两侧都留。
const planLifecycleActionsComposableSource = readFileSync(
  fileURLToPath(new URL("../composables/usePlanLifecycleActions.ts", import.meta.url)),
  "utf8",
);
const planDetailDrawerComposableSource = readFileSync(
  fileURLToPath(new URL("../composables/usePlanDetailDrawer.ts", import.meta.url)),
  "utf8",
);
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
    expect(flat(threadRailSource)).toContain(flat("<el-dropdown"));
    expect(flat(threadRailSource)).toContain(flat('popper-class="thread-action-popper"'));
    expect(flat(threadRailSource)).toContain(flat('command="rename"'));
    expect(flat(threadRailSource)).toContain(flat('command="policy"'));
    expect(flat(threadRailSource)).toContain(flat('command="refresh"'));
    expect(flat(threadRailSource)).toContain(flat('command="toggle-pause"'));
    expect(threadRailSource).not.toContain('command="new-requirement"');
    expect(flat(threadRailSource)).toContain(flat('command="delete"'));
    expect(flat(threadRailSource)).toContain(flat("删除线程"));
    expect(flat(threadRailSource)).toContain(flat("thread-action-danger"));
    expect(explorerViewSource).not.toContain("<el-dropdown");
    expect(explorerViewSource).not.toContain('class="conversation-tools"');
    expect(flat(explorerViewSource)).toContain(flat('if (command === "toggle-pause")'));
    expect(flat(explorerViewSource)).toContain(flat('if (command === "delete")'));
    expect(flat(explorerViewSource)).toContain(flat("api.deleteExplorer"));
    expect(flat(explorerViewSource)).toContain(flat("永久删除线程"));
    expect(flat(explorerViewSource)).toContain(flat("const loaded = await load();"));
    expect(flat(explorerViewSource)).toContain(flat("替代线程详情加载失败，请点击 Retry"));
    expect(explorerViewSource).not.toContain("loadExplorerDetails(response.replacementExplorer");
    expect(flat(explorerViewSource)).toContain(flat("suppressNextExplorerRouteReload"));
    expect(flat(threadRailSource)).toContain(flat('props.explorerPaused ? "恢复循环" : "暂停循环"'));
    expect(flat(threadRailSource)).toContain(flat("线程操作"));
    expect(flat(threadRailSource)).toContain(flat("重命名线程"));
    expect(flat(threadRailSource)).toContain(flat("查看策略"));
    expect(flat(threadRailSource)).toContain(flat("刷新线程"));
    expect(flat(explorerViewSource)).toContain(flat("ExplorerRenameDialog"));
    expect(flat(explorerViewSource)).toContain(flat("api.renameExplorer"));
    expect(explorerViewSource).not.toContain("Manage read-only exploration without changing the repository.");
    expect(explorerViewSource).not.toContain("thread-more-menu");
  });

  it("provides focused styling hooks for the dropdown action rows", () => {
    expect(flat(explorerStylesSource)).toContain(flat(".thread-action-popper"));
    expect(flat(explorerStylesSource)).toContain(flat(".thread-action-menu-item"));
    expect(flat(explorerStylesSource)).toContain(flat(".thread-action-danger"));
    expect(flat(explorerStylesSource)).toContain(flat("focus-visible"));
  });
});

describe("Provider usage footer wiring", () => {
  it("uses the shared footer and shows only model/context facts", () => {
    expect(flat(explorerViewSource)).toContain(flat('import ProviderUsageFooter from "../components/ProviderUsageFooter.vue"'));
    expect(flat(explorerViewSource)).toContain(
      flat(
        '<ProviderUsageFooter :model="explorerModel" :backend="explorerBackendLabel" :context="contextUsage" context-note="estimated" />',
      ),
    );
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
    expect(flat(explorerViewSource)).toContain(flat("api.projects()"));
    expect(flat(explorerViewSource)).toContain(flat(':panel="leftPanel"'));
    expect(flat(explorerViewSource)).toContain(flat(':projects="projects"'));
    expect(flat(explorerViewSource)).toContain(flat(':explorers="explorers"'));
    expect(flat(explorerViewSource)).toContain(flat(':show-archived="showArchivedExplorers"'));
    expect(flat(explorerViewSource)).toContain(flat(':explorer-action-id="explorerActionId"'));
    expect(flat(explorerViewSource)).toContain(flat('@thread-action="handleThreadAction"'));
    expect(flat(explorerViewSource)).toContain(flat('@select-panel="leftPanel = $event"'));
    expect(flat(explorerViewSource)).toContain(flat('@select-project="switchProject"'));
    expect(flat(explorerViewSource)).toContain(flat('@select-explorer="selectExplorer"'));
    expect(flat(explorerViewSource)).toContain(flat('@toggle-show-archived="showArchivedExplorers = $event"'));
    expect(flat(explorerViewSource)).toContain(flat('@archive-explorer="toggleExplorerArchive"'));
    expect(flat(explorerViewSource)).toContain(flat('@create-explorer="createExplorer"'));
    expect(flat(explorerViewSource)).toContain(flat('@create-project="openProjectCreateDialog"'));
    expect(flat(explorerViewSource)).toContain(flat('@open-project="switchProject"'));
    expect(explorerViewSource).not.toContain(':requirements="explorerPlans"');
    expect(explorerViewSource).not.toContain("@select-plan-center=");
    expect(explorerViewSource).not.toContain("@select-explorer-plan=");
  });

  it("renders Explorer threads inline without the history drawer", () => {
    expect(flat(threadRailSource)).toContain(flat("explorer-list"));
    expect(flat(threadRailSource)).toContain(flat('class="left-panel-create"'));
    expect(explorerViewSource).not.toContain("ExplorerHistoryDrawer");
    expect(explorerViewSource).not.toContain("historyOpen");
    expect(explorerViewSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("thread-identity");
  });
});

describe("Explorer requirement list and shared drawer", () => {
  it("shows the selected thread requirement projection in the center and removes old context panels", () => {
    expect(flat(explorerViewSource)).toContain(flat('import ExplorerRequirementList from "../components/ExplorerRequirementList.vue"'));
    expect(flat(explorerViewSource)).toContain(flat("<ExplorerRequirementList"));
    expect(flat(explorerViewSource)).toContain(flat(':rows="requirementRows"'));
    expect(flat(explorerViewSource)).toContain(flat('@add="openAddRequirementDialog"'));
    expect(flat(explorerViewSource)).toContain(flat('@explore="openRequirementChat"'));
    expect(flat(explorerViewSource)).toContain(flat('@view-plan="openRequirementPlan"'));
    expect(flat(explorerViewSource)).toContain(flat('@open-task="openRequirementTask"'));
    expect(flat(explorerViewSource)).toContain(flat("projectExplorerRequirementRows("));
    // ac4d794 把独立的 Plan Center 面板并进了需求工作区；那个组件本身已经删除，
    // 这条守卫现在的意思是**不要再长出第二套 Plan 中心**（与下面两条旧上下文面板同理）。
    expect(explorerViewSource).not.toContain("<PlanCenterPanel");
    expect(explorerViewSource).not.toContain('class="context-panel-shell"');
    expect(explorerViewSource).not.toContain('class="context-entry-rail"');
  });

  it("uses one shared drawer for Explorer chat, full Plan detail, and Run", () => {
    expect(flat(explorerViewSource)).toContain(flat('import PlanDetailContent from "../components/PlanDetailContent.vue"'));
    expect(flat(explorerViewSource)).toContain(flat('import RunDetailView from "./RunDetailView.vue"'));
    expect(flat(explorerViewSource)).toContain(
      flat('const activeRunId = computed(() => (typeof route.query.runId === "string" ? route.query.runId : null))'),
    );
    expect(flat(explorerViewSource)).toContain(flat("<PlanDetailContent"));
    expect(flat(explorerViewSource)).toContain(flat('<RunDetailView v-if="activeRunId"'));
    expect(flat(explorerViewSource)).toContain(flat('@close="closeRunView"'));
    expect(flat(explorerViewSource)).toContain(flat('role="tablist" aria-label="需求详情类型"'));
    expect(flat(explorerViewSource)).toContain(flat("探索对话"));
    expect(flat(explorerViewSource)).toContain(flat("Plan 详情"));
    expect(flat(explorerViewSource)).toContain(flat("Run"));
    expect(flat(explorerViewSource)).toContain(flat("delete query.runId"));
    expect(flat(explorerViewSource)).toContain(flat('@open-plan="openPlanDetail"'));
  });

  it("shows the selected Plan immediately while full details load and ignores stale detail responses", () => {
    // 抽屉详情已抽到 composable（P7 第三级），断言跟着搬过去——校验的性质不变：
    // 先把已知的 Plan 落进抽屉再等接口，以及用请求代际丢弃过期响应。
    const openPlanDetailSource =
      planDetailDrawerComposableSource.match(/async function openPlanDetail\(plan: Plan\): Promise<void> \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(flat(openPlanDetailSource)).toContain(flat("detailPlan.value = plan"));
    expect(openPlanDetailSource.indexOf("detailPlan.value = plan")).toBeLessThan(openPlanDetailSource.indexOf("await api.getPlan(planId)"));
    expect(flat(openPlanDetailSource)).toContain(flat("requestVersion === detailRequestVersion"));
    expect(flat(openPlanDetailSource)).toContain(flat('currentRevisionDraft.status !== "CONFIRMED"'));
    expect(flat(openPlanDetailSource)).toContain(flat("detailPlan.value = deps.planFromRevisionDraft(currentRevisionDraft)"));
    expect(flat(openPlanDetailSource)).toContain(flat("const generatedSpec = response.plan.generatedSpec ?? plan.generatedSpec"));
  });

  it("creates a requirement once and keeps failed first messages available for retry", () => {
    // 「新增需求」现在走独立对话框：开框的是 openAddRequirementDialog，真正建需求的是 createRequirement
    // （`requirementSubmitting` 那道门闩保证重复提交不会建出两条需求）。
    expect(flat(explorerViewSource)).toContain(flat("function openAddRequirementDialog(): void"));
    expect(flat(explorerViewSource)).toContain(flat("api.createExplorerPlan(requestProjectId, currentThread.id)"));
    expect(flat(explorerViewSource)).toContain(flat("if (!currentThread || !requestProjectId || requirementSubmitting.value) return;"));
    expect(flat(explorerViewSource)).toContain(flat("await sendTurn()"));
    expect(flat(explorerViewSource)).toContain(flat("async function sendTurn(): Promise<boolean>"));
    expect(flat(explorerViewSource)).toContain(flat("failedExplorerSends"));
    expect(flat(explorerViewSource)).toContain(flat("clientTurnId"));
    expect(flat(explorerViewSource)).toContain(flat("draft.value = content"));
  });

  it("warns inline when the card is a conversation artifact", () => {
    // 对话产物确认后进不了执行：卡片上（方案卡只有助手消息里那一处）在按钮旁边就说清，
    // 而不是等人切到 Run 页签。原先还有一张独立的 PLAN CREATED 卡也带这条警告，那张卡已删除。
    expect(flat(explorerCandidatePlanCardSource)).toContain(flat('v-if="conversationArtifact" class="candidate-notice"'));
    expect(explorerViewSource).not.toContain("plan-created-event");
  });

  it("preserves confirm and enqueue order while opening the task tab", () => {
    // P7-10：写操作的正向守卫跟随 composable，视图这一侧锁住"组合根把六个动作
    // 接回来"；模板里的 task drawer 与对话产物文案仍由视图锁住。
    expect(flat(planLifecycleActionsComposableSource)).toContain(
      flat("async function confirmPlan(plan: Plan | null = deps.candidate.value)"),
    );
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("api.confirmPlan("));
    // 抽屉里的 "Confirm V2" 必须确认**它显示的那一版**：已确认 Plan 上挂修订草稿时
    // `candidate` 是 null，回落到 candidate 会让按钮静默失效。
    expect(flat(explorerViewSource)).toContain(flat('@confirm="confirmPlan(detailPlan)"'));
    expect(flat(explorerViewSource)).toContain(flat('@discard="discardPlan(detailPlan)"'));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("async function enqueuePlan("));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("api.enqueuePlan(id)"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("if (isConversationArtifactPlan(plan))"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("CONVERSATION_ARTIFACT_NOT_EXECUTABLE"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("async function startPlanRun(plan: Plan): Promise<void>"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("async function revisePlanConfiguration(plan: Plan): Promise<void>"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(flat("function handlePlanCenterConfigurationRevised(): void"));
    expect(flat(planLifecycleActionsComposableSource)).toContain(
      flat("async function discardPlan(plan: Plan | null = deps.candidate.value)"),
    );
    expect(flat(explorerViewSource)).toContain(
      flat("const { confirmPlan, enqueuePlan, startPlanRun, revisePlanConfiguration, discardPlan } = usePlanLifecycleActions("),
    );
    expect(flat(explorerViewSource)).toContain(flat('drawerTab.value = "task"'));
    expect(flat(explorerViewSource)).toContain(flat("taskPanelPlan.status === 'READY' && isConversationArtifactPlan(taskPanelPlan)"));
    expect(flat(explorerViewSource)).toContain(flat("返回探索对话修订"));
    expect(flat(explorerViewSource)).toContain(flat("此 Plan 是对话产物，不能入队执行。"));
    expect(flat(explorerViewSource)).toContain(flat("taskPanelPlan.status === 'READY'"));
    expect(flat(explorerViewSource)).toContain(flat("入队和开始运行是两个独立步骤。"));
  });

  it("routes drawer tabs to the selected requirement's existing Plan and Run", () => {
    const switchTabSource = explorerViewSource.match(/function switchDrawerTab\(tab: SharedDrawerTab\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flat(switchTabSource)).toContain(flat("void openPlanDetail(selectedRequirementRow.value.plan)"));
    expect(flat(switchTabSource)).toContain(flat("row?.run?.id ?? row?.plan?.runId ?? row?.plan?.dispatch?.runId"));
    expect(flat(switchTabSource)).toContain(flat("void openRunView(runId, thread.value?.id, row?.explorerPlan.id)"));
  });
});

describe("Explorer thread and drawer state", () => {
  it("keeps thread navigation separate and preserves the per-thread selected requirement", () => {
    expect(flat(explorerViewSource)).toContain(flat('type LeftPanel = "projects" | "explorers"'));
    expect(flat(explorerViewSource)).toContain(flat('const leftPanel = ref<LeftPanel>("explorers")'));
    expect(flat(explorerViewSource)).toContain(flat("function explorerRouteQuery"));
    expect(flat(explorerViewSource)).toContain(flat("query.explorerPlanId"));
    expect(flat(explorerViewSource)).toContain(flat("selected.activeExplorerPlanId"));
    expect(flat(explorerViewSource)).toContain(flat("explorerPlans.value[0]?.id ?? null"));
    expect(flat(explorerViewSource)).toContain(flat("function resetThreadState()"));
    expect(flat(explorerViewSource)).toContain(flat("drawerOpen.value = false"));
    expect(flat(explorerViewSource)).toContain(flat('drawerTab.value = "explorer"'));
  });

  it("closes and clears the drawer when switching threads", () => {
    // 切换线程时抽屉必须清空。这条性质现在跨两个文件：视图的 resetThreadState 委托，
    // composable 的 resetDetailState 执行——两半都要断言，只测一半会让另一半能悄悄漏掉。
    const resetSource = explorerViewSource.match(/function resetThreadState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flat(resetSource)).toContain(flat("resetDetailState()"));
    const resetDetailSource = planDetailDrawerComposableSource.match(/function resetDetailState\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(flat(resetDetailSource)).toContain(flat("drawerOpen.value = false"));
    expect(flat(resetDetailSource)).toContain(flat("detailPlan.value = null"));
    // 同时作废在途请求，否则切换线程后旧线程的响应会回填进新线程的抽屉。
    expect(flat(resetDetailSource)).toContain(flat("detailRequestVersion += 1"));
    expect(flat(explorerViewSource)).toContain(flat("function selectExplorer(explorerId: string)"));
    expect(flat(explorerViewSource)).toContain(flat("void reloadSelectedExplorer()"));
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
    expect(flat(explorerStylesSource)).toContain(flat(".left-entry-rail"));
    expect(flat(explorerStylesSource)).toContain(flat(".console-layout { grid-template-columns: 330px minmax(0, 1fr); }"));
    expect(flat(explorerStylesSource)).toContain(flat(".shared-drawer-shell"));
    expect(flat(explorerStylesSource)).toContain(flat(".shared-drawer-tabs"));
    expect(flat(explorerStylesSource)).toMatch(/@media \(max-width: 720px\).*?\.shared-drawer-header/);
    expect(flat(explorerStylesSource)).toContain(flat(".timeline { flex: 1 1 auto;"));
    expect(flat(explorerStylesSource)).toContain(flat(".composer { flex: 0 0 auto;"));
  });

  it("narrow screens collapse the rail to its icon strip instead of squeezing the panel", () => {
    // ≤720px 时左列只有 58px，只装得下图标栏。此前只改了外层列宽、没管 rail 内部的
    // `64px minmax(0,1fr)`：面板列被挤到 0 宽而内容照常溢出，那条「项目执行线程」入口
    // 变成十几像素的竖条、还被中栏盖住，窄屏下根本点不到。两条要一起在。
    expect(flat(explorerStylesSource)).toContain(
      flat(".console-layout:not(.project-execution-mode) .thread-rail { grid-template-columns: minmax(0, 1fr); }"),
    );
    expect(flat(explorerStylesSource)).toContain(
      flat(".console-layout:not(.project-execution-mode) .thread-rail .left-panel { display: none; }"),
    );
  });
});

describe("Explorer inline message presentation", () => {
  it("用户消息是「› + 纯文本」的一行，靠右，不再是可以折叠的卡片", () => {
    expect(threadRailSource).not.toContain("<el-tree");
    expect(threadRailSource).not.toContain("explorer-thread-tree");
    expect(threadRailSource).not.toContain('command="new-requirement"');
    // "这一行怎么摆"在行组件里；视图只把条目递进去。
    expect(flat(explorerMessageRowSource)).toContain(flat("mode === 'text'"));
    expect(flat(explorerMessageRowSource)).toContain(flat('class="timeline-user-mark"'));
    // 卡片那一套（头像 + 首行摘要 + 展开按钮）已经删掉：用户输入是一行原文，不是一份要点提要。
    expect(explorerViewSource).not.toContain("user-message-summary");
    expect(explorerViewSource).not.toContain("isUserMessageExpanded");
    expect(explorerStylesSource).not.toContain(".user-message-summary");
    // 我的消息靠右（与执行线程的 `.execution-message.mine` 同一套读法）：那个 `auto` 左外边距掉了
    // 就会悄悄退回左对齐——那不是"没样式"，是读起来像两个人在同一侧说话。
    expect(explorerStylesSource).toMatch(/\.timeline-user-text \{[^}]*margin: 0 0 18px auto;/);
  });

  it("视图把每条条目交给行组件，并把它读不到的本地状态一起递进去", () => {
    // 行组件拿不到"正在编辑的草稿"与"这条请求在途"——它们归 `useExplorerInputRequests`，
    // 而卡上的答案文案（草稿优先、密钥显示已隐藏、提交中…）恰恰由它们决定。**少传一个 prop，
    // 界面就会静默退回"显示服务端答案"**（连报错都没有），所以这几条接线钉在这里。
    expect(flat(explorerViewSource)).toContain(flat(':input-progress="inputProgress"'));
    expect(flat(explorerViewSource)).toContain(flat(':input-answer-in-flight="inputAnswerInFlight"'));
    expect(flat(explorerViewSource)).toContain(flat(':pending-input-id="pendingInput?.id ?? null"'));
    expect(flat(explorerViewSource)).toContain(flat('@answer="openInputRequest"'));
    // 条目本身、锚点序号、方案卡都由视图算好递进去（它拿得到当前需求与 planBindings）。
    expect(flat(explorerViewSource)).toContain(flat(':item="item"'));
    expect(flat(explorerViewSource)).toContain(flat(':index="index"'));
    expect(flat(explorerViewSource)).toContain(flat('@view-plan="openPlanDetail"'));
    expect(flat(explorerViewSource)).toContain(flat('@confirm-plan="confirmPlan"'));
    expect(flat(explorerViewSource)).toContain(flat('@enqueue-plan="enqueuePlan"'));
    // 行组件不自己去读视图的状态：它是一个纯粹的"按行型渲染"的壳。
    expect(explorerMessageRowSource).not.toContain('from "../composables/');
  });

  it("centers the latest-message prompt within the chat timeline", () => {
    expect(flat(explorerViewSource)).toContain(flat('class="scroll-to-latest"'));
    expect(explorerStylesSource).toMatch(/\.scroll-to-latest \{[^}]*left: 50%;[^}]*right: auto;[^}]*transform: translateX\(-50%\);/);
  });

  it("renders each bound plan only in its generating assistant message", () => {
    expect(flat(explorerTimelineComposableSource)).toContain(flat("const planBindings = computed(() => buildPlanActivityBindings"));
    expect(flat(explorerTimelineComposableSource)).toContain(
      flat(
        "const activeTaskPlans = computed<Plan[]>(() => deps.allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId)))",
      ),
    );
    expect(flat(explorerTimelineComposableSource)).toContain(
      flat("buildPlanActivityBindings(activeTaskPlans.value, visibleActivity.value)"),
    );
    expect(flat(explorerTimelineComposableSource)).toContain(
      flat("buildExplorerTimeline(visibleActivity.value, visibleInputRequests.value)"),
    );
    expect(explorerTimelineComposableSource).not.toContain("syntheticPlanItems");
    // 方案卡只挂在产出它的那条助手消息里；此前还有一条"绑不上就单独渲染一张 PLAN CREATED 卡"
    // 的时间线分支，现代代码里绑不上是不可能的，已删除（见 docs/消息类型及事件状态机流程图.md）。
    expect(explorerTimelineComposableSource).not.toContain("detachedPlans");
    expect(explorerViewSource).not.toContain("item.kind === 'plan'");
    expect(explorerViewSource).not.toContain("plan-created-event");
    // 绑定由视图算好（它拿着当前需求与 `planBindings`），**从外面递进去**；行组件只管摆。
    expect(flat(explorerViewSource)).toContain(flat(':plan="planForTimelineItem(item)"'));
    expect(flat(explorerMessageRowSource)).toContain(flat('v-if="showCandidatePlanCard && plan"'));
    expect(explorerViewSource).not.toContain("syntheticPlanItems");
    expect(explorerViewSource).not.toContain('v-for="item in syntheticPlanItems"');
  });

  it("时间线的显隐与内嵌方案卡都问同一张清单表", () => {
    // 呈现方式表（`EXPLORER_DISPLAY_MODES`）必须是**唯一**的判据：模板里再自己写一遍
    // "哪些 kind 要显示"，就等于把表绕过去了——改表不再生效，而且没人会发现。
    expect(flat(explorerViewSource)).toContain(flat('v-for="(item, index) in renderedTimelineItems"'));
    expect(flat(explorerViewSource)).toContain(flat("explorerDisplayMode(explorerTimelineMessageType(item))"));
    // 两次查表分别在两处：条目要不要出现（视图）与内嵌卡要不要出现（行组件）。
    expect(flat(explorerMessageRowSource)).toContain(flat('explorerDisplayMode("CANDIDATE_PLAN")'));
    expect(explorerViewSource).not.toContain('v-for="(item, index) in timelineItems"');
    // 被输入卡取代的那两类生命周期行只写在表里（和投影层），两处都不该认得它们的名字。
    for (const source of [explorerViewSource, explorerMessageRowSource]) {
      expect(source).not.toContain("INPUT_REQUIRED");
      expect(source).not.toContain("INPUT_RESOLVED");
    }
  });

  it("过程活动各走各的行组件，兜底会当场显示出来", () => {
    // 行组件这一层只做一件事：按行型选分支。**摆哪些字段**在 `explorerActivityLine()`，
    // **长什么样**在各自的组件里（`components/Explorer*Row.vue`）——不再自己翻 kind 决定显示什么。
    expect(flat(explorerMessageRowSource)).toContain(flat("mode === 'reasoning'"));
    expect(flat(explorerMessageRowSource)).toContain(flat("mode === 'divider'"));
    expect(flat(explorerMessageRowSource)).toContain(flat("<ExplorerReasoningRow"));
    expect(flat(explorerMessageRowSource)).toContain(flat("<ExplorerDividerRow"));
    expect(flat(explorerMessageRowSource)).toContain(flat("<ExplorerActivityRow"));
    // 兜底：行型掉到这里说明映射与模板没跟上，**当场显示**，不要静默渲染成一张裸卡。
    expect(flat(explorerMessageRowSource)).toContain(flat("timeline-unknown-row"));
    expect(flat(explorerMessageRowSource)).not.toContain("activityMode");
    expect(flat(explorerStylesSource)).toContain(flat(".timeline-unknown-row"));
    expect(explorerViewSource).not.toContain("activityKindLabel");
    expect(flat(explorerStylesSource)).toContain(flat(".timeline-note"));
    expect(flat(explorerStylesSource)).toContain(flat(".timeline-divider-label"));
    expect(flat(explorerStylesSource)).toContain(flat(".activity-turn-status"));
  });

  it("does not infer missing Task ownership and scopes Candidate refreshes", () => {
    // P7-8：归属判据随输入请求搬进 composable，**形参改名的部分是必要的**——
    // composable 收的是"已解析"的需求 id，解析链（activeExplorerPlan → thread →
    // explorerPlans[0]）留在视图。所以两侧各锁一条，缺任何一侧都盖不住回归。
    expect(flat(explorerInputRequestsComposableSource)).toContain(
      flat("return belongsToExplorerPlan(planId, deps.activeExplorerPlanId.value);"),
    );
    expect(flat(explorerViewSource)).toContain(flat("activeExplorerPlanId: computed(() => activeExplorerPlan.value?.id ?? null)"));
    expect(explorerViewSource).not.toContain("(planId ?? explorerPlans.value[0]?.id) === activeId");
    expect(explorerViewSource).not.toContain(
      "api.explorerCandidate(requestProjectId, explorerId, activeExplorerPlanId.value ?? undefined)",
    );
    expect(explorerViewSource).not.toContain(
      "api.explorerCandidate(requestProjectId, selected.id, selected.activeExplorerPlanId ?? undefined)",
    );
    expect(flat(explorerScopeSource)).toContain(flat("return itemPlanId === activePlanId;"));
  });

  it("projects one accessible center row per current-thread requirement", () => {
    const listSource = readFileSync(fileURLToPath(new URL("../components/ExplorerRequirementList.vue", import.meta.url)), "utf8");
    // P7-9：投影状态与 workspace 加载搬进 usePlanProjection。正向断言跟着代码走，
    // 视图这一侧换成"解构了哪些状态"与"委托给了谁"（`api.explorerPlanWorkspace` 在视图里
    // 已经一个字都不剩，只断言"视图里没有"是不够的——那样空文件也能过）。
    expect(flat(planProjectionComposableSource)).toContain(flat("const explorerPlans = ref<ExplorerPlan[]>([]);"));
    expect(flat(explorerViewSource)).toContain(
      flat(
        "enqueued, explorerEventSequence, activeExplorerPlan, allPlans, planFromRevisionDraft, applyPlanProjection, loadActivePlanWorkspace, refreshPlanProjection",
      ),
    );
    expect(flat(explorerViewSource)).toContain(flat("api.explorerPlanGroups(requestProjectId, selected.id)"));
    expect(flat(explorerViewSource)).toContain(flat("api.createExplorerPlan(requestProjectId, currentThread.id)"));
    expect(flat(planProjectionComposableSource)).toContain(flat("api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId)"));
    expect(flat(explorerViewSource)).toContain(
      flat(
        "const workspaceLoaded = await loadActivePlanWorkspace(selected.id, activeExplorerPlanId.value, requestProjectId, requestToken)",
      ),
    );
    expect(flat(explorerViewSource)).toContain(flat("route.query.explorerPlanId"));
    expect(flat(explorerViewSource)).toContain(flat("const requirementRows = computed(() => projectExplorerRequirementRows("));
    expect(flat(listSource)).toContain(flat('aria-label="当前探索线程的需求清单"'));
    expect(flat(listSource)).toContain(flat("row.planStatus.label"));
    expect(flat(listSource)).toContain(flat("row.taskStatus.label"));
    expect(flat(listSource)).toContain(flat("查看 V{{ row.plan.revision }}"));
    expect(flat(listSource)).toContain(flat("新增需求"));
    expect(flat(listSource)).toContain(flat("这个探索线程还没有需求"));
    expect(flat(explorerViewSource)).toContain(flat("requirementDrafts"));
    expect(explorerViewSource).not.toContain('aria-label="Plan timeline"');
  });
});

describe("Explorer requirement and drawer styling", () => {
  it("styles the center list, shared drawer and actionable statuses", () => {
    expect(flat(explorerStylesSource)).toContain(flat(".requirement-list-panel"));
    expect(flat(explorerStylesSource)).toContain(flat(".requirement-table-row"));
    expect(flat(explorerStylesSource)).toContain(flat(".shared-drawer-shell"));
    expect(flat(explorerStylesSource)).toContain(flat(".shared-drawer-tabs button:focus-visible"));
    expect(flat(explorerStylesSource)).toContain(flat(".task-action-panel"));
  });
});

describe("Explorer thread switching", () => {
  it("reloads the current conversation when the selected thread changes", () => {
    expect(flat(explorerViewSource)).toContain(flat("async function selectExplorer(explorerId: string)"));
    expect(flat(explorerViewSource)).toContain(flat('query: explorerRouteQuery(explorerId), hash: "" });'));
    expect(flat(explorerViewSource)).toContain(flat("void reloadSelectedExplorer();"));
    // P7-9：workspace 加载的 API 调用搬进了 composable，视图这一侧只留委托调用。
    expect(flat(planProjectionComposableSource)).toContain(flat("api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId)"));
    expect(flat(explorerViewSource)).toContain(
      flat("await loadActivePlanWorkspace(currentThread.id, selectedPlan.id, requestProjectId, requestToken)"),
    );
  });

  it("separates Explorer creation from turn busy state and clears stale thread data", () => {
    expect(flat(explorerViewSource)).toContain(flat("const creatingExplorer = ref(false)"));
    expect(flat(explorerViewSource)).toContain(flat("if (creatingExplorer.value) return;"));
    expect(explorerViewSource).not.toContain("async function createExplorer() {\n  if (busy.value) return;");
    expect(flat(explorerViewSource)).toContain(flat("function resetThreadState()"));
    expect(flat(explorerViewSource)).toContain(flat("invalidateProjectScope();"));
    expect(flat(explorerSessionComposableSource)).toContain(flat("requestScope.invalidate();"));
    // 线程级字段的清空已经搬进 composable，视图这一侧必须真的委托过去，
    // 而不是留着几个"看起来清过"的赋值。
    const resetSource = explorerViewSource.match(/function resetThreadState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flat(resetSource)).toContain(flat("resetSessionState();"));
    expect(resetSource).not.toContain("turns.value = []");
    expect(resetSource).not.toContain("activity.value = []");
    expect(flat(explorerSessionComposableSource)).toContain(flat("turns.value = [];"));
    expect(flat(explorerSessionComposableSource)).toContain(flat("activity.value = [];"));
    // P7-8 同一条处置：输入请求的四个清空赋值 + 两个对话框字段也搬走了。
    // 正负两侧都断言——只断言"composable 里有"，抓不到"视图里还留了一半"。
    expect(flat(resetSource)).toContain(flat("resetInputState();"));
    expect(resetSource).not.toContain("inputRequests.value = []");
    expect(resetSource).not.toContain("pendingInput.value = null");
    expect(resetSource).not.toContain("inputDialogOpen.value = false");
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat("inputRequests.value = [];"));
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat("pendingInput.value = null;"));
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat("inputDialogOpen.value = false;"));
    // P7-9 同一条处置：投影的九个清空赋值与"让在途刷新作废"的世代自增也搬走了。
    // 同样正负两侧都断言——`planProjectionVersion` 在视图里必须一个字都不剩。
    expect(flat(resetSource)).toContain(flat("resetPlanProjection();"));
    expect(resetSource).not.toContain("explorerPlans.value = []");
    expect(resetSource).not.toContain("threadPlans.value = []");
    expect(resetSource).not.toContain("candidate.value = null");
    expect(resetSource).not.toContain("explorerEventSequence");
    expect(flat(planProjectionComposableSource)).toContain(flat("explorerPlans.value = [];"));
    expect(flat(planProjectionComposableSource)).toContain(flat("activeExplorerPlanId.value = null;"));
    expect(flat(planProjectionComposableSource)).toContain(flat("beginPlanProjection();"));
    expect(flat(explorerViewSource)).toContain(flat(':creating-explorer="creatingExplorer"'));
  });

  it("keeps message navigation keys unique when a turn has multiple assistant activities", () => {
    // 锚点用**活动 id** 而不是 turnId：同一个回合里的多条助手活动因此各有各的锚点。
    expect(flat(explorerTimelineSource)).toContain(flat("return `message-${item.id}`;"));
    // 锚点算在行组件里（它拿得到这条的序号），视图只把序号递进去。
    expect(flat(explorerMessageRowSource)).toContain(flat(':id="explorerTimelineTarget(activity, index)"'));
    expect(flat(explorerMessageRowSource)).toContain(flat(':data-nav-key="explorerTimelineTarget(activity, index)"'));
    expect(flat(explorerViewSource)).toContain(flat(':index="index"'));
  });

  it("resets archived-thread visibility when switching projects", () => {
    expect(flat(explorerViewSource)).toContain(flat("const showArchivedExplorers = ref(false)"));
    expect(flat(explorerViewSource)).toContain(flat("const explorerActionId = ref<string | null>(null)"));
    const resetSource =
      explorerViewSource.match(/function resetProjectState\(nextProjectId = projectId\.value\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(flat(resetSource)).toContain(flat("showArchivedExplorers.value = false"));
  });

  it("keeps the directory visible when a selected thread projection fails", () => {
    expect(flat(explorerViewSource)).toContain(flat("const explorerLoading = ref(true)"));
    expect(flat(explorerViewSource)).toContain(flat("const explorerError = ref<string | null>(null)"));
    expect(flat(explorerViewSource)).toContain(flat("async function loadExplorerDetails"));
    expect(flat(explorerViewSource)).toContain(flat("async function loadExplorerDirectory"));
    const loadCatch = explorerViewSource.match(/async function loadExplorerDirectory[\s\S]*?\n\}/)?.[0] ?? "";
    expect(loadCatch).not.toContain("explorers.value = []");
  });

  it("loads route-selected threads without reloading the whole directory", () => {
    expect(flat(explorerViewSource)).toContain(flat("loadExplorerDetails"));
    expect(flat(explorerViewSource)).toContain(flat("watch(() => route.query.explorerId"));
    expect(flat(explorerViewSource)).toContain(flat("routeExplorerId === thread.value?.id"));
    expect(explorerViewSource).not.toContain("watch(() => route.query.explorerId, () => { if (mounted.value) reloadExplorer(); });");
  });

  it("keeps thread loading compatible with API instances without confirmed-plan projection", () => {
    const detailSource = explorerViewSource.match(/async function loadExplorerDetails[\s\S]*?\n\}/)?.[0] ?? "";
    // P7-9：`refreshPlanProjection` 整块搬进了 usePlanProjection，这一侧改读新归属文件。
    // 注意：如果只把正则的搜索对象留在视图上，匹配不到时会得到空字符串，
    // **而下面那两条 `not.toContain` 会照样通过**——那才是这条守卫真正会悄悄失效的地方。
    const refreshSource = planProjectionComposableSource.match(/async function refreshPlanProjection[\s\S]*?\n\}/)?.[0] ?? "";
    expect(refreshSource).not.toBe("");
    expect(flat(detailSource)).toContain(flat("optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id))"));
    expect(flat(detailSource)).toContain(flat("confirmedResponse?.items ?? []"));
    expect(flat(refreshSource)).toContain(flat("optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId))"));
    expect(flat(refreshSource)).toContain(flat("confirmedResponse?.items ?? []"));
    // 视图这一侧换成"委托给了谁"+"旧写法不许长回来"。
    expect(flat(explorerViewSource)).toContain(flat("applyPlanProjection(projection, confirmedResponse?.items ?? [], null)"));
    // 只否掉**搬走的那一处**：视图的 `loadExplorerDetails` 仍然自己发这个可选请求
    // （它的 key 是 `selected.id`），否掉整个方法名会误伤。
    expect(explorerViewSource).not.toContain("api.explorerConfirmedPlans(requestProjectId, explorerId)");
    expect(detailSource).not.toContain("api.explorerCandidate");
    expect(detailSource).not.toContain("api.explorerRevisionDraft");
    expect(refreshSource).not.toContain("api.explorerCandidate");
    expect(refreshSource).not.toContain("api.explorerRevisionDraft");
  });

  it("wires directory state into ThreadRail and creates a selected thread", () => {
    expect(flat(explorerViewSource)).toContain(flat(':explorer-loading="explorerLoading"'));
    expect(flat(explorerViewSource)).toContain(flat(':explorer-error="explorerError"'));
    expect(flat(explorerViewSource)).toContain(flat("explorers.value = [created.explorer"));
    expect(flat(explorerViewSource)).toContain(flat("thread.value = created.explorer"));
  });
});

describe("Explorer plan projection extraction", () => {
  it("captures the projection generation through named accessors and keeps the counter private", () => {
    // P7-9：视图里 `selectExplorerPlan` 也在用同一套"发起时捕获、返回后比对"的世代守卫，
    // 所以 composable 以两个具名函数暴露，**不暴露可写计数器**——否则视图那三处会比
    // composable 内部的比对多出第二种写法（`requestVersion !== planProjectionVersion`），
    // 而它读的是另一个模块的 let，谁也拦不住。
    expect(flat(explorerViewSource)).toContain(flat("const requestVersion = beginPlanProjection();"));
    expect(flat(explorerViewSource)).toContain(flat("!isCurrentPlanProjection(requestVersion)"));
    expect(explorerViewSource).not.toContain("planProjectionVersion");
    expect(flat(planProjectionComposableSource)).toContain(
      flat("function isCurrentPlanProjection(version = planProjectionVersion): boolean {"),
    );
    expect(flat(planProjectionComposableSource)).toContain(flat("return version === planProjectionVersion;"));
  });

  it("keeps the SSE resume cursor owned by the projection composable", () => {
    // 写侧的两条响应更新与复位仍锁在 usePlanProjection，读侧锁在 useExplorerSse，
    // 两边都留才能防止游标被复制或责任倒置。
    expect(flat(planProjectionComposableSource)).toContain(
      flat("explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, workspace.lastEventSequence ?? 0);"),
    );
    expect(flat(planProjectionComposableSource)).toContain(
      flat("explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, response.lastEventSequence ?? 0);"),
    );
    expect(flat(planProjectionComposableSource)).toContain(flat("    explorerEventSequence.value = null;"));
    // P7-11：游标的写侧仍全在 usePlanProjection，三条 SSE 通道的读侧已经一起搬进
    // useExplorerSse。视图只解构生命周期方法，不持有 EventSource 或 handler。
    expect(flat(explorerSseComposableSource)).toContain(flat("if (deps.explorerEventSequence.value !== null) replayGate.markReady();"));
    expect(flat(explorerSseComposableSource)).toContain(flat("deps.explorerEventSequence.value ?? undefined"));
    expect(flat(explorerSseComposableSource)).toContain(flat("new EventSource(api.explorerEventsUrl"));
    expect(flat(explorerSseComposableSource)).toContain(flat('eventSource.addEventListener("turn.input_required"'));
    expect(flat(explorerViewSource)).toContain(
      flat(
        "const { connectEvents, connectLoopEvents, connectLoopEventsIfConnected, closeEvents, closeRequirementStatusEvents } = useExplorerSse(",
      ),
    );
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
    expect(flat(explorerViewSource)).toContain(flat('@open-project="switchProject"'));
    expect(flat(explorerViewSource)).toContain(flat('@create-project="openProjectCreateDialog"'));
    expect(flat(explorerViewSource)).toContain(flat("ProjectCreateDialog"));
    expect(flat(explorerViewSource)).toContain(flat('@open-project-settings="openProjectSettingsDialog"'));
    expect(flat(explorerViewSource)).toContain(flat('@archive-project="toggleProjectArchive"'));
    expect(explorerViewSource).not.toContain('void router.push("/projects")');
  });

  it("opens project creation in the current Explorer dialog", () => {
    expect(flat(explorerViewSource)).toContain(flat("projectCreateOpen"));
    expect(flat(explorerViewSource)).toContain(flat("function openProjectCreateDialog()"));
    expect(explorerViewSource).not.toContain('void router.push("/projects/new")');
    expect(flat(explorerViewSource)).toContain(flat('@project-created="handleProjectCreated"'));
  });

  it("preserves the project catalog while clearing the old Explorer projection", () => {
    const resetSource = explorerViewSource.match(/function resetProjectState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).not.toContain("projects.value = []");
    expect(flat(explorerViewSource)).toContain(flat("projects.value.find((item) => item.id === nextProjectId)"));
    expect(flat(explorerViewSource)).toContain(flat("resetThreadState();"));
  });
});

describe("Explorer project settings wiring", () => {
  it("opens project settings in a modal without leaving the Explorer", () => {
    expect(flat(explorerViewSource)).toContain(flat("projectSettingsOpen"));
    expect(flat(explorerViewSource)).toContain(flat("ProjectSettingsDialog"));
    expect(flat(explorerViewSource)).toContain(flat('@open-project-settings="openProjectSettingsDialog"'));
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
    expect(flat(explorerViewSource)).toContain(flat("watch(() => route.query.settings, consumeSettingsQuery)"));
    expect(flat(explorerViewSource)).toContain(flat("syncPanelStateFromRoute(); consumeSettingsQuery();"));
    expect(flat(explorerViewSource)).toContain(flat("delete query.settings"));
    expect(flat(explorerViewSource)).toContain(flat(':initial-tab="projectSettingsInitialTab"'));
  });
});

describe("Project catalog project creation wiring", () => {
  it("uses the shared creation dialog instead of navigating to a standalone page", () => {
    expect(flat(projectCatalogSource)).toContain(flat("ProjectCreateDialog"));
    expect(flat(projectCatalogSource)).toContain(flat("createOpen"));
    expect(projectCatalogSource).not.toContain('void router.push("/projects/new")');
    expect(flat(projectCatalogSource)).toContain(flat('@project-created="handleProjectCreated"'));
  });
});

describe("Explorer provider loop layout", () => {
  it("moves the provider loop into the compact header status details without changing its controls", () => {
    expect(flat(explorerViewSource)).toContain(flat("<ExplorerHeaderStatus"));
    expect(flat(explorerViewSource)).toContain(flat(':agent-loop="agentLoop"'));
    expect(flat(explorerViewSource)).toContain(flat('@toggle-pause="toggleExplorerPause"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('<div class="agent-loop-summary">'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('class="agent-loop-status"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('class="agent-loop-action"'));
    expect(flat(explorerStylesSource)).toContain(flat(".agent-loop-strip { display: grid;"));
    expect(flat(explorerStylesSource)).toContain(flat("grid-template-columns: minmax(0, 1fr) auto;"));
    expect(flat(explorerStylesSource)).toContain(flat(".agent-loop-status {"));
    expect(flat(explorerStylesSource)).toContain(flat("overflow-wrap: anywhere;"));
  });
});

describe("Explorer header status layout", () => {
  it("renders three compact status cards with independent floating detail surfaces", () => {
    expect(flat(explorerHeaderStatusSource)).toContain(flat("必填项"));
    expect(flat(explorerHeaderStatusSource)).toContain(flat("Provider 循环"));
    expect(flat(explorerHeaderStatusSource)).toContain(flat("探索进度"));
    expect(explorerHeaderStatusSource.match(/trigger="click"/g) ?? []).toHaveLength(3);
    expect(flat(explorerHeaderStatusSource)).toContain(flat('data-status-card="requirements"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('data-status-card="provider-loop"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('data-status-card="exploration"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('aria-controls="explorer-header-requirements-details"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('aria-controls="explorer-header-provider-loop-details"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('aria-controls="explorer-header-exploration-details"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat('popper-class="explorer-header-status-popper"'));
    expect(flat(explorerHeaderStatusSource)).toContain(flat("initially-expanded"));
    expect(flat(explorerHeaderStatusSource)).toContain(flat("watch(() => props.threadId"));
  });

  it("keeps the title compact and leaves transient notices outside the moved status group", () => {
    expect(flat(explorerViewSource)).toContain(flat('class="conversation-header-copy"'));
    expect(flat(explorerViewSource)).toContain(flat(':title="explorerDisplayTitle(thread)"'));
    expect(flat(explorerViewSource)).toContain(flat("{{ explorerDisplayTitle(thread) }}"));
    expect(explorerViewSource).not.toContain("PLAN MODE · READ ONLY");
    expect(explorerViewSource).not.toContain("Shape the work before anything changes in the repository.");
    expect(explorerViewSource).not.toContain("<ExplorerPlanRequirements v-if=");
    expect(flat(explorerViewSource)).toContain(flat('class="demo-notice pause-notice"'));
    expect(flat(explorerViewSource)).toContain(flat('class="demo-notice"'));
    expect(flat(explorerStylesSource)).toContain(flat(".conversation-header-copy h1"));
    expect(flat(explorerStylesSource)).toContain(flat(".explorer-header-status-trigger { display: grid;"));
    expect(flat(explorerStylesSource)).toContain(flat(".explorer-header-status-popper"));
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
    expect(flat(explorerViewSource)).toContain(
      flat(
        `<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused"`,
      ),
    );
    expect(explorerViewSource).not.toContain(
      `<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused || busy"`,
    );
    expect(flat(explorerViewSource)).toContain(flat(`:loading="(activePlanBusy && !activePlanWaitingForInput) || sendingCurrentPlan"`));
    expect(flat(explorerViewSource)).toContain(flat(`|| explorerPaused || activePlanBusy || sendingCurrentPlan || busy"`));
  });

  it("explains why the send button is unavailable while the selected requirement is running", () => {
    expect(flat(explorerViewSource)).toContain(
      flat(`:title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : '发送消息'"`),
    );
    expect(flat(explorerViewSource)).toContain(
      flat(
        `if (!content || activePlanBusy.value || sendingCurrentPlan.value || busy.value || !thread.value || thread.value.state === "ARCHIVED"`,
      ),
    );
  });

  it("restores saved answers after refresh and explains submissions still awaiting provider confirmation", () => {
    // P7-8：三条语句随输入请求搬进 composable（字符串逐字未改），
    // 视图这一侧换成"不再自己持有 + 已委托给谁"两条负/正断言。
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat("loadExplorerInputProgressDraft(scope, draftRequest)"));
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat("saveExplorerInputProgressDraft(scope, request, progress)"));
    expect(flat(explorerInputRequestsComposableSource)).toContain(flat('item.status === "SUBMITTING"'));
    expect(explorerViewSource).not.toContain("loadExplorerInputProgressDraft");
    expect(explorerViewSource).not.toContain("saveExplorerInputProgressDraft");
    expect(flat(explorerViewSource)).toContain(
      flat(
        "inputCardRequest, setInputRequests, adoptInputRequest, resetInputState, openInputRequest, updateInputProgress, submitInput, cancelInput } = useExplorerInputRequests(",
      ),
    );
    // 卡上那三处答案文案（草稿优先 / 密钥显示已隐藏 / 提交中…）现在由**行组件**直接调纯函数算——
    // 它把草稿与在途标记当 props 收下（见"视图把每条条目交给行组件"那一条），视图不再中转这三层。
    expect(flat(explorerMessageRowSource)).toContain(
      flat("inputAnswerDisplayLabels(request, request.questions[questionIndex]!, props.inputProgress)"),
    );
    expect(flat(explorerMessageRowSource)).toContain(
      flat("inputAnswerDisplayText(request, request.questions[questionIndex]!, props.inputProgress, props.inputAnswerInFlight)"),
    );
    // 这两条测的是**模板**里的用户可见文案，留在视图。
    expect(flat(explorerViewSource)).toContain(flat("正在提交结构化答案，确认后本轮会继续"));
    expect(flat(explorerViewSource)).toContain(flat("inputCardRequest?.status === 'SUBMITTING'"));
  });
});

describe("Explorer markdown rendering", () => {
  it("renders message bodies through the shared Markdown component", () => {
    // 正文怎么渲染在**行组件**里（视图只管把条目递进去），所以这一组断言跟着搬过去。
    expect(flat(explorerMessageRowSource)).toContain(flat('import MarkdownMessage from "./MarkdownMessage.vue"'));
    expect(flat(explorerMessageRowSource)).toContain(flat('<MarkdownMessage :source="activity.summary" />'));
    expect(flat(explorerMessageRowSource)).toContain(
      flat('<MarkdownMessage :source="readableAssistantText(activity.summary)" :streaming="activity.status === \'RUNNING\'" />'),
    );
    expect(explorerMessageRowSource).not.toContain(
      `: activity.summary }}<span v-if="activity.status === 'RUNNING'" class="processing-dots"`,
    );
  });
});

/**
 * 推理行的两条分支。这一组是**跑真实数据之后补的**：Codex 的推理只有加密内容，
 * 于是所有推理行都没有正文——而它们没正文时看着像"本来就没话说"，不容易被发现。
 */
const explorerReasoningRowSource = readFileSync(fileURLToPath(new URL("../components/ExplorerReasoningRow.vue", import.meta.url)), "utf8");

describe("推理行：有正文可折叠，没有正文就明说", () => {
  it("有正文时是折叠卡，没有正文时不摆折叠", () => {
    expect(flat(explorerReasoningRowSource)).toContain(flat('<details v-if="hasBody"'));
    expect(flat(explorerReasoningRowSource)).toContain(flat(':open="running"'));
    // **没有正文时不摆 `<details>`**：一个点开只有空白的展开区比没有更糟。
    expect(flat(explorerReasoningRowSource)).toContain(flat('v-else class="timeline-reasoning-plain"'));
  });

  it("**两种「没正文」要分得开**：Provider 没给 vs Factory 自己的标记", () => {
    // 前者明说「未提供正文」——否则那一行就是一个光秃秃的「推理」，看着像这一轮根本没推理过。
    // 后者（`MODEL_STARTED`，"这一轮跑起来了"）留空，不编句子。
    expect(flat(explorerReasoningRowSource)).toContain(flat("isProviderControlled"));
    expect(flat(explorerReasoningRowSource)).toContain(flat("未提供正文"));
    // **正文过一遍展示边界的脱敏**：模型可能把它读到的令牌、邮箱原样复述出来。
    expect(flat(explorerReasoningRowSource)).toContain(flat("presentableText"));
    expect(flat(explorerStylesSource)).toContain(flat(".timeline-reasoning-unreadable"));
  });
});

/**
 * **刷新页面不该弹出右侧面板。**
 *
 * `explorerPlanId` 是"当前选中哪个需求"的**常规路由状态**——每选中一个需求都会写进 URL。加载路径
 * 按它打开抽屉，等于"每次刷新都自动弹一次"，而用户并没有要求看它。页签仍然按 URL 记住，这样他点开
 * 时落在原来那一页。
 */
describe("Explorer 的右侧抽屉不在刷新时自动打开", () => {
  it("**只记住页签，不打开抽屉**", () => {
    // 判据不是"页面上没有 `drawerOpen.value = true`"——别处还有合法的打开（用户点击、Run 深链接）。
    // 要证的是：加载路径里那句**紧跟页签赋值**的打开没有了。
    expect(flat(explorerViewSource)).not.toContain(
      flat('routeDrawerTab === "task" ? routeDrawerTab : "explorer"; drawerOpen.value = true;'),
    );
    expect(flat(explorerViewSource)).toContain(flat('routeDrawerTab === "task" ? routeDrawerTab : "explorer";'));
  });

  /**
   * 上一条把"打开"从加载路径里摘掉之后，**点页签这条路必须自己把抽屉打开**：刷新后 URL 里还留着
   * `requirementTab`（只有关闭才清它），于是页签已是"选中"态而抽屉是关的——这时再点同一个页签，
   * `router.replace` 写进去的值没变，路由 watch 不触发，面板就再也开不了。
   */
  it("点页签就打开抽屉，不靠路由 watch 补这一下", () => {
    const switchDrawerTab = explorerViewSource.match(/function switchDrawerTab\(tab: SharedDrawerTab\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(switchDrawerTab).not.toBe("");
    expect(flat(switchDrawerTab)).toContain(flat("drawerOpen.value = true;"));
  });
});

/**
 * **删一条需求**：不可恢复的动作，界面这一侧负责三件事——接上按钮、说清代价、把服务端的两种拒绝
 * 翻成人话。**判据不在前端**（"哪些 Run 状态算在跑"只有服务端一份），所以这里不测"什么情况下按钮
 * 变灰"——那件事本来就不该发生在这个文件里。
 */
describe("需求清单的删除动作", () => {
  it("行内的删除按钮接上了处理函数，传的是那条需求的 id", () => {
    expect(flat(explorerViewSource)).toContain(flat('@remove="deleteExplorerPlan"'));
    expect(flat(explorerViewSource)).toContain(flat("api.deleteExplorerPlan(requestProjectId, currentThread.id, target.id)"));
  });

  it("**对话框只负责问**：点删除只开确认框，真删在 confirmDeleteExplorerPlan 里", () => {
    // 这条是这次改动的要点：以前 confirm + 删除写在同一个函数里，ElMessageBox 的
    // "取消"/"关闭"两个 reject 值漏写一处就会把"关掉"当成"确认"。
    const open = explorerViewSource.match(/function deleteExplorerPlan\(explorerPlanId: string\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(open).not.toBe("");
    expect(flat(open)).toContain(flat("deleteRequirementId.value = current.id;"));
    expect(flat(open)).not.toContain(flat("api.deleteExplorerPlan"));
    expect(flat(explorerViewSource)).toContain(flat("async function confirmDeleteExplorerPlan(): Promise<void>"));
    expect(flat(explorerViewSource)).toContain(flat('@confirm="confirmDeleteExplorerPlan"'));
  });

  it("确认框写明代价：一起删、不可恢复、worktree 不自动清理", () => {
    expect(flat(explorerViewSource)).toContain(flat("它的结构化 Plan、执行记录与执行日志一起删除，无法恢复"));
    expect(flat(explorerViewSource)).toContain(flat("已结束运行的本地 worktree 不会自动清理"));
    expect(flat(explorerViewSource)).toContain(flat('confirm-label="永久删除"'));
  });

  it("两种 409 各给一句人话：「还有在跑的」去停掉，「最后一条」不必白费劲", () => {
    expect(flat(explorerViewSource)).toContain(flat('code === "EXPLORER_DELETE_BLOCKED"'));
    expect(flat(explorerViewSource)).toContain(flat('code === "EXPLORER_PLAN_DELETE_FORBIDDEN"'));
    expect(flat(explorerViewSource)).toContain(flat("先把它停掉再删"));
    expect(flat(explorerViewSource)).toContain(flat("线程至少要留一条"));
    // 失败写在框里（deleteRequirementError），不再只弹 toast。
    expect(flat(explorerViewSource)).toContain(flat("deleteRequirementError.value ="));
  });

  it("删掉的正好是当前打开的那条时，才落到服务端给的接任者上", () => {
    expect(flat(explorerViewSource)).toContain(
      flat("if (activeExplorerPlanId.value === target.id && response.explorer.activeExplorerPlanId)"),
    );
    expect(flat(explorerViewSource)).toContain(flat("await selectExplorerPlan(response.explorer.activeExplorerPlanId)"));
  });
});

describe("需求清单的重命名", () => {
  it("与线程改名**共用同一个骨架**，差别只在 copy 那几行字", () => {
    expect(flat(explorerViewSource)).toContain(flat(':copy="RENAME_COPY.thread"'));
    expect(flat(explorerViewSource)).toContain(flat(':copy="RENAME_COPY.requirement"'));
    // 以前需求改名是一句 ElMessageBox.prompt——同一个动作两套样式，正是这次要收掉的。
    expect(flat(explorerViewSource)).not.toContain(flat('ElMessageBox.prompt("输入需求名称"'));
  });

  it("点重命名只开框，改名在 submitRenameRequirement 里", () => {
    const open = explorerViewSource.match(/function renameExplorerPlan\(explorerPlanId: string\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(open).not.toBe("");
    expect(flat(open)).toContain(flat("renameRequirementId.value = current.id;"));
    expect(flat(open)).not.toContain(flat("api.renameExplorerPlan"));
    expect(flat(explorerViewSource)).toContain(flat("async function submitRenameRequirement(title: string): Promise<void>"));
    expect(flat(explorerViewSource)).toContain(flat("api.renameExplorerPlan(projectId.value, currentThread.id, target.id, title)"));
  });
});
