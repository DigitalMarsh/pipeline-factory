import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const explorerTimelineSource = readFileSync(fileURLToPath(new URL("../utils/explorerTimeline.ts", import.meta.url)), "utf8");
// P7 第二级把这条投影链从视图搬进了 composable。下面的断言跟着代码走，
// **没有放宽**：正向断言改读新归属文件，负向断言（`syntheticPlanItems`）
// 在新旧两个文件上都必须成立，否则守卫会悄悄失效。
const explorerTimelineComposableSource = readFileSync(fileURLToPath(new URL("../composables/useExplorerTimeline.ts", import.meta.url)), "utf8");
const explorerScopeSource = readFileSync(fileURLToPath(new URL("../utils/explorerScope.ts", import.meta.url)), "utf8");
const threadRailSource = readFileSync(fileURLToPath(new URL("../components/ThreadRail.vue", import.meta.url)), "utf8");
const explorerHeaderStatusSource = readFileSync(fileURLToPath(new URL("../components/ExplorerHeaderStatus.vue", import.meta.url)), "utf8");
const providerUsageFooterSource = readFileSync(fileURLToPath(new URL("../components/ProviderUsageFooter.vue", import.meta.url)), "utf8");
const projectCatalogSource = readFileSync(fileURLToPath(new URL("./ProjectCatalogView.vue", import.meta.url)), "utf8");
const planCenterSource = readFileSync(fileURLToPath(new URL("../components/PlanCenterPanel.vue", import.meta.url)), "utf8");

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
  it("uses the shared footer and keeps the Explorer Status surface focused on limits", () => {
    expect(explorerViewSource).toContain('import ProviderUsageFooter from "../components/ProviderUsageFooter.vue"');
    expect(explorerViewSource).toContain('<ProviderUsageFooter :model="explorerModel" :context="contextUsage" context-note="estimated" />');
    expect(explorerViewSource).not.toContain('class="codex-status-popover"');
    expect(explorerViewSource).not.toContain("formatConversationId");
    expect(providerUsageFooterSource).toContain("5 小时限额");
    expect(providerUsageFooterSource).toContain("7 天限额");
    expect(providerUsageFooterSource).toContain('class="provider-usage-limits"');
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
    const openPlanDetailSource = explorerViewSource.match(/async function openPlanDetail\(plan: Plan\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(openPlanDetailSource).toContain("detailPlan.value = plan");
    expect(openPlanDetailSource.indexOf("detailPlan.value = plan")).toBeLessThan(openPlanDetailSource.indexOf("await api.getPlan(planId)"));
    expect(openPlanDetailSource).toContain("requestVersion === detailRequestVersion");
    expect(openPlanDetailSource).toContain("currentRevisionDraft.status !== \"CONFIRMED\"");
    expect(openPlanDetailSource).toContain("detailPlan.value = planFromRevisionDraft(currentRevisionDraft)");
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

  it("preserves confirm and enqueue order while opening the task tab", () => {
    expect(explorerViewSource).toContain("async function confirmPlan()");
    expect(explorerViewSource).toContain("api.confirmPlan(");
    expect(explorerViewSource).toContain("async function enqueuePlan(");
    expect(explorerViewSource).toContain("api.enqueuePlan(id)");
    expect(explorerViewSource).toContain("if (isConversationArtifactPlan(plan))");
    expect(explorerViewSource).toContain("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
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
    const resetSource = explorerViewSource.match(/function resetThreadState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("drawerOpen.value = false");
    expect(resetSource).toContain("detailPlan.value = null");
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
});

describe("Explorer inline message presentation", () => {
  it("keeps the left thread rail clear of requirement rows while retaining accessible chat summaries", () => {
    expect(threadRailSource).not.toContain("<el-tree");
    expect(threadRailSource).not.toContain("explorer-thread-tree");
    expect(threadRailSource).not.toContain('command="new-requirement"');
    expect(explorerViewSource).toContain('class="user-message-summary"');
    expect(explorerViewSource).toContain(':aria-expanded="isUserMessageExpanded(item.activity.id)"');
    expect(explorerViewSource).toContain('@click="toggleUserMessage(item.activity.id)"');
    expect(explorerViewSource).toContain('class="user-message-content"');
    expect(explorerStylesSource).toContain(".user-message-summary:focus-visible");
  });

  it("centers the latest-message prompt within the chat timeline", () => {
    expect(explorerViewSource).toContain('class="scroll-to-latest"');
    expect(explorerStylesSource).toMatch(/\.scroll-to-latest \{[^}]*left: 50%;[^}]*right: auto;[^}]*transform: translateX\(-50%\);/);
  });

  it("renders each bound plan only in its generating assistant message and inserts detached plans into the shared timeline", () => {
    expect(explorerTimelineComposableSource).toContain("const planBindings = computed(() => buildPlanActivityBindings");
    expect(explorerTimelineComposableSource).toContain("const activeTaskPlans = computed<Plan[]>(() => deps.allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId)))");
    expect(explorerTimelineComposableSource).toContain("buildPlanActivityBindings(activeTaskPlans.value, visibleActivity.value)");
    expect(explorerTimelineComposableSource).toContain("buildExplorerTimeline(visibleActivity.value, visibleInputRequests.value, detachedPlans.value)");
    expect(explorerTimelineComposableSource).not.toContain("syntheticPlanItems");
    expect(explorerViewSource).toContain("v-else-if=\"item.kind === 'plan'\"");
    expect(explorerViewSource).not.toContain("syntheticPlanItems");
    expect(explorerViewSource).not.toContain("v-for=\"item in syntheticPlanItems\"");
  });

  it("does not infer missing Task ownership and scopes Candidate refreshes", () => {
    expect(explorerViewSource).toContain('return belongsToExplorerPlan(planId, activeExplorerPlan.value?.id ?? null);');
    expect(explorerViewSource).not.toContain('(planId ?? explorerPlans.value[0]?.id) === activeId');
    expect(explorerViewSource).not.toContain('api.explorerCandidate(requestProjectId, explorerId, activeExplorerPlanId.value ?? undefined)');
    expect(explorerViewSource).not.toContain('api.explorerCandidate(requestProjectId, selected.id, selected.activeExplorerPlanId ?? undefined)');
    expect(explorerScopeSource).toContain('return itemPlanId === activePlanId;');
  });

  it("projects one accessible center row per current-thread requirement", () => {
    const listSource = readFileSync(fileURLToPath(new URL("../components/ExplorerRequirementList.vue", import.meta.url)), "utf8");
    expect(explorerViewSource).toContain("const explorerPlans = ref<ExplorerPlan[]>([])");
    expect(explorerViewSource).toContain("api.explorerPlanGroups(requestProjectId, selected.id)");
    expect(explorerViewSource).toContain("api.createExplorerPlan(projectId.value, currentThread.id)");
    expect(explorerViewSource).toContain("api.explorerPlanWorkspace");
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
    expect(explorerViewSource).toContain("api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId)");
  });

  it("separates Explorer creation from turn busy state and clears stale thread data", () => {
    expect(explorerViewSource).toContain("const creatingExplorer = ref(false)");
    expect(explorerViewSource).toContain("if (creatingExplorer.value) return;");
    expect(explorerViewSource).not.toContain("async function createExplorer() {\n  if (busy.value) return;");
    expect(explorerViewSource).toContain("function resetThreadState()");
    expect(explorerViewSource).toContain("requestScope.invalidate();");
    expect(explorerViewSource).toContain(":creating-explorer=\"creatingExplorer\"");
  });

  it("keeps message navigation keys unique when a turn has multiple assistant activities", () => {
    expect(explorerTimelineSource).toContain("key: `message:${item.activity.id}`");
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
    const refreshSource = explorerViewSource.match(/async function refreshPlanProjection[\s\S]*?\n\}/)?.[0] ?? "";
    expect(detailSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id))");
    expect(detailSource).toContain("confirmedResponse?.items ?? []");
    expect(refreshSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId))");
    expect(refreshSource).toContain("confirmedResponse?.items ?? []");
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
    expect(explorerHeaderStatusSource).toContain("REQUIREMENTS");
    expect(explorerHeaderStatusSource).toContain("PROVIDER LOOP");
    expect(explorerHeaderStatusSource).toContain("EXPLORATION");
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
    expect(explorerViewSource).toContain(`:title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : 'Send message'"`);
    expect(explorerViewSource).toContain(`if (!content || activePlanBusy.value || sendingCurrentPlan.value || busy.value || !thread.value || thread.value.state === "ARCHIVED"`);
  });

  it("restores saved answers after refresh and explains submissions still awaiting provider confirmation", () => {
    expect(explorerViewSource).toContain("loadExplorerInputProgressDraft(scope, draftRequest)");
    expect(explorerViewSource).toContain("saveExplorerInputProgressDraft(scope, request, progress)");
    expect(explorerViewSource).toContain("item.status === \"SUBMITTING\"");
    expect(explorerViewSource).toContain("正在提交结构化答案，确认后本轮会继续");
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
