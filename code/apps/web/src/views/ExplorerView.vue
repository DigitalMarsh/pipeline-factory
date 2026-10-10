<!--
  模块职责：承载 Explorer 对话、消息流、计划定位、输入请求和 SSE 生命周期。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Close, Connection, Document, Refresh, Right, VideoPause } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { ApiRequestError, api } from "../api";
import type { AgentLoop, ExplorerActivityItem, ExplorerThread, Plan, Project } from "../types";
import PlanDetailContent from "../components/PlanDetailContent.vue";
import ExplorerPolicyDrawer from "../components/ExplorerPolicyDrawer.vue";
import ThreadRail from "../components/ThreadRail.vue";
import ExplorerRequirementList from "../components/ExplorerRequirementList.vue";
import { isConversationArtifactPlan, projectExplorerRequirementRows } from "../utils/explorerRequirementRows";
import { DEFAULT_EXPLORER_PLAN_REQUIREMENTS, type ExplorerPlanRequirement } from "../utils/explorerPlanRequirements";
import { scrollTimelineToLatest } from "../utils/scrollTimeline";
import { optional } from "../utils/optional";
import { closePolicyPanel, openPolicyPanel } from "../utils/policyPanel";
import { createOptimisticUserTurn, settleOptimisticTurn } from "../utils/optimisticTurn";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import { formatContextUsage } from "../utils/explorerStatus";
import ExplorerInputDialog from "../components/ExplorerInputDialog.vue";
import ExplorerMessageRow from "../components/ExplorerMessageRow.vue";
import ProjectExecutionThreadPanel from "../components/ProjectExecutionThreadPanel.vue";
import ProjectSettingsDialog from "../components/ProjectSettingsDialog.vue";
import ProjectCreateDialog from "../components/ProjectCreateDialog.vue";
import ExplorerRenameDialog from "../components/ExplorerRenameDialog.vue";
import ExplorerRequirementDialog from "../components/ExplorerRequirementDialog.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import ExplorerHeaderStatus from "../components/ExplorerHeaderStatus.vue";
import ProviderUsageFooter from "../components/ProviderUsageFooter.vue";
import RunDetailView from "./RunDetailView.vue";
import scrollToLatestIcon from "../assets/scroll-to-latest.png";
import { normalizePlanProjection } from "../utils/planProjection";
import { backendLabel } from "../utils/modelCatalog";
import { useModelBackends } from "../composables/useModelBackends";
import { isCandidatePlan as isCandidatePlanFor } from "../utils/planControls";
import { planForActivity as planForActivityIn } from "../utils/planTimeline";
import { taskDisplayTitle } from "../utils/taskTree";
import { projectPathForModule } from "../utils/projectRoutes";
import { explorerPlanAnchorId, explorerTimelineMessageType, type ExplorerTimelineItem } from "../utils/explorerTimeline";
import { explorerDisplayMode, explorerDisplayTitle, explorerRuntimeFacts } from "../utils/explorerPresentation";
import {
  formatAgentLoopCompletion,
  formatAgentLoopGate,
  formatAgentLoopState,
  formatAgentLoopTerminal,
} from "../utils/agentLoopPresentation";
import { canCreateConfigurationRevision as canCreateConfigurationRevisionFor } from "../utils/runPrerequisites";

import { useExplorerInputRequests, type ExplorerInputDialogHandle } from "../composables/useExplorerInputRequests";
import { useExplorerSession } from "../composables/useExplorerSession";
import { useExplorerTimeline } from "../composables/useExplorerTimeline";
import { usePlanProjection } from "../composables/usePlanProjection";
import { usePlanLifecycleActions } from "../composables/usePlanLifecycleActions";
import { usePlanDetailDrawer, type SharedDrawerTab } from "../composables/usePlanDetailDrawer";
import { useExplorerSse } from "../composables/useExplorerSse";
import { useTimelineScroll } from "../composables/useTimelineScroll";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? ""));
const projectExecutionMode = computed(() => route.query.workspace === "project-execution");

/**
 * 会话状态（Project 目录 / 当前线程 / 消息流）与项目切换的请求令牌守卫交给 composable。
 * 需求投影与工作区加载见下方 `usePlanProjection`——它是唯一同时写会话状态与投影状态的地方，
 * 也正是 `projectScopeToken` / `isCurrentProjectScope` 以入参传下去的原因。
 */
const {
  project,
  projects,
  thread,
  explorers,
  turns,
  activity,
  projectRuns,
  projectScopeToken,
  beginProjectScope,
  invalidateProjectScope,
  isCurrentProjectScope,
  resetSessionState,
} = useExplorerSession({ projectId });

const projectCreateOpen = ref(false);
const projectSettingsOpen = ref(false);
const projectSettingsProjectId = ref<string | null>(null);
/** 只有旧 `/settings?tab=` 重定向过来时才非空（见 consumeSettingsQuery）。 */
const projectSettingsInitialTab = ref<string | null>(null);
const planRequirements = ref<ExplorerPlanRequirement[]>([]);
const draft = ref("");
const requirementDrafts = new Map<string, string>();
const pendingSendPlanIds = ref<Set<string>>(new Set());
type FailedExplorerSend = {
  content: string;
  clientTurnId: string;
  optimisticUserId: string;
  assistantActivityId: string;
  failedAssistantTurnId: string | null;
};
const failedExplorerSends = new Map<string, FailedExplorerSend>();
const policyOpen = ref(false);
const renameDialogOpen = ref(false);
const renameSaving = ref(false);
const renameError = ref<string | null>(null);
/** 「新增需求」对话框自己的三个状态；建需求成功时会把它关掉（见 createRequirement）。 */
const requirementDialogOpen = ref(false);
const requirementSubmitting = ref(false);
const requirementError = ref<string | null>(null);

/**
 * 「重命名需求」与「删除需求」：**只存目标 id，目标本身从列表里现取**（`…Target` 是 computed）。
 * 存整条 plan 的话，列表一刷新（另一处改了名、或删了别的需求）对话框里就还是那份过期快照。
 * `…Open` 由 id 反推——两个 ref 说同一件事，迟早会不一致。
 */
const renameRequirementId = ref<string | null>(null);
const renameRequirementSaving = ref(false);
const renameRequirementError = ref<string | null>(null);
const renameRequirementOpen = computed({
  get: () => renameRequirementId.value !== null,
  set: (open: boolean) => {
    if (!open) renameRequirementId.value = null;
  },
});
const renameRequirementTarget = computed(() => explorerPlans.value.find((plan) => plan.id === renameRequirementId.value) ?? null);
const deleteRequirementId = ref<string | null>(null);
const deleteRequirementSaving = ref(false);
const deleteRequirementError = ref<string | null>(null);
const deleteRequirementOpen = computed({
  get: () => deleteRequirementId.value !== null,
  set: (open: boolean) => {
    if (!open) deleteRequirementId.value = null;
  },
});
const deleteRequirementTarget = computed(() => explorerPlans.value.find((plan) => plan.id === deleteRequirementId.value) ?? null);

/**
 * 改名对话框的文案两份——骨架与样式共用 `ExplorerRenameDialog`，差别只在这几行字。
 * 摆在调用点附近而不是写进组件里：读 `renameExplorerPlan` / `renameThread` 就知道它长什么样。
 */
const RENAME_COPY = {
  thread: {
    eyebrow: "线程操作",
    heading: "重命名线程",
    fieldLabel: "线程名称",
    hint: "新名字会出现在探索视图的标题与线程列表里。",
    submitLabel: "保存名称",
  },
  requirement: {
    eyebrow: "需求操作",
    heading: "重命名需求",
    fieldLabel: "需求名称",
    hint: "新名字只改这条需求的显示名，不动它的方案与执行记录。",
    submitLabel: "保存名称",
  },
} as const;
const explorerPaused = ref(false);
type LeftPanel = "projects" | "explorers";
const leftPanel = ref<LeftPanel>("explorers");
type ContextPanel = "candidate" | "plans" | "confirmed" | "enqueued" | "dispatched" | "active" | "attention" | "plan-center";
const contextPanel = ref<ContextPanel>("candidate");
const loading = ref(true);
const error = ref<string | null>(null);
const explorerLoading = ref(true);
const explorerError = ref<string | null>(null);
const busy = ref(false);
const creatingExplorer = ref(false);
const showArchivedExplorers = ref(false);
const explorerActionId = ref<string | null>(null);
const projectActionId = ref<string | null>(null);
const timeline = ref<HTMLElement | null>(null);
const agentLoop = ref<AgentLoop | null>(null);
const explorerModel = ref("gpt-5.6-luna");
/**
 * 探索侧生效的 agent：Project 覆盖优先，否则是该角色在全局配置里的后端。
 * 与 `explorerModel`（来自 /health 的全局模型名）分开算，但同样只用于展示"这一轮是谁在跑"。
 */
const { catalog: modelCatalog, load: loadModelBackends } = useModelBackends();
const explorerBackendLabel = computed(() =>
  backendLabel(modelCatalog.value, project.value?.settings.models.explorer.backend || modelCatalog.value?.roles.explorer),
);
const inputDialog = ref<ExplorerInputDialogHandle | null>(null);
const mounted = ref(false);
// A delete already loads the replacement thread explicitly. Suppress the
// route watcher for that one navigation so the old thread cannot race the
// replacement load and overwrite the page-level error banner.
let suppressNextExplorerRouteReload = false;
const activeRunId = computed(() => (typeof route.query.runId === "string" ? route.query.runId : null));
const planCenterCount = ref(0);
const contextUsage = computed(() => formatContextUsage(turns.value));
const agentLoopLabel = computed(() => formatAgentLoopState(agentLoop.value?.state));
const agentLoopGateLabel = computed(() => formatAgentLoopGate(agentLoop.value?.diagnostics));
const agentLoopTerminalLabel = computed(() => formatAgentLoopTerminal(agentLoop.value?.diagnostics));
const agentLoopCompletionLabel = computed(() => (agentLoop.value ? formatAgentLoopCompletion(agentLoop.value) : null));
/**
 * 结构化输入请求（模型反问、答案提交、草稿进度）交给 composable。
 * 传进去的是 `activeExplorerPlan` **解析后**的 id——原始 `activeExplorerPlanId` ref
 * 还会回退到 thread / explorerPlans[0]，两条链路必须一致，否则会错位。
 * `inputDialog` 的模板 ref 留在本文件——`ref="inputDialog"` 要求它是个顶层绑定。
 */
const {
  pendingInput,
  inputRequests,
  inputProgress,
  inputDialogOpen,
  inputAnswerInFlight,
  inputCardRequest,
  setInputRequests,
  adoptInputRequest,
  resetInputState,
  openInputRequest,
  updateInputProgress,
  submitInput,
  cancelInput,
} = useExplorerInputRequests({
  projectId,
  thread,
  activeExplorerPlanId: computed(() => activeExplorerPlan.value?.id ?? null),
  inputDialog,
});

/**
 * 需求投影（需求分组 / 候选 / 确认 / 入队 / 派发、当前需求的工作区与活动）交给 composable。
 *
 * 声明位置在 `useExplorerInputRequests` **之后**，不是随意的：投影加载会把 workspace 的
 * `inputRequests` 与对话框状态写回输入请求那一侧（`loadActivePlanWorkspace`），所以它收的是
 * 上面已经存在的 ref，而不是自己造一份。反过来，输入请求要的是 `activeExplorerPlan`
 * **解析后**的 id——那个 `computed` 是惰性的，构造时不会求值，因此这个顺序成立；
 * 真正会读 `activeExplorerPlan` / `allPlans` 的是下方的 `useExplorerTimeline`。
 *
 * `routeExplorerPlanId` 用 getter 而不是 ref：投影只需要"路由上请求的需求 id"这一个值，
 * 不值得为此把 vue-router 的 route 对象交给 composable。
 */
const {
  explorerPlans,
  threadPlans,
  activeExplorerPlanId,
  candidate,
  revisionDraft,
  enqueued,
  explorerEventSequence,
  activeExplorerPlan,
  allPlans,
  planFromRevisionDraft,
  applyPlanProjection,
  loadActivePlanWorkspace,
  refreshPlanProjection,
  refreshActivity,
  scheduleProjectionRefresh,
  cancelProjectionRefresh,
  beginPlanProjection,
  isCurrentPlanProjection,
  resetPlanProjection,
} = usePlanProjection({
  projectId,
  thread,
  turns,
  activity,
  agentLoop,
  explorerPaused,
  inputDialogOpen,
  pendingInput,
  setInputRequests,
  projectScopeToken,
  isCurrentProjectScope,
  routeExplorerPlanId: () => (typeof route.query.explorerPlanId === "string" ? route.query.explorerPlanId : null),
});

const requirementRows = computed(() =>
  projectExplorerRequirementRows(
    explorerPlans.value,
    [...threadPlans.value, ...(candidate.value ? [candidate.value] : [])],
    projectRuns.value,
  ),
);
const selectedRequirementRow = computed(
  () => requirementRows.value.find((row) => row.explorerPlan.id === activeExplorerPlan.value?.id) ?? null,
);
const sharedDrawerTitle = computed(
  () => selectedRequirementRow.value?.title ?? (activeExplorerPlan.value ? taskDisplayTitle(activeExplorerPlan.value) : "需求详情"),
);
const taskPanelPlan = computed(() => selectedRequirementRow.value?.plan ?? null);
const explorationProgress = computed(
  () =>
    activeExplorerPlan.value?.exploration ??
    thread.value?.exploration ?? {
      status: "INCOMPLETE" as const,
      missing: [],
      completed: [],
      diagnostics: [],
      candidatePlanId: null,
      lastAssessedTurnId: null,
    },
);
const activePlanBusy = computed(() =>
  visibleTurns.value.some(
    (turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED" || turn.status === "QUEUED",
  ),
);
const activePlanWaitingForInput = computed(() => visibleTurns.value.some((turn) => turn.status === "WAITING_FOR_INPUT"));
const sendingCurrentPlan = computed(() => Boolean(activeExplorerPlan.value && pendingSendPlanIds.value.has(activeExplorerPlan.value.id)));

/**
 * 共享抽屉的 Plan 详情状态交给 composable。它必须建在 usePlanLifecycleActions **之前**：
 * 后者要拿这里的 drawerOpen / drawerTab / detailPlan 去在确认、入队之后刷新并切页签。
 * 路由形状不下沉——打开详情后的 URL 同步由 onOpened 回调留在视图里。
 */
const {
  drawerOpen,
  drawerTab,
  detailPlan,
  detailRevisions,
  detailLatestRevision,
  detailLoadError,
  detailDependencyOptions,
  dependenciesSaving,
  canEditDependencies,
  detailVerificationSuiteOptions,
  verificationSuitesSaving,
  canEditVerificationSuites,
  openPlanDetail,
  selectPlanRevision,
  saveDependencies,
  saveVerificationSuites,
  resetDetailState,
} = usePlanDetailDrawer({
  projectId,
  projectScopeToken,
  revisionDraft,
  planFromRevisionDraft,
  isReadOnly: () =>
    Boolean(detailPlan.value && detailLatestRevision.value !== null && detailPlan.value.revision !== detailLatestRevision.value),
  onOpened: (plan) => {
    void router.replace({
      path: route.path,
      query: { ...route.query, ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}), requirementTab: "plan" },
    });
  },
});

/**
 * Plan 生命周期写操作（确认 / 入队 / Run / 丢弃 / 配置修订）交给 composable。
 * 它只收状态 ref 与两个组合根回调；路由和需求清单的具体形状不下沉。
 */
const { confirmPlan, enqueuePlan, startPlanRun, revisePlanConfiguration, discardPlan } = usePlanLifecycleActions({
  projectId,
  project,
  thread,
  activeExplorerPlan,
  selectedRequirementPlan: computed(() => selectedRequirementRow.value?.plan ?? null),
  candidate,
  revisionDraft,
  detailPlan,
  enqueued,
  projectRuns,
  busy,
  error,
  drawerOpen,
  drawerTab,
  contextPanel,
  refreshPlanProjection,
  openRunView,
});

function canCreateConfigurationRevision(plan: Plan): boolean {
  return canCreateConfigurationRevisionFor(plan, project.value);
}

/**
 * 需求范围内的 Turn / Activity / 输入 / Plan 投影成消息时间线，交给 composable。
 * `activeTaskPlans` 是它内部的中间量，不再暴露给视图。
 */
const { visibleTurns, visibleActivity, visibleInputRequests, planBindings, timelineItems } = useExplorerTimeline({
  turns,
  activity,
  inputRequests,
  allPlans,
  activeExplorerPlan,
});

/**
 * ④「跑模型的程序报的」运行事实：压缩边界、自动重试、配额、钩子、后台任务、权限被拒、告警。
 * 它们**不进时间线**（`EXPLORER_DISPLAY_MODES` 里一律 `hidden`），由头部状态卡承载。
 * 判据来自两张表本身（大类 + 呈现方式），所以新增一类 ④ 不需要回来改这里。
 */
const runtimeFacts = computed(() => explorerRuntimeFacts(visibleActivity.value));

/**
 * 时间线上真正渲染哪些条目，问同一张清单表（`EXPLORER_DISPLAY_MODES`，见 utils/explorerPresentation.ts）。
 * 视图不再自己判断"这一类要不要出现"——呈现方式是产品决定，集中在一张表里，改那里即可。
 *
 * **"这一行长什么样"不在这里**：那是 `ExplorerMessageRow.vue` 的事（它按行型选分支）。
 * 视图只负责过一遍隐显、算好每条该配哪张方案卡，然后把条目交给它。
 */
const renderedTimelineItems = computed(() =>
  timelineItems.value.filter((item) => explorerDisplayMode(explorerTimelineMessageType(item)) !== "hidden"),
);

/**
 * 这条时间线条目该配哪张方案卡——**只有助手消息可能绑到方案**（绑定表由
 * `planTimeline.planActivityBindings` 算，见 utils/planTimeline.ts），其余条目一律 null。
 *
 * 为什么由视图算而不是行组件自己找：绑定要的是"当前需求"的上下文（`planBindings`），
 * 那是视图与 `useExplorerTimeline` 的事；行组件只负责把它摆出来。
 */
function planForTimelineItem(item: ExplorerTimelineItem): Plan | null {
  return item.kind === "activity" ? planForActivity(item.activity) : null;
}

/**
 * 时间线滚动状态（"是否已到底"与两条激活键）交给 composable。
 * `timeline` 的模板 ref 留在本文件——`ref="timeline"` 要求它是个顶层绑定。
 */
const { activePlanKey, activeTimelineKey, jumpToLatest, jumpToTimelineTarget, showScrollToLatest, updateTimelineScrollState } =
  useTimelineScroll(timeline, { visibleActivity, planBindings });

/**
 * 三条 SSE 通道及其生命周期交给 composable；视图只提供状态 ref、刷新回调与 load 回调。
 * `explorerEventSequence` 由 usePlanProjection 持有，SSE 侧只读它构造续传 URL。
 */
const { connectEvents, connectLoopEvents, connectLoopEventsIfConnected, closeEvents, closeRequirementStatusEvents } = useExplorerSse({
  projectId,
  thread,
  explorers,
  activeExplorerPlan,
  explorerPlans,
  turns,
  agentLoop,
  explorerPaused,
  explorerEventSequence,
  timeline,
  projectScopeToken,
  isCurrentProjectScope,
  refreshActivity,
  refreshPlanProjection,
  scheduleProjectionRefresh,
  cancelProjectionRefresh,
  adoptInputRequest,
  load,
});

function setPolicyOpen(value: boolean) {
  policyOpen.value = value ? openPolicyPanel(policyOpen.value) : closePolicyPanel(policyOpen.value);
}

type ThreadActionCommand = "toggle-pause" | "rename" | "policy" | "refresh" | "delete";

function openRenameDialog() {
  if (!thread.value) return;
  renameError.value = null;
  renameDialogOpen.value = true;
}

function handleThreadAction(command: ThreadActionCommand) {
  if (command === "delete") {
    void deleteCurrentThread();
    return;
  }
  if (command === "toggle-pause") {
    void toggleExplorerPause();
    return;
  }
  if (command === "rename") {
    openRenameDialog();
    return;
  }
  if (command === "policy") {
    setPolicyOpen(true);
    return;
  }
  void refreshThread();
}

async function deleteCurrentThread(): Promise<void> {
  const currentThread = thread.value;
  const requestProjectId = projectId.value;
  if (!currentThread || !requestProjectId || explorerActionId.value) return;
  const requestThreadId = currentThread.id;
  explorerActionId.value = requestThreadId;
  error.value = null;
  try {
    await ElMessageBox.confirm(
      "删除后，该线程、关联 Task、Plan、运行记录和执行日志将无法恢复。已结束运行的本地 worktree 不会自动清理。",
      `删除 ${currentThread.title}？`,
      { type: "warning", confirmButtonText: "永久删除线程", cancelButtonText: "取消", distinguishCancelAndClose: true },
    );
    const response = await api.deleteExplorer(requestProjectId, requestThreadId);
    if (projectId.value !== requestProjectId) return;
    closeEvents();
    invalidateProjectScope();
    resetThreadState();
    project.value = response.project;
    explorers.value = [
      response.replacementExplorer,
      ...explorers.value.filter((item) => item.id !== response.deletedExplorerId && item.id !== response.replacementExplorer.id),
    ];
    thread.value = response.replacementExplorer;
    suppressNextExplorerRouteReload = true;
    try {
      await router.push({ path: route.path, query: explorerRouteQuery(response.replacementExplorer.id), hash: "" });
    } catch (caught) {
      suppressNextExplorerRouteReload = false;
      throw caught;
    }
    // Reload the directory so the replacement thread and its default Task are
    // read back from the same store snapshot as the delete response. This
    // avoids loading a stale replacement object during the route transition.
    const loaded = await load();
    if (loaded && mounted.value) connectEvents();
    if (loaded) ElMessage.success(`线程已删除，已切换到 ${thread.value?.title ?? response.replacementExplorer.title}`);
    else ElMessage.warning("线程已删除，但替代线程详情加载失败，请点击 Retry");
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    const message = caught instanceof Error ? caught.message : "线程删除失败";
    error.value = message;
    ElMessage.error(message);
  } finally {
    if (projectId.value === requestProjectId) {
      explorerActionId.value = null;
      loading.value = false;
      explorerLoading.value = false;
    }
  }
}

async function renameThread(title: string) {
  const currentThread = thread.value;
  const requestProjectId = projectId.value;
  if (!currentThread || !requestProjectId || renameSaving.value) return;
  const requestThreadId = currentThread.id;
  renameSaving.value = true;
  renameError.value = null;
  try {
    const response = await api.renameExplorer(requestProjectId, requestThreadId, title);
    if (!isCurrentProjectScope(requestProjectId) || thread.value?.id !== requestThreadId) return;
    thread.value = response.explorer;
    explorers.value = explorers.value.map((item) => (item.id === requestThreadId ? response.explorer : item));
    renameDialogOpen.value = false;
    ElMessage.success("Thread renamed");
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId) || thread.value?.id !== requestThreadId) return;
    renameError.value = caught instanceof Error ? caught.message : "Thread rename failed";
    ElMessage.error(renameError.value);
  } finally {
    if (isCurrentProjectScope(requestProjectId) && thread.value?.id === requestThreadId) renameSaving.value = false;
  }
}

async function toggleExplorerPause() {
  if (agentLoop.value && ["RUNNING", "PAUSED"].includes(agentLoop.value.state)) {
    try {
      const response =
        agentLoop.value.state === "PAUSED"
          ? await api.resumeAgentLoop(agentLoop.value.id)
          : await api.pauseAgentLoop(agentLoop.value.id, "user_requested");
      agentLoop.value = response.loop;
      explorerPaused.value = response.loop.state === "PAUSED";
      ElMessage.info(explorerPaused.value ? "Explorer Loop 已暂停" : "Explorer Loop 已恢复");
    } catch (caught) {
      ElMessage.error(caught instanceof Error ? caught.message : "Explorer Loop 控制失败");
    }
    return;
  }
  explorerPaused.value = !explorerPaused.value;
  ElMessage.info(explorerPaused.value ? "ExplorerThread 已暂停" : "ExplorerThread 已恢复");
}

async function refreshThread() {
  await load();
  if (!error.value) ElMessage.success("ExplorerThread 已刷新");
}

/** 只负责把绑定表喂给 utils 里的纯查找。 */
function planForActivity(item: ExplorerActivityItem): Plan | null {
  return planForActivityIn(item, planBindings.value);
}

function isCandidatePlan(plan: Plan | null): boolean {
  return isCandidatePlanFor(plan, candidate.value);
}

function resetThreadState() {
  closeRequirementStatusEvents();
  resetSessionState();
  // 抽屉详情由 composable 自己重置（同时作废在途请求）。此前这里把同一组 7 行重置写了两遍、
  // 第二遍还漏了 detailLoadError——两处要保持同步的写法正是要消掉的东西。
  resetDetailState();
  resetPlanProjection();
  requirementDrafts.clear();
  draft.value = "";
  planCenterCount.value = 0;
  resetInputState();
  agentLoop.value = null;
  policyOpen.value = false;
  renameDialogOpen.value = false;
  renameError.value = null;
  renameSaving.value = false;
  explorerPaused.value = false;
  activeTimelineKey.value = "";
  activePlanKey.value = "";
  busy.value = false;
  pendingSendPlanIds.value = new Set();
}

/** 项目切换时保留目录投影，清空旧线程数据，避免旧 SSE 或异步请求重新填充当前工作区。 */
function resetProjectState(nextProjectId = projectId.value) {
  project.value = projects.value.find((item) => item.id === nextProjectId) ?? null;
  explorers.value = [];
  projectRuns.value = [];
  showArchivedExplorers.value = false;
  resetThreadState();
}

function syncHashPanel(hash: string) {
  if (hash === "#candidate") contextPanel.value = "candidate";
  if (hash === "#confirmed") contextPanel.value = "confirmed";
  if (hash === "#attention") contextPanel.value = "attention";
  if (hash === "#candidate" && candidate.value) openPlanDetail(candidate.value);
}

/** 从任何 Plan 详情回到其原始 Explorer；清理确认由服务端强制，前端只负责明确告知不可逆后果。 */
async function keepEditingPlan(plan: Plan): Promise<void> {
  const planId = plan.id ?? plan.planId;
  if (!planId || busy.value) return;
  if (plan.status === "DRAFT") {
    if (!plan.explorerPlanId) {
      ElMessage.error("此 Plan 缺少需求归属，无法打开编辑聊天");
      return;
    }
    busy.value = true;
    try {
      await api.selectCandidatePlan(projectId.value, plan.sourceExplorerThreadId, plan.explorerPlanId, planId);
      drawerOpen.value = false;
      await router.push({
        path: `/projects/${projectId.value}/explorer`,
        query: { explorerId: plan.sourceExplorerThreadId, explorerPlanId: plan.explorerPlanId, contextPanel: "plans" },
      });
      ElMessage.success(`已打开 ${plan.title} · V${plan.revision}；下一次完整 READY 会保存为 V${plan.revision + 1}`);
    } catch (caught) {
      ElMessage.error(caught instanceof Error ? caught.message : "Plan 编辑入口加载失败");
    } finally {
      busy.value = false;
    }
    return;
  }
  busy.value = true;
  try {
    let result;
    try {
      result = await api.createRevisionDraft(planId, plan.revision, {
        explorerThreadId: plan.sourceExplorerThreadId,
        discardUnmergedRun: false,
        clientRequestId: `keep-editing-${planId}-${plan.revision}`,
      });
    } catch (caught) {
      /**
       * **按 `code` 判，不按 message 判。** `ApiRequestError.message` 装的是服务端那句人话
       * （`body.error`），码在 `body.code` 里——此前这里比的是人话，于是"弹确认框 → 带
       * `discardUnmergedRun` 重试"这一段**从来没执行过**：用户点「继续编辑 V2」只会看到一条
       * 英文红条，而那条路本来应该先问一句再清理（实测报障就是这个）。
       */
      if (!(caught instanceof ApiRequestError) || caught.body?.code !== "UNMERGED_RUN_CONFIRMATION_REQUIRED") throw caught;
      const unmerged = Array.isArray(caught.body?.runs) ? caught.body.runs.filter((id): id is string => typeof id === "string") : [];
      await ElMessageBox.confirm(
        `这条 V${plan.revision} 上还有一个没合并的运行${unmerged.length ? `（${unmerged.join("、")}）` : ""}：继续会终止它的 Executor、清理它的 worktree、并执行 cleanup 钩子。Run、执行线程与审计日志都会留着。`,
        `清理未合并的运行，编辑 V${plan.revision + 1}`,
        { type: "warning", confirmButtonText: `清理并编辑 V${plan.revision + 1}`, cancelButtonText: "取消" },
      );
      result = await api.createRevisionDraft(planId, plan.revision, {
        explorerThreadId: plan.sourceExplorerThreadId,
        discardUnmergedRun: true,
        clientRequestId: `keep-editing-cleanup-${planId}-${plan.revision}`,
      });
    }
    drawerOpen.value = false;
    await router.push({ path: `/projects/${projectId.value}/explorer`, query: { ...route.query, explorerId: result.explorerThread.id } });
    await nextTick();
    if (timeline.value) scrollTimelineToLatest(timeline.value);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus();
    ElMessage.success(`正在编辑 ${planId} · V${plan.revision} → V${result.draft.targetRevision}`);
  } catch (caught) {
    if (caught !== "cancel") ElMessage.error(caught instanceof Error ? caught.message : "继续编辑失败");
  } finally {
    busy.value = false;
  }
}

function syncPanelStateFromRoute() {
  const routeContextPanel = route.query.contextPanel;
  if (
    routeContextPanel === "candidate" ||
    routeContextPanel === "plans" ||
    routeContextPanel === "confirmed" ||
    routeContextPanel === "enqueued" ||
    routeContextPanel === "dispatched" ||
    routeContextPanel === "active" ||
    routeContextPanel === "attention" ||
    routeContextPanel === "plan-center"
  )
    contextPanel.value = routeContextPanel;
}

function panelStateQuery() {
  return { contextPanel: contextPanel.value };
}

function explorerRouteQuery(explorerId?: string, explorerPlanId?: string | null, preserveRun = false) {
  const query = { ...route.query };
  delete query.leftPanel;
  delete query.workspace;
  delete query.requirementTab;
  if (!preserveRun) delete query.runId;
  if (explorerId) query.explorerId = explorerId;
  if (explorerPlanId) query.explorerPlanId = explorerPlanId;
  else if (explorerPlanId === null || explorerId) delete query.explorerPlanId;
  return { ...query, ...panelStateQuery() };
}

async function openRunView(runId: string, explorerId?: string | null, explorerPlanId?: string | null): Promise<void> {
  if (!runId) return;
  drawerTab.value = "task";
  drawerOpen.value = true;
  const query: Record<string, string | string[] | null | undefined> = { ...route.query, runId, requirementTab: "task" };
  if (explorerId) query.explorerId = explorerId;
  if (explorerPlanId) query.explorerPlanId = explorerPlanId;
  else if (explorerPlanId === null) delete query.explorerPlanId;
  await router.push({ path: route.path, query });
}

async function closeRunView(): Promise<void> {
  if (!activeRunId.value) return;
  const query = { ...route.query };
  delete query.runId;
  await router.push({ path: route.path, query, hash: route.hash });
}

async function createExplorer() {
  if (creatingExplorer.value) return;
  const requestProjectId = projectId.value;
  creatingExplorer.value = true;
  closeEvents();
  invalidateProjectScope();
  resetThreadState();
  try {
    const created = await api.createExplorer(requestProjectId);
    if (projectId.value !== requestProjectId) return;
    explorers.value = [created.explorer, ...explorers.value.filter((item) => item.id !== created.explorer.id)];
    explorerError.value = null;
    thread.value = created.explorer;
    try {
      project.value = (await api.selectProjectExplorer(requestProjectId, created.explorer.id)).project;
    } catch {
      /* Legacy API instances may not have a Project registry yet. */
    }
    await router.push({ path: route.path, query: explorerRouteQuery(created.explorer.id), hash: "" });
    const requestToken = beginProjectScope(requestProjectId);
    loading.value = true;
    error.value = null;
    const loaded = await loadExplorerDetails(created.explorer, requestProjectId, requestToken);
    if (loaded && mounted.value) connectEvents();
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? `新建 Explorer 失败：${caught.message}` : "新建 Explorer 失败");
  } finally {
    if (projectId.value === requestProjectId) loading.value = false;
    creatingExplorer.value = false;
  }
}

function switchProject(selectedProjectId: string) {
  void router.push({
    path: projectPathForModule("explore", selectedProjectId),
    query: { contextPanel: contextPanel.value, ...(projectExecutionMode.value ? { workspace: "project-execution" } : {}) },
  });
}

function selectProjectExecution() {
  closeEvents();
  closeRequirementStatusEvents();
  invalidateProjectScope();
  resetThreadState();
  thread.value = null;
  const query: import("vue-router").LocationQueryRaw = { ...route.query, workspace: "project-execution" };
  delete query.runId;
  delete query.explorerPlanId;
  void router.push({ path: route.path, query, hash: "" });
}

function openProjectCreateDialog() {
  projectCreateOpen.value = true;
}

async function handleProjectCreated(createdProject: Project) {
  projectCreateOpen.value = false;
  projects.value = [createdProject, ...projects.value.filter((item) => item.id !== createdProject.id)];
  await router.push({ path: projectPathForModule("explore", createdProject.id), query: { contextPanel: contextPanel.value }, hash: "" });
}

function openProjectSettingsDialog(selectedProjectId: string, tab: string | null = null) {
  projectSettingsProjectId.value = selectedProjectId;
  projectSettingsInitialTab.value = tab;
  projectSettingsOpen.value = true;
}

function closeProjectSettings(value: boolean) {
  projectSettingsOpen.value = value;
  if (!value) {
    projectSettingsProjectId.value = null;
    projectSettingsInitialTab.value = null;
  }
}

/**
 * 退役的「项目设置」整页地址重定向到这里时带的 `settings=1`（见 router.ts）。
 *
 * **一次性消费**：打开对话框后立刻把参数摘掉。不摘的话有两个后果——在同一个项目里再导航到
 * 这个地址不会触发（query 没变，组件不重挂），以及用户关掉对话框后一刷新它又自己弹开。
 */
function consumeSettingsQuery() {
  if (route.query.settings !== "1") return;
  const target = projectId.value;
  const tab = typeof route.query.tab === "string" ? route.query.tab : null;
  if (target) openProjectSettingsDialog(target, tab);
  const query = { ...route.query };
  delete query.settings;
  delete query.tab;
  void router.replace({ path: route.path, query, hash: route.hash });
}

async function handleProjectSettingsSaved(savedProject: Project) {
  projects.value = projects.value.map((item) => (item.id === savedProject.id ? { ...item, ...savedProject } : item));
  if (project.value?.id === savedProject.id) project.value = savedProject;
  if (project.value?.id === savedProject.id) await refreshPlanProjection();
}

async function toggleProjectArchive(selectedProjectId: string) {
  if (projectActionId.value) return;
  const selectedProject = projects.value.find((item) => item.id === selectedProjectId);
  if (!selectedProject) return;
  projectActionId.value = selectedProjectId;
  error.value = null;
  try {
    let response: { project: Project };
    if (selectedProject.status === "ACTIVE") {
      await ElMessageBox.confirm("归档后项目历史仍可查看，但不能创建新的 Explorer Turn 或 Run。", `归档 ${selectedProject.name}？`, {
        type: "warning",
        confirmButtonText: "归档项目",
        cancelButtonText: "取消",
      });
      response = await api.archiveProject(selectedProjectId);
      ElMessage.success("项目已归档");
    } else {
      response = await api.activateProject(selectedProjectId);
      ElMessage.success("项目已恢复");
    }
    projects.value = projects.value.map((item) => (item.id === selectedProjectId ? { ...item, ...response.project } : item));
    if (project.value?.id === selectedProjectId) project.value = response.project;
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    const message = caught instanceof Error ? caught.message : "项目状态更新失败";
    error.value = message;
    ElMessage.error(message);
  } finally {
    projectActionId.value = null;
  }
}

async function selectExplorer(explorerId: string) {
  if (explorerId === thread.value?.id && !projectExecutionMode.value) return;
  closeEvents();
  invalidateProjectScope();
  resetThreadState();
  const selected = explorers.value.find((item) => item.id === explorerId);
  if (selected?.state !== "ARCHIVED") {
    try {
      project.value = (await api.selectProjectExplorer(projectId.value, explorerId)).project;
    } catch {
      /* Keep navigation available for legacy API instances. */
    }
  }
  await router.push({ path: route.path, query: explorerRouteQuery(explorerId), hash: "" });
}

async function selectExplorerPlan(explorerPlanId: string, shouldScroll = true): Promise<void> {
  const currentThread = thread.value;
  const selectedPlan = explorerPlans.value.find((plan) => plan.id === explorerPlanId);
  if (!currentThread || !selectedPlan || selectedPlan.explorerThreadId !== currentThread.id) return;
  const requestProjectId = projectId.value;
  const requestToken = projectScopeToken();
  const requestVersion = beginPlanProjection();
  const previousPlanId = activeExplorerPlanId.value;
  if (previousPlanId && previousPlanId !== selectedPlan.id) requirementDrafts.set(previousPlanId, draft.value);
  if (previousPlanId !== selectedPlan.id) draft.value = requirementDrafts.get(selectedPlan.id) ?? "";
  closeEvents();
  activeExplorerPlanId.value = selectedPlan.id;
  thread.value = { ...currentThread, activeExplorerPlanId: selectedPlan.id };
  try {
    const activation = await api.activateExplorerPlan(requestProjectId, currentThread.id, selectedPlan.id);
    if (
      !isCurrentProjectScope(requestProjectId, requestToken) ||
      !isCurrentPlanProjection(requestVersion) ||
      thread.value?.id !== currentThread.id
    )
      return;
    thread.value = activation.explorer;
    explorers.value = explorers.value.map((item) => (item.id === currentThread.id ? activation.explorer : item));
    try {
      const planGroupsResponse = await api.explorerPlanGroups(requestProjectId, currentThread.id);
      if (
        !isCurrentProjectScope(requestProjectId, requestToken) ||
        !isCurrentPlanProjection(requestVersion) ||
        thread.value?.id !== currentThread.id
      )
        return;
      explorerPlans.value = planGroupsResponse.items;
    } catch {
      // Task workspace switching remains available when the background tree refresh is temporarily unavailable.
    }
    if (
      !isCurrentProjectScope(requestProjectId, requestToken) ||
      !isCurrentPlanProjection(requestVersion) ||
      thread.value?.id !== currentThread.id
    )
      return;
    await router.replace({ path: route.path, query: explorerRouteQuery(currentThread.id, selectedPlan.id), hash: route.hash });
    await loadActivePlanWorkspace(currentThread.id, selectedPlan.id, requestProjectId, requestToken);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== currentThread.id) return;
    connectEvents();
    if (shouldScroll) {
      await nextTick();
      jumpToTimelineTarget(explorerPlanAnchorId(selectedPlan.id), `explorer-plan-${selectedPlan.id}`);
      const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      composer?.focus();
    }
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? `需求工作区加载失败：${caught.message}` : "需求工作区加载失败");
  }
}

/**
 * 打开「新增需求」。**只负责开对话框**——建需求、切线程、起探索回合都在 `createRequirement` 里，
 * 失败时把话写回对话框（而不是弹个会自己消失的 toast：那条描述还在输入框里，用户要看着错误改它）。
 */
function openAddRequirementDialog(): void {
  const currentThread = thread.value;
  if (!currentThread || currentThread.state === "ARCHIVED" || project.value?.status === "ARCHIVED") return;
  requirementError.value = null;
  requirementDialogOpen.value = true;
}

/** 拿着对话框里那段描述走完"建需求 → 选中 → 打开探索对话 → 把它当成第一条消息发出去"。 */
async function createRequirement(description: string): Promise<void> {
  const currentThread = thread.value;
  const requestProjectId = projectId.value;
  if (!currentThread || !requestProjectId || requirementSubmitting.value) return;
  requirementSubmitting.value = true;
  requirementError.value = null;
  try {
    const response = await api.createExplorerPlan(requestProjectId, currentThread.id);
    if (thread.value?.id !== currentThread.id) return;
    explorerPlans.value = [...explorerPlans.value, response.explorerPlan].sort((a, b) => a.ordinal - b.ordinal);
    thread.value = response.explorer;
    await selectExplorerPlan(response.explorerPlan.id, false);
    if (thread.value?.id !== currentThread.id) return;
    drawerTab.value = "explorer";
    drawerOpen.value = true;
    draft.value = description;
    await router.replace({
      path: route.path,
      query: { ...route.query, explorerId: currentThread.id, explorerPlanId: response.explorerPlan.id, requirementTab: "explorer" },
    });
    await nextTick();
    document.querySelector<HTMLTextAreaElement>(".drawer-conversation-column .composer textarea")?.focus();
    await sendTurn();
    requirementDialogOpen.value = false;
  } catch (caught) {
    requirementError.value = caught instanceof Error ? `新建需求失败：${caught.message}` : "新建需求失败";
  } finally {
    requirementSubmitting.value = false;
  }
}

async function selectRequirement(explorerPlanId: string): Promise<void> {
  drawerOpen.value = false;
  drawerTab.value = "explorer";
  if (activeExplorerPlan.value?.id !== explorerPlanId) await selectExplorerPlan(explorerPlanId, false);
  const query = { ...route.query };
  delete query.runId;
  delete query.requirementTab;
  await router.replace({ path: route.path, query: { ...query, explorerPlanId } });
}

async function openRequirementChat(explorerPlanId: string): Promise<void> {
  drawerOpen.value = false;
  drawerTab.value = "explorer";
  if (activeExplorerPlan.value?.id !== explorerPlanId) await selectExplorerPlan(explorerPlanId, false);
  if (activeExplorerPlan.value?.id !== explorerPlanId) return;
  drawerOpen.value = true;
  await router.replace({
    path: route.path,
    query: { ...route.query, explorerId: thread.value?.id, explorerPlanId, requirementTab: "explorer" },
  });
}

async function returnToCurrentRequirementChat(): Promise<void> {
  const explorerPlanId = selectedRequirementRow.value?.explorerPlan.id;
  if (explorerPlanId) await openRequirementChat(explorerPlanId);
}

async function openRequirementPlan(explorerPlanId: string): Promise<void> {
  drawerOpen.value = false;
  if (activeExplorerPlan.value?.id !== explorerPlanId) await selectExplorerPlan(explorerPlanId, false);
  const row = requirementRows.value.find((item) => item.explorerPlan.id === explorerPlanId);
  if (row?.plan) await openPlanDetail(row.plan);
}

async function openRequirementTask(explorerPlanId: string): Promise<void> {
  drawerOpen.value = false;
  if (activeExplorerPlan.value?.id !== explorerPlanId) await selectExplorerPlan(explorerPlanId, false);
  const row = requirementRows.value.find((item) => item.explorerPlan.id === explorerPlanId);
  if (!row?.plan) return;
  drawerTab.value = "task";
  drawerOpen.value = true;
  const runId = row.run?.id ?? row.plan.runId ?? row.plan.dispatch?.runId;
  if (runId) {
    await openRunView(runId, thread.value?.id, explorerPlanId);
  } else {
    const query: Record<string, string | string[] | null | undefined> = {
      ...route.query,
      explorerId: thread.value?.id,
      explorerPlanId,
      requirementTab: "task",
    };
    delete query.runId;
    await router.replace({ path: route.path, query });
  }
}

function closeSharedDrawer(): void {
  drawerOpen.value = false;
  const query = { ...route.query };
  delete query.runId;
  delete query.requirementTab;
  void router.replace({ path: route.path, query });
}

function updateSharedDrawer(open: boolean): void {
  if (open) drawerOpen.value = true;
  else closeSharedDrawer();
}

function switchDrawerTab(tab: SharedDrawerTab): void {
  if (tab === "plan" && !selectedRequirementRow.value?.plan) return;
  if (tab === "task" && (!taskPanelPlan.value || selectedRequirementRow.value?.taskStatus.label === "—")) return;
  /**
   * **点页签就打开抽屉**，不靠下面那次 `router.replace` 触发 watch 来开。
   *
   * 刷新后 URL 里还留着 `requirementTab`（抽屉的关闭才清它），于是页签已经是"选中"态而抽屉是关的；
   * 这时再点同一个页签，`router.replace` 写进去的值没变，路由 watch 不触发，面板就开不了。
   * 面板开不开由这个函数说了算，路由只负责记住。
   */
  drawerOpen.value = true;
  if (tab === "plan" && selectedRequirementRow.value?.plan) {
    void openPlanDetail(selectedRequirementRow.value.plan);
    return;
  }
  if (tab === "task") {
    const row = selectedRequirementRow.value;
    const runId = row?.run?.id ?? row?.plan?.runId ?? row?.plan?.dispatch?.runId;
    if (runId) {
      void openRunView(runId, thread.value?.id, row?.explorerPlan.id);
      return;
    }
  }
  drawerTab.value = tab;
  const query: Record<string, string | string[] | null | undefined> = { ...route.query, requirementTab: tab };
  if (tab !== "task") delete query.runId;
  void router.replace({ path: route.path, query });
}

/** 打开「重命名需求」；真正改名在 `submitRenameRequirement` 里（对话框只管输入）。 */
function renameExplorerPlan(explorerPlanId: string): void {
  const current = explorerPlans.value.find((plan) => plan.id === explorerPlanId);
  if (!current) return;
  renameRequirementId.value = current.id;
  renameRequirementError.value = null;
}

async function submitRenameRequirement(title: string): Promise<void> {
  const currentThread = thread.value;
  const target = renameRequirementTarget.value;
  if (!currentThread || !target || renameRequirementSaving.value) return;
  renameRequirementSaving.value = true;
  renameRequirementError.value = null;
  try {
    const response = await api.renameExplorerPlan(projectId.value, currentThread.id, target.id, title);
    if (thread.value?.id !== currentThread.id) return;
    explorerPlans.value = explorerPlans.value.map((plan) => (plan.id === target.id ? response.explorerPlan : plan));
    renameRequirementOpen.value = false;
    ElMessage.success("需求已重命名");
  } catch (caught) {
    renameRequirementError.value = caught instanceof Error ? `重命名需求失败：${caught.message}` : "重命名需求失败";
  } finally {
    renameRequirementSaving.value = false;
  }
}

/**
 * 删除一条需求（连同它的方案、Run、执行日志与提问，不可恢复）。
 *
 * 两处刻意的分寸：
 *   1) **前端不预判能不能删**：能不能删由服务端说了算（有在跑的 Run/Loop 就拒，最后一条也拒）。
 *      在前端复刻一套"哪些 Run 状态算在跑"，就多了一份随时会漂的事实来源。这里只负责把
 *      服务端回来的两个 code 翻成人话——它们对应两种完全不同的处置（去停掉 / 别白费劲）。
 *   2) 删掉的**正好是当前打开的那条**时才动选中项，落到服务端指定的接任者上；否则什么都不动，
 *      用户看的是别的需求，不该被跳走。
 */
function deleteExplorerPlan(explorerPlanId: string): void {
  const current = explorerPlans.value.find((plan) => plan.id === explorerPlanId);
  if (!current || explorerActionId.value) return;
  deleteRequirementId.value = current.id;
  deleteRequirementError.value = null;
}

/** 确认框里按下「永久删除」之后才走这里——**对话框只负责问，删是这一步的事**。 */
async function confirmDeleteExplorerPlan(): Promise<void> {
  const currentThread = thread.value;
  const target = deleteRequirementTarget.value;
  const requestProjectId = projectId.value;
  if (!currentThread || !target || !requestProjectId || deleteRequirementSaving.value) return;
  // 用 explorerActionId 当"有 explorer 动作在飞"的门闩（与删除线程、归档线程共用同一个），
  // 防止确认框刚关掉时的连点。
  deleteRequirementSaving.value = true;
  explorerActionId.value = target.id;
  error.value = null;
  try {
    const response = await api.deleteExplorerPlan(requestProjectId, currentThread.id, target.id);
    if (thread.value?.id !== currentThread.id) return;
    explorerPlans.value = response.explorerPlans;
    thread.value = response.explorer;
    explorers.value = explorers.value.map((item) => (item.id === response.explorer.id ? response.explorer : item));
    deleteRequirementOpen.value = false;
    ElMessage.success(`已删除「${target.title}」`);
    if (activeExplorerPlanId.value === target.id && response.explorer.activeExplorerPlanId)
      await selectExplorerPlan(response.explorer.activeExplorerPlanId);
  } catch (caught) {
    const code = caught instanceof ApiRequestError ? caught.body?.code : undefined;
    // 失败**留在框里**：这句话是给用户下一步动作的（去停掉、或改用删除线程），
    // 弹成 toast 会自己消失，而他正对着这个框。
    deleteRequirementError.value =
      code === "EXPLORER_DELETE_BLOCKED"
        ? "这条需求还有在跑的 Run 或探索回合，先把它停掉再删。"
        : code === "EXPLORER_PLAN_DELETE_FORBIDDEN"
          ? "线程里最后一条需求不能删——线程至少要留一条。要清掉整条线程，用左栏的「删除线程」。"
          : caught instanceof Error
            ? `删除需求失败：${caught.message}`
            : "删除需求失败";
  } finally {
    deleteRequirementSaving.value = false;
    if (projectId.value === requestProjectId) explorerActionId.value = null;
  }
}

async function toggleExplorerArchive(explorerId: string) {
  if (explorerActionId.value) return;
  const selected = explorers.value.find((item) => item.id === explorerId);
  if (!selected) return;
  if (selected.state !== "ARCHIVED" && selected.id === thread.value?.id) {
    ElMessage.warning("当前线程不能归档，请先切换到其他线程");
    return;
  }
  explorerActionId.value = explorerId;
  error.value = null;
  try {
    if (selected.state === "ARCHIVED") {
      const response = await api.activateExplorer(projectId.value, explorerId);
      explorers.value = explorers.value.map((item) => (item.id === explorerId ? response.explorer : item));
      if (thread.value?.id === explorerId) thread.value = response.explorer;
      else await selectExplorer(explorerId);
      ElMessage.success("线程已恢复");
      return;
    }
    await ElMessageBox.confirm("归档后线程历史仍可查看，但不能继续创建新的 Explorer Turn。", `归档 ${selected.title}？`, {
      type: "warning",
      confirmButtonText: "归档线程",
      cancelButtonText: "取消",
    });
    const response = await api.archiveExplorer(projectId.value, explorerId);
    explorers.value = explorers.value.map((item) => (item.id === explorerId ? response.explorer : item));
    ElMessage.success("线程已归档");
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    const message = caught instanceof Error ? caught.message : "线程状态更新失败";
    error.value = message;
    ElMessage.error(message);
  } finally {
    explorerActionId.value = null;
  }
}

async function loadExplorerDetails(selected: ExplorerThread, requestProjectId: string, requestToken: number): Promise<boolean> {
  try {
    const [planGroupsResponse, plansResponse, confirmedResponse, threadPlansResponse] = await Promise.all([
      api.explorerPlanGroups(requestProjectId, selected.id),
      api.explorerPlans(requestProjectId, selected.id),
      optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id)),
      api.explorerThreadPlans(requestProjectId, selected.id),
    ]);
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    explorerPlans.value = planGroupsResponse.items;
    threadPlans.value = threadPlansResponse.items;
    const routePlanId = typeof route.query.explorerPlanId === "string" ? route.query.explorerPlanId : null;
    const routeRun = typeof route.query.runId === "string" ? projectRuns.value.find((run) => run.id === route.query.runId) : undefined;
    const runPlan = routeRun
      ? threadPlans.value.find((plan) => (plan.planId ?? plan.id) === routeRun.planId && plan.revision === routeRun.planRevision)
      : undefined;
    const runExplorerPlanId = runPlan?.explorerPlanId;
    activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === routePlanId)
      ? routePlanId
      : explorerPlans.value.some((plan) => plan.id === runExplorerPlanId)
        ? (runExplorerPlanId ?? null)
        : explorerPlans.value.some((plan) => plan.id === selected.activeExplorerPlanId)
          ? (selected.activeExplorerPlanId ?? null)
          : (explorerPlans.value[0]?.id ?? null);
    const projection = normalizePlanProjection(selected, null, plansResponse.items);
    applyPlanProjection(projection, confirmedResponse?.items ?? [], null);
    const workspaceLoaded = await loadActivePlanWorkspace(selected.id, activeExplorerPlanId.value, requestProjectId, requestToken);
    if (!workspaceLoaded) return false;
    connectLoopEventsIfConnected();
    explorerPaused.value = agentLoop.value?.state === "PAUSED";
    const routeDrawerTab = route.query.requirementTab;
    if (activeRunId.value) {
      drawerTab.value = "task";
      drawerOpen.value = true;
    } else if (routePlanId && activeExplorerPlan.value) {
      /**
       * **只记住页签，不打开抽屉** —— 刷新页面不该弹出右侧面板。
       *
       * `explorerPlanId` 是"当前选中哪个需求"的**常规路由状态**：每选中一个需求都会写进 URL。
       * 按它打开抽屉，等于"每次刷新都自动弹一次面板"，而用户并没有要求看它（实测报障）。
       * 要打开由用户自己点。页签仍然按 URL 记住，这样他点开时落在原来那一页。
       *
       * `runId` 那条不在此列：它只在明确"看这条 Run"时才会出现在地址里，属于有意的深链接。
       */
      drawerTab.value = routeDrawerTab === "plan" || routeDrawerTab === "task" ? routeDrawerTab : "explorer";
    }
    await nextTick();
    updateTimelineScrollState();
    return true;
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    error.value = caught instanceof Error ? caught.message : "Explorer 详情加载失败";
    return false;
  }
}

async function loadExplorerDirectory(requestProjectId: string, requestToken: number): Promise<boolean> {
  const [healthResponse, projectListResponse, projectResponse, explorerResponse, projectRunsResponse, requirementsResponse] =
    await Promise.all([
      optional(() => api.health()),
      optional(() => api.projects()),
      api.project(requestProjectId),
      api.explorers(requestProjectId),
      api.projectRuns(requestProjectId),
      optional(() => api.explorerPlanRequirements()),
    ]);
  if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  projects.value = projectListResponse?.items ?? [];
  project.value = projectResponse.project;
  if (healthResponse?.model) explorerModel.value = healthResponse.model;
  explorers.value = explorerResponse.items;
  projectRuns.value = projectRunsResponse.items;
  planRequirements.value = requirementsResponse?.requirements.areas ?? DEFAULT_EXPLORER_PLAN_REQUIREMENTS;
  explorerError.value = null;

  // 固定执行线程只加载项目目录；没有 Explorer 时不能为进入执行模式而
  // 隐式创建 Explorer/ExplorerPlan。
  if (projectExecutionMode.value) {
    thread.value = null;
    return true;
  }

  const routeExplorerId = typeof route.query.explorerId === "string" ? route.query.explorerId : null;
  let selected = routeExplorerId ? explorerResponse.items.find((item) => item.id === routeExplorerId) : undefined;
  if (!routeExplorerId && projectResponse.project.currentExplorerThreadId)
    selected = explorerResponse.items.find((item) => item.id === projectResponse.project.currentExplorerThreadId);
  if (!routeExplorerId && thread.value) selected = explorerResponse.items.find((item) => item.id === thread.value?.id);
  if (!selected)
    selected = explorerResponse.items.find((item) => item.state !== "ARCHIVED" && item.contextMode === "FRESH" && item.messageCount === 0);
  if (!selected) {
    selected = (await api.createExplorer(requestProjectId)).explorer;
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    explorers.value = [selected, ...explorers.value.filter((item) => item.id !== selected?.id)];
    try {
      project.value = (await api.selectProjectExplorer(requestProjectId, selected.id)).project;
    } catch {
      /* Keep the directory usable for legacy API instances. */
    }
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  }
  if (!selected) return false;
  thread.value = selected;
  const loaded = await loadExplorerDetails(selected, requestProjectId, requestToken);
  if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  if (
    typeof route.query.explorerId !== "string" ||
    route.query.explorerId !== selected.id ||
    route.query.explorerPlanId !== activeExplorerPlanId.value
  ) {
    await router.replace({ path: route.path, query: explorerRouteQuery(selected.id, activeExplorerPlanId.value, true), hash: route.hash });
  }
  return loaded;
}

/** 先加载 Project/Explorer 目录，再加载当前线程详情，避免详情失败清空已成功的目录。 */
async function load(): Promise<boolean> {
  const requestProjectId = projectId.value;
  const requestToken = beginProjectScope(requestProjectId);
  loading.value = true;
  explorerLoading.value = true;
  error.value = null;
  explorerError.value = null;
  try {
    return await loadExplorerDirectory(requestProjectId, requestToken);
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    project.value = projects.value.find((item) => item.id === requestProjectId) ?? null;
    explorerError.value = caught instanceof Error ? caught.message : "Explorer 线程列表加载失败";
    error.value = explorerError.value;
    return false;
  } finally {
    if (isCurrentProjectScope(requestProjectId, requestToken)) {
      loading.value = false;
      explorerLoading.value = false;
    }
  }
}

/** 先乐观写入用户消息，再由 v4 API/SSE 补齐 Provider 输出和 Plan 活动。 */
async function sendTurn(): Promise<boolean> {
  const content = draft.value.trim();
  if (
    !content ||
    activePlanBusy.value ||
    sendingCurrentPlan.value ||
    busy.value ||
    !thread.value ||
    thread.value.state === "ARCHIVED" ||
    project.value?.status === "ARCHIVED"
  )
    return false;
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = projectScopeToken();
  const now = new Date().toISOString();
  const currentPlanId = activeExplorerPlan.value?.id ?? thread.value.activeExplorerPlanId ?? undefined;
  if (!currentPlanId) {
    ElMessage.error("请先选择一个需求再发送消息");
    return false;
  }
  requirementDrafts.delete(currentPlanId);
  const previousFailure = failedExplorerSends.get(currentPlanId);
  const retrying = previousFailure?.content === content ? previousFailure : null;
  const optimisticUser = retrying
    ? (turns.value.find((turn) => turn.id === retrying.optimisticUserId) ??
      createOptimisticUserTurn({
        id: retrying.optimisticUserId,
        threadId: requestThreadId,
        content,
        createdAt: now,
        sequence: turns.value.length + 1,
      }))
    : createOptimisticUserTurn({
        id: `local-user-${Date.now()}`,
        threadId: requestThreadId,
        content,
        createdAt: now,
        sequence: turns.value.length + 1,
      });
  optimisticUser.explorerPlanId = currentPlanId;
  let assistantActivityId = retrying?.assistantActivityId ?? "";
  if (retrying) {
    if (retrying.failedAssistantTurnId) turns.value = turns.value.filter((turn) => turn.id !== retrying.failedAssistantTurnId);
    if (!turns.value.some((turn) => turn.id === optimisticUser.id)) turns.value = [...turns.value, optimisticUser];
    activity.value = activity.value.map((item) =>
      item.id === retrying.assistantActivityId ? { ...item, status: "RUNNING", summary: "Plan Explorer 正在处理…", occurredAt: now } : item,
    );
  } else {
    turns.value = [...turns.value, optimisticUser];
    assistantActivityId = `local-assistant-activity-${Date.now()}`;
    const optimisticAssistant: ExplorerActivityItem = {
      id: assistantActivityId,
      explorerId: optimisticUser.threadId,
      turnId: `local-assistant-turn-${Date.now()}`,
      sequence: optimisticUser.sequence + 1,
      kind: "ASSISTANT_MESSAGE",
      status: "RUNNING",
      title: "Plan Explorer",
      summary: "Plan Explorer 正在处理…",
      details: null,
      occurredAt: new Date().toISOString(),
      explorerPlanId: currentPlanId,
    };
    activity.value = [
      ...activity.value,
      {
        id: `local-user-activity-${optimisticUser.id}`,
        explorerId: optimisticUser.threadId,
        turnId: optimisticUser.id,
        sequence: optimisticUser.sequence,
        kind: "USER_MESSAGE",
        status: "COMPLETED",
        title: "You",
        summary: content,
        details: null,
        occurredAt: now,
        explorerPlanId: currentPlanId,
      },
      optimisticAssistant,
    ];
  }
  const failedSend: FailedExplorerSend = retrying ?? {
    content,
    clientTurnId: `client-turn-${Date.now()}`,
    optimisticUserId: optimisticUser.id,
    assistantActivityId,
    failedAssistantTurnId: null,
  };
  failedExplorerSends.set(currentPlanId, failedSend);
  draft.value = "";
  pendingSendPlanIds.value = new Set([...pendingSendPlanIds.value, currentPlanId]);
  await nextTick();
  if (drawerTab.value === "explorer" && timeline.value) scrollTimelineToLatest(timeline.value);
  try {
    const response = await api.startExplorerTurn(requestProjectId, requestThreadId, content, failedSend.clientTurnId, currentPlanId);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return false;
    if (response.loopId) {
      const loopResponse = await api.agentLoop(response.loopId);
      if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return false;
      agentLoop.value = loopResponse.loop;
      connectLoopEvents();
    }
    turns.value = settleOptimisticTurn(turns.value, optimisticUser.id, response.turn);
    activity.value = activity.value.filter((item) => item.id !== failedSend.assistantActivityId);
    failedExplorerSends.delete(currentPlanId);
    await refreshActivity();
    if (thread.value)
      thread.value = { ...thread.value, messageCount: thread.value.messageCount + 2, lastActivityAt: response.turn.assistant.createdAt };
    ElMessage.success("消息已发送");
    return true;
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return false;
    const message = caught instanceof Error ? caught.message : "API 未连接";
    const failedAssistantTurnId = `local-assistant-${Date.now()}`;
    turns.value = [
      ...turns.value,
      {
        id: failedAssistantTurnId,
        threadId: optimisticUser.threadId,
        role: "assistant",
        content: `消息发送失败：${message}。保留原描述，可在此需求中重试。`,
        status: "FAILED",
        error: message,
        createdAt: new Date().toISOString(),
        sequence: optimisticUser.sequence + 1,
        explorerPlanId: currentPlanId,
      },
    ];
    failedExplorerSends.set(currentPlanId, { ...failedSend, failedAssistantTurnId });
    draft.value = content;
    activity.value = activity.value.map((item) =>
      item.id === failedSend.assistantActivityId
        ? { ...item, status: "FAILED", summary: `消息发送失败：${message}。请重试。`, occurredAt: new Date().toISOString() }
        : item,
    );
    ElMessage.error(`消息发送失败：${message}。可以在当前需求中重试。`);
    return false;
  } finally {
    const pending = new Set(pendingSendPlanIds.value);
    pending.delete(currentPlanId);
    pendingSendPlanIds.value = pending;
    await nextTick();
    if (drawerTab.value === "explorer" && timeline.value) scrollTimelineToLatest(timeline.value);
  }
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (!shouldSubmitComposer(event)) return;
  event.preventDefault();
  void sendTurn();
}

function reloadExplorer() {
  closeEvents();
  invalidateProjectScope();
  resetThreadState();
  void load().then((loaded) => {
    if (loaded && mounted.value) connectEvents();
  });
}
async function reloadSelectedExplorer() {
  const requestProjectId = projectId.value;
  const routeExplorerId = typeof route.query.explorerId === "string" ? route.query.explorerId : null;
  const selected = routeExplorerId ? explorers.value.find((item) => item.id === routeExplorerId) : null;
  if (!selected) {
    reloadExplorer();
    return;
  }
  closeEvents();
  invalidateProjectScope();
  resetThreadState();
  thread.value = selected;
  const requestToken = beginProjectScope(requestProjectId);
  loading.value = true;
  error.value = null;
  const loaded = await loadExplorerDetails(selected, requestProjectId, requestToken);
  if (loaded && mounted.value) connectEvents();
  if (isCurrentProjectScope(requestProjectId, requestToken)) loading.value = false;
}
watch(() => route.hash, syncHashPanel);
watch(candidate, () => syncHashPanel(route.hash));
watch(projectId, (next, previous) => {
  if (!mounted.value || next === previous) return;
  closeEvents();
  invalidateProjectScope();
  resetProjectState(next);
  void load().then((loaded) => {
    if (loaded && mounted.value) connectEvents();
  });
});
watch(projectExecutionMode, (active, previous) => {
  if (!mounted.value || active === previous) return;
  closeEvents();
  closeRequirementStatusEvents();
  invalidateProjectScope();
  resetThreadState();
  if (active) {
    thread.value = null;
    void load();
  } else {
    void reloadSelectedExplorer();
  }
});
watch(
  () => route.query.explorerId,
  (routeExplorerId, previousExplorerId) => {
    if (!mounted.value || routeExplorerId === previousExplorerId || routeExplorerId === thread.value?.id) return;
    if (suppressNextExplorerRouteReload) {
      suppressNextExplorerRouteReload = false;
      return;
    }
    void reloadSelectedExplorer();
  },
);
watch(
  () => route.query.explorerPlanId,
  (routePlanId, previousPlanId) => {
    if (
      !mounted.value ||
      routePlanId === previousPlanId ||
      !thread.value ||
      typeof routePlanId !== "string" ||
      routePlanId === activeExplorerPlan.value?.id
    )
      return;
    void selectExplorerPlan(routePlanId, true);
  },
);
watch(activeRunId, (runId) => {
  if (!runId) return;
  drawerTab.value = "task";
  drawerOpen.value = true;
});
// 必须同时挂 watch 与 onMounted 两处：从 Explorer 自己跳到 `?settings=1` 时组件不重挂（只是 query 变了）。
watch(() => route.query.settings, consumeSettingsQuery);
watch(
  () => route.query.requirementTab,
  (tab) => {
    if (tab !== "explorer" && tab !== "plan" && tab !== "task") return;
    drawerTab.value = tab;
    drawerOpen.value = true;
  },
);
onMounted(() => {
  mounted.value = true;
  syncPanelStateFromRoute();
  consumeSettingsQuery();
  void loadModelBackends();
  void load().then((loaded) => {
    if (loaded) connectEvents();
  });
  syncHashPanel(route.hash);
});
onBeforeUnmount(() => {
  mounted.value = false;
  invalidateProjectScope();
  closeEvents();
  closeRequirementStatusEvents();
});
</script>

<template>
  <div :class="['console-layout', { 'project-execution-mode': projectExecutionMode }]">
    <ThreadRail
      :panel="leftPanel"
      :thread="thread"
      :project="project"
      :projects="projects"
      :explorers="explorers"
      :show-archived="showArchivedExplorers"
      :explorer-action-id="explorerActionId"
      :explorer-loading="explorerLoading"
      :explorer-error="explorerError"
      :creating-explorer="creatingExplorer"
      :project-action-id="projectActionId"
      :explorer-paused="explorerPaused"
      :project-execution-active="projectExecutionMode"
      @select-panel="leftPanel = $event"
      @create-explorer="createExplorer"
      @create-project="openProjectCreateDialog"
      @select-project="switchProject"
      @open-project="switchProject"
      @open-project-settings="openProjectSettingsDialog"
      @archive-project="toggleProjectArchive"
      @select-explorer="selectExplorer"
      @select-project-execution="selectProjectExecution"
      @toggle-show-archived="showArchivedExplorers = $event"
      @archive-explorer="toggleExplorerArchive"
      @thread-action="handleThreadAction"
    />
    <section class="conversation-column requirement-workspace-column">
      <ProjectExecutionThreadPanel v-if="projectExecutionMode" :project-id="projectId" :project="project" />
      <template v-else>
        <header class="requirement-workspace-header">
          <div>
            <div class="eyebrow">{{ project?.name ?? "PIPELINE FACTORY" }}</div>
            <h1>{{ thread ? explorerDisplayTitle(thread) : "探索" }}</h1>
            <p>在当前探索线程中查看和管理需求。</p>
          </div>
        </header>
        <div v-if="error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">重试</el-button></div>
        <ExplorerRequirementList
          :rows="requirementRows"
          :active-explorer-plan-id="activeExplorerPlan?.id ?? null"
          :disabled="!thread || thread.state === 'ARCHIVED' || project?.status === 'ARCHIVED'"
          @add="openAddRequirementDialog"
          @select="selectRequirement"
          @explore="openRequirementChat"
          @view-plan="openRequirementPlan"
          @open-task="openRequirementTask"
          @rename="renameExplorerPlan"
          @remove="deleteExplorerPlan"
        />
      </template>
    </section>
    <el-drawer
      v-if="!projectExecutionMode"
      :model-value="drawerOpen"
      class="shared-requirement-drawer"
      direction="rtl"
      size="min(900px, 96vw)"
      :with-header="false"
      :append-to-body="true"
      @update:model-value="updateSharedDrawer"
    >
      <div class="shared-drawer-shell">
        <header class="shared-drawer-header">
          <div class="shared-drawer-heading">
            <div class="eyebrow">{{ thread ? explorerDisplayTitle(thread) : "探索" }}</div>
            <h2 :title="sharedDrawerTitle">{{ sharedDrawerTitle }}</h2>
          </div>
          <el-button text circle aria-label="关闭详情抽屉" @click="closeSharedDrawer"><Close /></el-button>
        </header>
        <nav class="shared-drawer-tabs" role="tablist" aria-label="需求详情类型">
          <button
            type="button"
            role="tab"
            :aria-selected="drawerTab === 'explorer'"
            :class="{ active: drawerTab === 'explorer' }"
            @click="switchDrawerTab('explorer')"
          >
            探索对话
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="drawerTab === 'plan'"
            :disabled="!selectedRequirementRow?.plan"
            :class="{ active: drawerTab === 'plan' }"
            @click="switchDrawerTab('plan')"
          >
            Plan 详情
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="drawerTab === 'task'"
            :disabled="!taskPanelPlan || selectedRequirementRow?.taskStatus.label === '—'"
            :class="{ active: drawerTab === 'task' }"
            @click="switchDrawerTab('task')"
          >
            Run
          </button>
        </nav>
        <div class="shared-drawer-content">
          <section v-if="drawerTab === 'plan'" class="shared-drawer-pane plan-detail-pane" role="tabpanel" aria-label="Plan 详情">
            <PlanDetailContent
              :plan="detailPlan"
              :error="detailLoadError"
              :revisions="detailRevisions"
              :read-only="Boolean(detailPlan && detailLatestRevision !== null && detailPlan.revision !== detailLatestRevision)"
              :revision-draft-status="revisionDraft?.status ?? null"
              :dependency-options="detailDependencyOptions"
              :can-edit-dependencies="canEditDependencies"
              :dependencies-saving="dependenciesSaving"
              :verification-suite-options="detailVerificationSuiteOptions"
              :can-edit-verification-suites="canEditVerificationSuites"
              :verification-suites-saving="verificationSuitesSaving"
              @close="closeSharedDrawer"
              @confirm="confirmPlan(detailPlan)"
              @discard="discardPlan(detailPlan)"
              @keep-editing="keepEditingPlan"
              @select-revision="selectPlanRevision"
              @update-dependencies="saveDependencies(detailPlan, $event)"
              @update-verification-suites="saveVerificationSuites(detailPlan, $event)"
            />
          </section>
          <section v-if="drawerTab === 'task'" class="shared-drawer-pane task-detail-pane" role="tabpanel" aria-label="Run">
            <RunDetailView
              v-if="activeRunId"
              :key="activeRunId"
              embedded
              :project-id="projectId"
              :run-id="activeRunId"
              @close="closeRunView"
              @open-plan="openPlanDetail"
              @open-explorer="switchDrawerTab('explorer')"
            />
            <template v-else-if="taskPanelPlan">
              <header class="task-detail-heading">
                <div class="eyebrow">执行 · 第 {{ taskPanelPlan.revision }} 版</div>
                <h3>{{ taskPanelPlan.title }}</h3>
                <p>任务状态：{{ selectedRequirementRow?.taskStatus.label ?? "—" }}</p>
              </header>
              <div
                v-if="taskPanelPlan.status === 'READY' && isConversationArtifactPlan(taskPanelPlan)"
                class="task-action-panel task-action-attention"
              >
                <strong>此 Plan 是对话产物，不能入队执行。</strong>
                <p>请在探索对话中改为“仓库文件”产物，指定目标路径后确认新版本。</p>
                <el-button type="primary" plain @click="returnToCurrentRequirementChat">返回探索对话修订</el-button>
              </div>
              <div v-else-if="taskPanelPlan.status === 'READY'" class="task-action-panel">
                <strong>Plan 已确认，可以入队。</strong>
                <p>入队和开始运行是两个独立步骤。</p>
                <el-button type="primary" :loading="busy" @click="enqueuePlan(taskPanelPlan)"><ArrowDown :size="15" /> 入队</el-button>
              </div>
              <div v-else-if="taskPanelPlan.status === 'ENQUEUED'" class="task-action-panel">
                <strong>Plan 已入队，等待明确开始运行。</strong>
                <p>开始运行后会进入该需求的 Run 对话。</p>
                <el-button type="primary" :loading="busy" @click="startPlanRun(taskPanelPlan)"><Right :size="15" /> 开始运行</el-button>
              </div>
              <div v-else-if="taskPanelPlan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" class="task-action-panel task-action-attention">
                <strong>等待处理项目执行配置</strong>
                <p>{{ taskPanelPlan.dispatch.lastError ?? "此 Plan 需要项目验证命令配置。" }}</p>
                <el-button plain @click="openProjectSettingsDialog(taskPanelPlan.projectId)">配置项目命令</el-button
                ><el-button
                  v-if="canCreateConfigurationRevision(taskPanelPlan)"
                  type="primary"
                  :loading="busy"
                  @click="revisePlanConfiguration(taskPanelPlan)"
                  >创建更新版本</el-button
                >
              </div>
              <div v-else class="task-action-panel">
                <strong>{{ selectedRequirementRow?.taskStatus.label ?? "任务状态未知" }}</strong>
                <p>{{ taskPanelPlan.dispatch?.lastError ?? taskPanelPlan.attentionReason ?? "当前任务正在等待执行状态更新。" }}</p>
                <el-button plain @click="refreshThread"><Refresh :size="14" /> 刷新状态</el-button>
              </div>
              <el-button class="task-plan-link" text @click="openPlanDetail(taskPanelPlan)"
                ><Document :size="15" /> 查看结构化 Plan</el-button
              >
            </template>
            <div v-else class="shared-drawer-empty">
              <strong>当前需求还没有可执行 Plan</strong>
              <p>Plan 确认并进入任务阶段后，这里会显示入队操作和 Run 对话。</p>
            </div>
          </section>
          <section v-if="drawerTab === 'explorer'" class="conversation-column drawer-conversation-column">
            <ProjectExecutionThreadPanel v-if="projectExecutionMode" :project-id="projectId" :project="project" />
            <template v-else>
              <div v-if="!activeRunId" class="conversation-header">
                <div class="conversation-header-copy">
                  <h1 :title="explorerDisplayTitle(thread)">{{ explorerDisplayTitle(thread) }}</h1>
                  <p v-if="revisionDraft" class="revision-draft-banner" role="status">
                    Editing {{ revisionDraft.planId }} · V{{ revisionDraft.basedOnRevision }} → V{{ revisionDraft.targetRevision }} ·
                    {{
                      revisionDraft.status === "READY_TO_CONFIRM"
                        ? "可确认"
                        : revisionDraft.status === "BASE_CHANGED"
                          ? "基线已变"
                          : "继续编辑"
                    }}
                  </p>
                </div>
                <div class="conversation-header-aside">
                  <ExplorerHeaderStatus
                    :requirements="planRequirements"
                    :completed="explorationProgress.completed"
                    :diagnostics="explorationProgress.diagnostics"
                    :progress="explorationProgress"
                    :agent-loop="agentLoop"
                    :agent-loop-label="agentLoopLabel"
                    :agent-loop-gate-label="agentLoopGateLabel"
                    :agent-loop-terminal-label="agentLoopTerminalLabel"
                    :agent-loop-completion-label="agentLoopCompletionLabel"
                    :thread-id="thread?.id ?? ''"
                    :paused="explorerPaused"
                    :runtime-facts="runtimeFacts"
                    @toggle-pause="toggleExplorerPause"
                  />
                </div>
              </div>
              <div v-if="!activeRunId && explorerPaused" class="demo-notice pause-notice">
                <VideoPause :size="14" /> 探索线程已暂停；恢复之前不能发起新的回合。<el-button text @click="toggleExplorerPause"
                  >恢复</el-button
                >
              </div>
              <div v-if="!activeRunId && error" class="demo-notice">
                <Refresh :size="14" /> {{ error }} <el-button text @click="load">重试</el-button>
              </div>
              <div v-if="!activeRunId" class="timeline-stage">
                <div class="timeline-shell">
                  <div ref="timeline" v-loading="loading" class="timeline" @scroll="updateTimelineScrollState">
                    <div
                      :id="activeExplorerPlan ? explorerPlanAnchorId(activeExplorerPlan.id) : undefined"
                      :data-nav-key="activeExplorerPlan ? `explorer-plan-${activeExplorerPlan.id}` : undefined"
                      class="explorer-plan-anchor"
                      aria-hidden="true"
                    />
                    <div class="timeline-day">{{ visibleTurns.length ? "探索活动" : "新建探索" }}</div>
                    <div v-if="!visibleActivity.length && !visibleInputRequests.length && !candidate" class="timeline-empty">
                      <Connection :size="24" /><strong>{{
                        activeExplorerPlan ? taskDisplayTitle(activeExplorerPlan) : "开始一次全新的需求探索"
                      }}</strong
                      ><span>当前需求还没有消息；切换需求不会删除其他对话内容。</span>
                    </div>
                    <ExplorerMessageRow
                      v-for="(item, index) in renderedTimelineItems"
                      :key="item.key"
                      :item="item"
                      :index="index"
                      :plan="planForTimelineItem(item)"
                      :is-candidate-plan="isCandidatePlan(planForTimelineItem(item))"
                      :busy="busy"
                      :pending-input-id="pendingInput?.id ?? null"
                      :input-progress="inputProgress"
                      :input-answer-in-flight="inputAnswerInFlight"
                      @answer="openInputRequest"
                      @view-plan="openPlanDetail"
                      @confirm-plan="confirmPlan"
                      @enqueue-plan="enqueuePlan"
                    />
                  </div>
                  <button
                    v-if="showScrollToLatest"
                    class="scroll-to-latest"
                    type="button"
                    aria-label="跳到最新消息"
                    title="跳到最新消息"
                    @click="jumpToLatest"
                  >
                    <img class="scroll-to-latest-image" :src="scrollToLatestIcon" alt="" />
                  </button>
                </div>
              </div>
              <div v-if="!activeRunId" class="composer">
                <div class="composer-input">
                  <textarea
                    v-model="draft"
                    :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused"
                    aria-label="探索消息"
                    placeholder="继续探索，或提出修改…"
                    @keydown="handleComposerKeydown"
                  /><span class="composer-mode">Plan 模式</span>
                </div>
                <div class="composer-footer">
                  <ProviderUsageFooter
                    :model="explorerModel"
                    :backend="explorerBackendLabel"
                    :context="contextUsage"
                    context-note="estimated"
                  /><span
                    v-if="inputAnswerInFlight || inputCardRequest?.status === 'SUBMITTING'"
                    class="composer-status"
                    role="status"
                    aria-live="polite"
                    >正在提交结构化答案，确认后本轮会继续…</span
                  ><span v-else-if="pendingInput" class="composer-status" role="status" aria-live="polite"
                    >请先回答上方结构化问题，再继续探索。</span
                  ><span v-else-if="sendingCurrentPlan" class="composer-status" role="status" aria-live="polite"
                    >消息已发送 · 等待 Plan Explorer…</span
                  ><el-button
                    class="composer-send"
                    type="primary"
                    circle
                    :loading="(activePlanBusy && !activePlanWaitingForInput) || sendingCurrentPlan"
                    :disabled="
                      !thread ||
                      thread?.state === 'ARCHIVED' ||
                      project?.status === 'ARCHIVED' ||
                      !draft.trim() ||
                      explorerPaused ||
                      activePlanBusy ||
                      sendingCurrentPlan ||
                      busy
                    "
                    aria-label="发送消息"
                    :title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : '发送消息'"
                    @click="sendTurn"
                    ><ArrowUp :size="18"
                  /></el-button>
                </div>
              </div>
            </template>
          </section>
        </div>
      </div>
    </el-drawer>
    <ExplorerInputDialog
      ref="inputDialog"
      v-model="inputDialogOpen"
      :request="pendingInput"
      :progress="inputProgress"
      @submit="submitInput"
      @cancel="cancelInput"
      @progress="updateInputProgress"
    />
    <ProjectCreateDialog v-model="projectCreateOpen" @project-created="handleProjectCreated" />
    <ProjectSettingsDialog
      :model-value="projectSettingsOpen"
      :project-id="projectSettingsProjectId"
      :initial-tab="projectSettingsInitialTab"
      @update:model-value="closeProjectSettings"
      @saved="handleProjectSettingsSaved"
    />
    <ExplorerRenameDialog
      v-model="renameDialogOpen"
      :initial-value="thread?.title ?? ''"
      :copy="RENAME_COPY.thread"
      :saving="renameSaving"
      :error="renameError"
      @submit="renameThread"
    />
    <ExplorerRenameDialog
      v-model="renameRequirementOpen"
      :initial-value="renameRequirementTarget?.title ?? ''"
      :copy="RENAME_COPY.requirement"
      :saving="renameRequirementSaving"
      :error="renameRequirementError"
      @submit="submitRenameRequirement"
    />
    <ExplorerRequirementDialog
      v-model="requirementDialogOpen"
      :thread-title="thread?.title ?? ''"
      :saving="requirementSubmitting"
      :error="requirementError"
      @submit="createRequirement"
    />
    <ConfirmDialog
      v-model="deleteRequirementOpen"
      eyebrow="需求操作"
      heading="永久删除需求"
      :message="`「${deleteRequirementTarget?.title ?? ''}」会被永久删除。`"
      :details="['它的结构化 Plan、执行记录与执行日志一起删除，无法恢复', '已结束运行的本地 worktree 不会自动清理']"
      confirm-label="永久删除"
      cancel-label="取消"
      tone="danger"
      :busy="deleteRequirementSaving"
      :error="deleteRequirementError"
      @confirm="confirmDeleteExplorerPlan"
    />
    <ExplorerPolicyDrawer :model-value="policyOpen" @update:model-value="setPolicyOpen" />
  </div>
</template>
