<!--
  模块职责：承载 Explorer 对话、消息流、计划定位、输入请求和 SSE 生命周期。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, CircleCheck, Close, Connection, Document, InfoFilled, Plus, Promotion, Refresh, Right, VideoPause, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { AgentLoop, ExplorerActivityItem, ExplorerInputRequest, ExplorerPlan, ExplorerThread, ExplorerTurn, Plan, PlanRevisionDraft, Project, Run } from "../types";
import PlanDetailContent from "../components/PlanDetailContent.vue";
import ExplorerPolicyDrawer from "../components/ExplorerPolicyDrawer.vue";
import ThreadRail from "../components/ThreadRail.vue";
import ExplorerRequirementList from "../components/ExplorerRequirementList.vue";
import { isConversationArtifactPlan, projectExplorerRequirementRows } from "../utils/explorerRequirementRows";
import { isTimelineAtLatest as isTimelineAtLatestPosition, scrollTimelineToLatest } from "../utils/scrollTimeline";
import { optional } from "../utils/optional";
import { closePolicyPanel, openPolicyPanel } from "../utils/policyPanel";
import { createOptimisticUserTurn, settleOptimisticTurn } from "../utils/optimisticTurn";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import { isExplorerTurnProcessing } from "../utils/turnStatus";
import { formatContextUsage } from "../utils/explorerStatus";
import { createSseReplayGate } from "../utils/sseReplayGate";
import ExplorerInputDialog from "../components/ExplorerInputDialog.vue";
import MarkdownMessage from "../components/MarkdownMessage.vue";
import ProjectExecutionThreadPanel from "../components/ProjectExecutionThreadPanel.vue";
import ProjectSettingsDialog from "../components/ProjectSettingsDialog.vue";
import ProjectCreateDialog from "../components/ProjectCreateDialog.vue";
import ExplorerRenameDialog from "../components/ExplorerRenameDialog.vue";
import ExplorerHeaderStatus from "../components/ExplorerHeaderStatus.vue";
import ProviderUsageFooter from "../components/ProviderUsageFooter.vue";
import RunDetailView from "./RunDetailView.vue";
import scrollToLatestIcon from "../assets/scroll-to-latest.png";
import { normalizePlanProjection, planFromRevisionDraft as revisionDraftToPlan } from "../utils/planProjection";
import { isCandidatePlan as isCandidatePlanFor } from "../utils/planControls";
import { parsePlanProtocolDisplay } from "../utils/planProtocolDisplay";
import { detachedPlanAnchorId, planActivityBindings as buildPlanActivityBindings, planAnchorId, planAnchorKey, planIdentity } from "../utils/planTimeline";
import { taskDisplayTitle } from "../utils/taskTree";
import { isConfirmedPlanRevision, resolvePlanVersionHistory } from "../utils/planVersionHistory";
import { inputAnswerDisplayLabels, inputAnswerDisplayText } from "../utils/explorerInput";
import { createProjectRequestScope, projectPathForModule } from "../utils/projectRoutes";
import { buildExplorerTimeline, explorerTimelineTarget as activityTarget, explorerPlanAnchorId, inputRequestTarget } from "../utils/explorerTimeline";
import { activityIconKind, activityKindLabel, activityStatusLabel, explorerDisplayTitle, formatTurnTime, inputStatusLabel as inputStatusText } from "../utils/explorerPresentation";
import { planStatusLabel as statusLabel } from "../utils/planStatus";
import { belongsToExplorerPlan } from "../utils/explorerScope";
import { formatAgentLoopCompletion, formatAgentLoopGate, formatAgentLoopTerminal } from "../utils/agentLoopPresentation";
import { summarizeUserMessage as userMessageSummary } from "../utils/messageSummary";
import { canCreateConfigurationRevision as canCreateConfigurationRevisionFor } from "../utils/runPrerequisites";
import { clearExplorerInputProgressDraft, loadExplorerInputProgressDraft, saveExplorerInputProgressDraft } from "../utils/explorerInputProgressDraft";
import type { ExplorerInputProgress, ExplorerInputProgressScope } from "../utils/explorerInputProgressDraft";

const route = useRoute();
const router = useRouter();
// 页面状态按 Project 当前 Explorer、候选 Plan、已派发 Plan 和消息流分层保存，
// 避免切换 Project/Thread 时把旧项目的响应式数据留在当前视图。
const projectId = computed(() => String(route.params.projectId ?? ""));
const projectExecutionMode = computed(() => route.query.workspace === "project-execution");
const project = ref<Project | null>(null);
const projects = ref<Project[]>([]);
const thread = ref<ExplorerThread | null>(null);
const explorers = ref<ExplorerThread[]>([]);
const explorerPlans = ref<ExplorerPlan[]>([]);
const threadPlans = ref<Plan[]>([]);
const activeExplorerPlanId = ref<string | null>(null);
const projectCreateOpen = ref(false);
const projectSettingsOpen = ref(false);
const projectSettingsProjectId = ref<string | null>(null);
const activity = ref<ExplorerActivityItem[]>([]);
const candidate = ref<Plan | null>(null);
const revisionDraft = ref<PlanRevisionDraft | null>(null);
const confirmedPlans = ref<Plan[]>([]);
const enqueued = ref<Plan[]>([]);
const dispatched = ref<Plan[]>([]);
const projectRuns = ref<Run[]>([]);
type ExplorerPlanRequirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };
// Requirements must remain visible while an older API instance is restarting; the
// API manifest replaces this fallback as soon as it is available.
const defaultPlanRequirements: ExplorerPlanRequirement[] = [
  { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal", "objective.audience"], optionalFields: [] },
  { key: "scope", label: "功能范围与排除项", requiredFields: ["objective.outOfScope", "scope.includePaths", "scope.excludePaths"], optionalFields: [] },
  { key: "design", label: "技术方案与关键约束", requiredFields: ["design.technicalConstraints"], optionalFields: [] },
  { key: "safety", label: "数据、安全与异常处理", requiredFields: ["design.dataSecurity", "design.failureHandling"], optionalFields: [] },
  { key: "verification", label: "验收标准与验证命令", requiredFields: ["objective.acceptanceCriteria", "verification.mode"], optionalFields: [] },
  { key: "delivery", label: "实施任务、依赖与冲突", requiredFields: ["tasks", "dependencies", "conflicts"], optionalFields: [] },
  { key: "execution", label: "执行与人工合并", requiredFields: ["artifact.mode", "merge.strategy", "merge.requireHumanMerge"], optionalFields: ["execution.executorModelRole", "execution.toolPolicy", "execution.maxRepairAttempts"] },
];
const planRequirements = ref<ExplorerPlanRequirement[]>([]);
const turns = ref<ExplorerTurn[]>([]);
const draft = ref("");
const requirementDrafts = new Map<string, string>();
const pendingSendPlanIds = ref<Set<string>>(new Set());
type FailedExplorerSend = { content: string; clientTurnId: string; optimisticUserId: string; assistantActivityId: string; failedAssistantTurnId: string | null };
const failedExplorerSends = new Map<string, FailedExplorerSend>();
const drawerOpen = ref(false);
type SharedDrawerTab = "explorer" | "plan" | "task";
const drawerTab = ref<SharedDrawerTab>("explorer");
const detailPlan = ref<Plan | null>(null);
const detailRevisions = ref<number[]>([]);
const detailConfirmedRevisions = ref<number[]>([]);
const detailLatestRevision = ref<number | null>(null);
const detailVersionSource = ref<"candidate" | "confirmed" | null>(null);
const detailLoadError = ref<string | null>(null);
const policyOpen = ref(false);
const renameDialogOpen = ref(false);
const renameSaving = ref(false);
const renameError = ref<string | null>(null);
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
const showScrollToLatest = ref(false);
const timeline = ref<HTMLElement | null>(null);
const pendingInput = ref<ExplorerInputRequest | null>(null);
const recoveryInput = ref<ExplorerInputRequest | null>(null);
const inputRequests = ref<ExplorerInputRequest[]>([]);
const inputProgress = ref<ExplorerInputProgress | null>(null);
const agentLoop = ref<AgentLoop | null>(null);
const explorerModel = ref("gpt-5.6-luna");
const inputDialogOpen = ref(false);
const inputDialog = ref<{ onSubmitted: () => void; onFailed: (message: string) => void } | null>(null);
const inputAnswerInFlight = ref<string | null>(null);
const mounted = ref(false);
const requestScope = createProjectRequestScope();
let eventSource: EventSource | null = null;
let loopEventSource: EventSource | null = null;
let requirementStatusEventSource: EventSource | null = null;
let requirementStatusScope: { projectId: string; threadId: string } | null = null;
let explorerEventSequence: number | null = null;
let planProjectionVersion = 0;
// 流式增量期间把 activity/plan 投影的重新拉取合并到固定间隔；文本本身仍按事件即时合并到 turn，
// 因此观感不受影响，但不会每个增量都触发 6 次请求。
const PROJECTION_REFRESH_INTERVAL_MS = 400;
/** Loop 的终态与门禁事件必须立即反映；其余步骤级事件可以合并到刷新间隔。 */
const AGENT_LOOP_IMMEDIATE_REFRESH_EVENTS = new Set(["agent.step.gate_checked", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required", "agent.loop.paused", "agent.loop.resumed", "agent.input.required", "agent.input.resolved"]);
let projectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let loopRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let detailRequestVersion = 0;
let activeRequestToken = 0;
// A delete already loads the replacement thread explicitly. Suppress the
// route watcher for that one navigation so the old thread cannot race the
// replacement load and overwrite the page-level error banner.
let suppressNextExplorerRouteReload = false;
const candidateCount = computed(() => candidate.value ? 1 : 0);
const confirmedCount = computed(() => confirmedPlans.value.length);
const enqueuedCount = computed(() => enqueued.value.length);
const dispatchedCount = computed(() => dispatched.value.length);
const activeRuns = computed(() => projectRuns.value.filter((run) => ["STARTING", "IN_PROGRESS", "VERIFYING"].includes(run.status)));
const activeRunCount = computed(() => activeRuns.value.length);
const activeRunId = computed(() => typeof route.query.runId === "string" ? route.query.runId : null);
const needsAttentionCount = computed(() => dispatched.value.filter((plan) => plan.status === "BLOCKED" || plan.status === "NEEDS_PLAN_CHANGE" || Boolean(plan.attentionReason)).length);
const attentionPlans = computed(() => dispatched.value.filter((plan) => plan.status === "BLOCKED" || plan.status === "NEEDS_PLAN_CHANGE" || Boolean(plan.attentionReason)));
const planCenterCount = ref(0);
const contextPanelTitle = computed(() => ({ candidate: "当前候选 Plan", plans: "当前线程 Plans", confirmed: "已确认方案", enqueued: "已入队方案", dispatched: "已派发方案", active: "运行中任务", attention: "待处理事项", "plan-center": "项目 Plan 与任务中心" } as const)[contextPanel.value]);
const contextPanelCount = computed(() => contextPanel.value === "candidate" ? candidateCount.value : contextPanel.value === "plans" ? threadPlans.value.length : contextPanel.value === "confirmed" ? confirmedCount.value : contextPanel.value === "enqueued" ? enqueuedCount.value : contextPanel.value === "dispatched" ? dispatchedCount.value : contextPanel.value === "active" ? activeRunCount.value : contextPanel.value === "attention" ? needsAttentionCount.value : planCenterCount.value);
const contextMenuItems = computed(() => [
  { key: "candidate" as ContextPanel, label: "候选方案", railLabel: "候选", entryClass: "context-entry-candidate", count: candidateCount.value, icon: Promotion },
  { key: "plans" as ContextPanel, label: "当前线程 Plans", railLabel: "Plans", entryClass: "context-entry-plans", count: threadPlans.value.length, icon: Document },
  { key: "confirmed" as ContextPanel, label: "已确认方案", railLabel: "已确认", entryClass: "context-entry-confirmed", count: confirmedCount.value, icon: Check },
  { key: "enqueued" as ContextPanel, label: "已入队方案", railLabel: "已入队", entryClass: "context-entry-enqueued", count: enqueuedCount.value, icon: ArrowDown },
  { key: "dispatched" as ContextPanel, label: "已派发方案", railLabel: "已派发", entryClass: "context-entry-dispatched", count: dispatchedCount.value, icon: CircleCheck },
  { key: "active" as ContextPanel, label: "运行中任务", railLabel: "运行中", entryClass: "context-entry-active", count: activeRunCount.value, icon: Connection },
  { key: "attention" as ContextPanel, label: "待处理事项", railLabel: "待处理", entryClass: "context-entry-attention", count: needsAttentionCount.value, icon: Warning },
]);
const inputCardRequest = computed(() => pendingInput.value ?? inputRequests.value.find((item) => belongsToActivePlan(item.explorerPlanId) && item.status === "SUBMITTING") ?? recoveryInput.value);
const contextUsage = computed(() => formatContextUsage(turns.value));
const agentLoopLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[agentLoop.value?.state ?? ""] ?? "No active loop");
const agentLoopGateLabel = computed(() => formatAgentLoopGate(agentLoop.value?.diagnostics));
const agentLoopTerminalLabel = computed(() => formatAgentLoopTerminal(agentLoop.value?.diagnostics));
const agentLoopCompletionLabel = computed(() => agentLoop.value ? formatAgentLoopCompletion(agentLoop.value) : null);
const activeExplorerPlan = computed(() => {
  const requested = activeExplorerPlanId.value ?? thread.value?.activeExplorerPlanId ?? explorerPlans.value[0]?.id;
  return explorerPlans.value.find((plan) => plan.id === requested) ?? explorerPlans.value[0] ?? null;
});
const requirementRows = computed(() => projectExplorerRequirementRows(
  explorerPlans.value,
  [...threadPlans.value, ...(candidate.value ? [candidate.value] : [])],
  projectRuns.value,
));
const selectedRequirementRow = computed(() => requirementRows.value.find((row) => row.explorerPlan.id === activeExplorerPlan.value?.id) ?? null);
const sharedDrawerTitle = computed(() => selectedRequirementRow.value?.title ?? (activeExplorerPlan.value ? taskDisplayTitle(activeExplorerPlan.value) : "需求详情"));
const taskPanelPlan = computed(() => selectedRequirementRow.value?.plan ?? null);
const explorationProgress = computed(() => activeExplorerPlan.value?.exploration ?? thread.value?.exploration ?? { status: "INCOMPLETE" as const, missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null });
const activeTimelineKey = ref("");
const activePlanKey = ref("");
const expandedUserMessageIds = ref<Set<string>>(new Set());
function belongsToActivePlan(planId: string | null | undefined): boolean {
  return belongsToExplorerPlan(planId, activeExplorerPlan.value?.id ?? null);
}
const visibleTurns = computed(() => turns.value.filter((turn) => belongsToActivePlan(turn.explorerPlanId)));
const visibleActivity = computed(() => (activity.value.length ? activity.value : visibleTurns.value.map((turn) => ({ id: `fallback-${turn.id}`, explorerId: turn.threadId, turnId: turn.id, sequence: turn.sequence, kind: turn.role === "user" ? "USER_MESSAGE" : "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : turn.status === "RUNNING" ? "RUNNING" : turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED" ? "WAITING" : "COMPLETED", title: turn.role === "user" ? "You" : "Plan Explorer", summary: turn.role === "assistant" ? readableAssistantText(turnContent(turn)) : turnContent(turn), details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt, explorerPlanId: turn.explorerPlanId })) as ExplorerActivityItem[]).filter((item) => belongsToActivePlan(item.explorerPlanId)));
const visibleInputRequests = computed(() => inputRequests.value.filter((item) => belongsToActivePlan(item.explorerPlanId)));
const activePlanBusy = computed(() => visibleTurns.value.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED" || turn.status === "QUEUED"));
const activePlanWaitingForInput = computed(() => visibleTurns.value.some((turn) => turn.status === "WAITING_FOR_INPUT"));
const sendingCurrentPlan = computed(() => Boolean(activeExplorerPlan.value && pendingSendPlanIds.value.has(activeExplorerPlan.value.id)));
const allPlans = computed<Plan[]>(() => {
  const unique = new Map<string, Plan>();
  for (const plan of [candidate.value, ...confirmedPlans.value, ...enqueued.value, ...dispatched.value]) if (plan) unique.set(planIdentity(plan), plan);
  return [...unique.values()];
});
const activeTaskPlans = computed<Plan[]>(() => allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId)));
const activePlans = computed<Plan[]>(() => activeRuns.value.map((run) => {
  const existing = allPlans.value.find((plan) => planIdentity(plan) === run.planId || plan.planId === run.planId || plan.id === run.planId);
  const status: Plan["status"] = run.status === "VERIFYING" ? "VERIFYING" : "IN_PROGRESS";
  if (existing) {
    return { ...existing, status, runId: run.id, executionThread: { id: run.executionThreadId, runId: run.id, state: run.status } };
  }
  return {
    id: run.planId,
    planId: run.planId,
    title: `Plan ${run.planId}`,
    revision: run.planRevision,
    status,
    projectId: run.projectId,
    sourceExplorerThreadId: "",
    queuedAt: null,
    dispatchedAt: null,
    runId: run.id,
    lastEventAt: run.startedAt ?? run.createdAt,
    attentionReason: null,
    createdAt: run.createdAt,
    executionThread: { id: run.executionThreadId, runId: run.id, state: run.status },
  };
}));
const planBindings = computed(() => buildPlanActivityBindings(activeTaskPlans.value, visibleActivity.value));
const detachedPlans = computed(() => activeTaskPlans.value.filter((plan) => ![...planBindings.value.values()].some((bound) => planIdentity(bound) === planIdentity(plan))));
const timelineItems = computed(() => buildExplorerTimeline(visibleActivity.value, visibleInputRequests.value, detachedPlans.value));

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
    requestScope.invalidate();
    resetThreadState();
    project.value = response.project;
    explorers.value = [response.replacementExplorer, ...explorers.value.filter((item) => item.id !== response.deletedExplorerId && item.id !== response.replacementExplorer.id)];
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
    explorers.value = explorers.value.map((item) => item.id === requestThreadId ? response.explorer : item);
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
      const response = agentLoop.value.state === "PAUSED" ? await api.resumeAgentLoop(agentLoop.value.id) : await api.pauseAgentLoop(agentLoop.value.id, "user_requested");
      agentLoop.value = response.loop;
      explorerPaused.value = response.loop.state === "PAUSED";
      ElMessage.info(explorerPaused.value ? "Explorer Loop 已暂停" : "Explorer Loop 已恢复");
    } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "Explorer Loop 控制失败"); }
    return;
  }
  explorerPaused.value = !explorerPaused.value;
  ElMessage.info(explorerPaused.value ? "ExplorerThread 已暂停" : "ExplorerThread 已恢复");
}

async function refreshThread() {
  await load();
  if (!error.value) ElMessage.success("ExplorerThread 已刷新");
}

function turnContent(turn: ExplorerTurn): string {
  if (turn.content.trim()) return turn.content;
  if (turn.status === "RUNNING") return "Plan Explorer 正在处理…";
  if (turn.status === "WAITING_FOR_INPUT") return "Plan Explorer 正在等待你的选择…";
  return turn.status === "FAILED" ? `模型调用失败：${turn.error ?? "未知错误"}` : "模型未返回内容";
}

function readableAssistantText(content: string): string {
  const display = parsePlanProtocolDisplay(content);
  if (display.kind === "ready") return [display.prose, `完整执行方案已生成：${display.title}`].filter(Boolean).join(" ");
  return display.kind === "plain" ? display.text : display.text;
}

function isUserMessageExpanded(activityId: string): boolean {
  return expandedUserMessageIds.value.has(activityId);
}

function toggleUserMessage(activityId: string): void {
  const next = new Set(expandedUserMessageIds.value);
  if (next.has(activityId)) next.delete(activityId);
  else next.add(activityId);
  expandedUserMessageIds.value = next;
}

function planActivityDetails(item: ExplorerActivityItem): Record<string, unknown> | null {
  return item.kind === "ASSISTANT_MESSAGE" && item.details?.planProtocol === true && item.details.status === "READY" ? item.details : null;
}

function planForActivity(item: ExplorerActivityItem): Plan | null {
  return planBindings.value.get(item.id) ?? null;
}

function isCandidatePlan(plan: Plan | null): boolean {
  return isCandidatePlanFor(plan, candidate.value);
}

function planActivityGoal(item: ExplorerActivityItem): string {
  const details = planActivityDetails(item);
  return typeof details?.goal === "string" ? details.goal : "结构化执行方案已完成校验。";
}

function planActivityCount(item: ExplorerActivityItem, key: string): number {
  const value = planActivityDetails(item)?.[key];
  return typeof value === "number" ? value : 0;
}

function inputProgressScope(): ExplorerInputProgressScope | null {
  const currentThread = thread.value;
  const explorerPlanId = activeExplorerPlan.value?.id;
  if (!currentThread || !explorerPlanId) return null;
  return { projectId: projectId.value, threadId: currentThread.id, explorerPlanId };
}

function setInputRequests(items: ExplorerInputRequest[]) {
  const activeRequests = items.filter((item) => belongsToActivePlan(item.explorerPlanId));
  const nextPending = activeRequests.find((item) => item.status === "OPEN") ?? null;
  const nextRecovery = activeRequests.find((item) => item.status === "RECOVERY_REQUIRED") ?? null;
  const draftRequest = nextPending ?? activeRequests.find((item) => item.status === "SUBMITTING") ?? nextRecovery;
  const existingProgress = draftRequest && inputProgress.value?.requestId === draftRequest.id ? inputProgress.value : null;
  const scope = inputProgressScope();
  inputRequests.value = items;
  pendingInput.value = nextPending;
  recoveryInput.value = nextRecovery;
  inputProgress.value = draftRequest && scope ? existingProgress ?? loadExplorerInputProgressDraft(scope, draftRequest) : null;
  if (scope) {
    for (const request of activeRequests) {
      if (request.status === "ANSWERED" || request.status === "AUTO_RESOLVED" || request.status === "CANCELLED") {
        clearExplorerInputProgressDraft(scope, request.id);
      }
    }
  }
}

function isCurrentProjectScope(requestProjectId: string, requestToken = activeRequestToken): boolean {
  return requestScope.isCurrent(requestToken, requestProjectId) && projectId.value === requestProjectId;
}

function resetThreadState() {
  closeRequirementStatusEvents();
  detailRequestVersion += 1;
  thread.value = null;
  drawerOpen.value = false;
  drawerTab.value = "explorer";
  detailPlan.value = null;
  detailRevisions.value = [];
  detailConfirmedRevisions.value = [];
  detailLatestRevision.value = null;
  detailVersionSource.value = null;
  detailLoadError.value = null;
  explorerPlans.value = [];
  requirementDrafts.clear();
  draft.value = "";
  threadPlans.value = [];
  activeExplorerPlanId.value = null;
  candidate.value = null;
  revisionDraft.value = null;
  confirmedPlans.value = [];
  enqueued.value = [];
  dispatched.value = [];
  planCenterCount.value = 0;
  turns.value = [];
  activity.value = [];
  inputRequests.value = [];
  pendingInput.value = null;
  recoveryInput.value = null;
  inputProgress.value = null;
  agentLoop.value = null;
  explorerEventSequence = null;
  planProjectionVersion += 1;
  drawerOpen.value = false;
  detailPlan.value = null;
  detailRevisions.value = [];
  detailConfirmedRevisions.value = [];
  detailLatestRevision.value = null;
  detailVersionSource.value = null;
  policyOpen.value = false;
  renameDialogOpen.value = false;
  renameError.value = null;
  renameSaving.value = false;
  inputDialogOpen.value = false;
  inputAnswerInFlight.value = null;
  explorerPaused.value = false;
  activeTimelineKey.value = "";
  activePlanKey.value = "";
  expandedUserMessageIds.value = new Set();
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

/** 下面三个 wrapper 只负责把本地状态（草稿进度、在途标记）喂给 utils 里的纯函数。 */
function inputAnswerLabelsFor(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string[] {
  return inputAnswerDisplayLabels(request, question, inputProgress.value);
}

function inputAnswerText(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string {
  return inputAnswerDisplayText(request, question, inputProgress.value, inputAnswerInFlight.value);
}

function inputStatusLabel(request: ExplorerInputRequest): string {
  return inputStatusText(request, inputAnswerInFlight.value);
}

async function refreshPlanProjection(): Promise<void> {
  const explorerId = thread.value?.id;
  if (!explorerId) return;
  const requestProjectId = projectId.value;
  const requestToken = activeRequestToken;
  const requestVersion = ++planProjectionVersion;
  try {
    const [explorerResponse, planGroupsResponse, plansResponse, confirmedResponse, threadPlansResponse] = await Promise.all([
      api.explorer(requestProjectId, explorerId),
      api.explorerPlanGroups(requestProjectId, explorerId),
      api.explorerPlans(requestProjectId, explorerId),
      optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId)),
      api.explorerThreadPlans(requestProjectId, explorerId),
    ]);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== explorerId) return;
    explorerPlans.value = planGroupsResponse.items;
    threadPlans.value = threadPlansResponse.items;
    const routePlanId = typeof route.query.explorerPlanId === "string" ? route.query.explorerPlanId : null;
    activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === activeExplorerPlanId.value) ? activeExplorerPlanId.value : explorerPlans.value.some((plan) => plan.id === routePlanId) ? routePlanId : explorerPlans.value.some((plan) => plan.id === explorerResponse.explorer.activeExplorerPlanId) ? explorerResponse.explorer.activeExplorerPlanId ?? null : explorerPlans.value[0]?.id ?? null;
    const projection = normalizePlanProjection(explorerResponse.explorer, null, plansResponse.items);
    applyPlanProjection(projection, confirmedResponse?.items ?? [], null);
    await loadActivePlanWorkspace(explorerId, activeExplorerPlanId.value, requestProjectId, requestToken);
  } catch {
    // 事件流追赶期间保留上一次投影，避免切换或重连时页面短暂清空。
  }
}

async function loadActivePlanWorkspace(explorerId: string, explorerPlanId: string | null, requestProjectId: string, requestToken: number): Promise<boolean> {
  if (!explorerPlanId) return true;
  const workspace = await api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId);
  if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== explorerId) return false;
  turns.value = workspace.turns;
  activity.value = workspace.activity;
  setInputRequests(workspace.inputRequests);
  candidate.value = workspace.candidate;
  revisionDraft.value = workspace.revisionDraft;
  agentLoop.value = [...workspace.loops].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null;
  explorerPaused.value = agentLoop.value?.state === "PAUSED";
  explorerEventSequence = Math.max(explorerEventSequence ?? 0, workspace.lastEventSequence ?? 0);
  inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
  return true;
}

function planFromRevisionDraft(item: PlanRevisionDraft): Plan {
  return revisionDraftToPlan(item, activeExplorerPlanId.value);
}

function applyPlanProjection(projection: ReturnType<typeof normalizePlanProjection>, confirmed: Plan[], activeRevisionDraft: PlanRevisionDraft | null = null): void {
  thread.value = projection.thread;
  revisionDraft.value = activeRevisionDraft;
  candidate.value = activeRevisionDraft ? planFromRevisionDraft(activeRevisionDraft) : projection.candidate;
  confirmedPlans.value = confirmed.filter((plan) => plan.status === "READY");
  enqueued.value = projection.dispatched.filter((plan) => plan.status === "ENQUEUED");
  dispatched.value = projection.dispatched.filter((plan) => plan.dispatchedAt !== null && plan.dispatchedAt !== undefined);
}

function jumpToTimelineTarget(targetId: string, key: string) {
  const target = document.getElementById(targetId);
  if (!timeline.value || !target) return;
  const timelineRect = timeline.value.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = timeline.value.scrollTop + targetRect.top - timelineRect.top - 20;
  timeline.value.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  activeTimelineKey.value = target.dataset.navKey?.startsWith("message-") ? target.dataset.navKey : key;
  activePlanKey.value = key.startsWith("plan-") ? key : "";
}

function updateActiveTimeline() {
  if (!timeline.value) return;
  const nodes = [...timeline.value.querySelectorAll<HTMLElement>("[data-nav-key]")];
  const marker = timeline.value.scrollTop + 72;
  const timelineRect = timeline.value.getBoundingClientRect();
  let current = nodes[0]?.dataset.navKey ?? activeTimelineKey.value;
  for (const node of nodes) {
    const nodeTop = timeline.value.scrollTop + node.getBoundingClientRect().top - timelineRect.top;
    if (nodeTop <= marker && node.dataset.navKey) current = node.dataset.navKey;
    if (nodeTop > marker) break;
  }
  activeTimelineKey.value = current;
  if (current.startsWith("plan-")) {
    activePlanKey.value = current;
    return;
  }
  const activeMessage = current.startsWith("message-") ? visibleActivity.value.find((item) => activityTarget(item, 0) === current) : null;
  activePlanKey.value = activeMessage ? planAnchorKey(planForActivity(activeMessage)) : "";
}

function updateTimelineScrollState() {
  showScrollToLatest.value = timeline.value ? !isTimelineAtLatestPosition(timeline.value) : false;
  updateActiveTimeline();
}

function jumpToLatest() {
  if (!timeline.value) return;
  scrollTimelineToLatest(timeline.value);
  showScrollToLatest.value = false;
}

function syncHashPanel(hash: string) {
  if (hash === "#candidate") contextPanel.value = "candidate";
  if (hash === "#confirmed") contextPanel.value = "confirmed";
  if (hash === "#attention") contextPanel.value = "attention";
  if (hash === "#candidate" && candidate.value) openPlanDetail(candidate.value);
}

async function openPlanDetail(plan: Plan): Promise<void> {
  const planId = plan.id ?? plan.planId;
  if (!planId) return;
  const requestedProjectId = projectId.value;
  const requestToken = activeRequestToken;
  const requestVersion = ++detailRequestVersion;
  const isCurrentDetailRequest = () => requestVersion === detailRequestVersion && projectId.value === requestedProjectId && activeRequestToken === requestToken;
  drawerTab.value = "plan";
  // Keep the already-loaded Explorer/Plan projection visible while the detail
  // endpoint enriches it with frozen revision and dispatch metadata.
  detailPlan.value = plan;
  detailRevisions.value = [];
  detailConfirmedRevisions.value = [];
  detailLatestRevision.value = plan.revision;
  detailVersionSource.value = plan.status === "DRAFT" ? "candidate" : "confirmed";
  detailLoadError.value = null;
  drawerOpen.value = true;
  void router.replace({ path: route.path, query: { ...route.query, ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}), requirementTab: "plan" } });
  const currentRevisionDraft = revisionDraft.value;
  if (currentRevisionDraft && planId === currentRevisionDraft.planId && currentRevisionDraft.status !== "CONFIRMED" && currentRevisionDraft.status !== "DISCARDED") {
    detailPlan.value = planFromRevisionDraft(currentRevisionDraft);
    detailLatestRevision.value = currentRevisionDraft.targetRevision;
    try {
      const history = await api.planRevisions(planId);
      if (!isCurrentDetailRequest()) return;
      detailRevisions.value = history.items.map((item) => item.revision);
      detailConfirmedRevisions.value = history.items.map((item) => item.revision);
      detailLatestRevision.value = currentRevisionDraft.targetRevision;
      detailVersionSource.value = "confirmed";
    } catch {
      // The current mutable draft remains usable even if historical metadata is temporarily unavailable.
    }
    return;
  }
  const isCandidate = plan.status === "DRAFT";
  if (!isCandidate) {
    // Merge reconciliation can take longer than the read-only Plan fetch. Keep it
    // in the background so a slow scheduler never leaves the shared drawer loading.
    void api.reconcileProjectMerges(requestedProjectId).then((report) => {
      if (projectId.value !== requestedProjectId || activeRequestToken !== requestToken) return;
      const diagnostic = plan.runId ? report.items.find((item) => item.runId === plan.runId && item.reason) : undefined;
      if (diagnostic?.reason) ElMessage.warning(`Merge 状态检测：${diagnostic.reason}`);
    }).catch((caught) => {
      if (projectId.value === requestedProjectId && activeRequestToken === requestToken) {
        ElMessage.warning(`Merge 状态检测失败，已展示最近保存的状态：${caught instanceof Error ? caught.message : "暂不可用"}`);
      }
    });
  }
  try {
    const response = await api.getPlan(planId);
    if (!isCurrentDetailRequest()) return;
    const resolvedContract = response.revision?.resolvedContract ?? response.plan.resolvedContract ?? plan.resolvedContract;
    const generatedSpec = response.plan.generatedSpec ?? plan.generatedSpec;
    detailPlan.value = { ...plan, ...response.plan, ...(generatedSpec ? { generatedSpec } : {}), ...(resolvedContract ? { resolvedContract } : {}), dispatch: response.dispatch, mergeRequest: response.mergeRequest };
    detailLatestRevision.value = response.plan.revision;
    if (isCandidate) {
      detailVersionSource.value = "candidate";
      const history = await api.candidatePlanVersions(planId).catch(() => null);
      if (!isCurrentDetailRequest()) return;
      detailRevisions.value = history?.items.map((item) => item.revision) ?? [];
      detailConfirmedRevisions.value = [];
    } else {
      detailVersionSource.value = "confirmed";
      try {
        const [history, candidateHistory] = await Promise.all([api.planRevisions(planId), api.candidatePlanVersions(planId)]);
        if (!isCurrentDetailRequest()) return;
        const versions = resolvePlanVersionHistory(candidateHistory.items, history.items);
        detailRevisions.value = versions.revisions;
        detailConfirmedRevisions.value = versions.confirmedRevisions;
      } catch {
        // Current Plan remains readable when historical version metadata is unavailable.
      }
    }
  } catch (caught) {
    if (!isCurrentDetailRequest()) return;
    detailLoadError.value = caught instanceof Error ? `无法加载完整 Plan：${caught.message}` : "无法加载完整 Plan";
  }
}

async function selectPlanRevision(revisionNumber: number): Promise<void> {
  const current = detailPlan.value;
  const planId = current?.id ?? current?.planId;
  if (!current || !planId || current.revision === revisionNumber) return;
  const requestVersion = detailRequestVersion;
  detailLoadError.value = null;
  try {
    if (detailVersionSource.value === "candidate" || !isConfirmedPlanRevision(revisionNumber, detailConfirmedRevisions.value)) {
      const response = await api.getCandidatePlanVersion(planId, revisionNumber);
      if (requestVersion !== detailRequestVersion) return;
      detailPlan.value = response.version;
    } else {
      const response = await api.getPlanRevision(planId, revisionNumber);
      if (requestVersion !== detailRequestVersion) return;
      detailPlan.value = { ...current, revision: response.revision.revision, status: "READY", ...(response.revision.contract ? { contract: response.revision.contract } : {}), ...(response.revision.resolvedContract ? { resolvedContract: response.revision.resolvedContract } : {}) };
    }
  } catch (caught) {
    if (requestVersion !== detailRequestVersion) return;
    detailLoadError.value = caught instanceof Error ? `无法加载 V${revisionNumber}：${caught.message}` : `无法加载 V${revisionNumber}`;
  }
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
      await router.push({ path: `/projects/${projectId.value}/explorer`, query: { explorerId: plan.sourceExplorerThreadId, explorerPlanId: plan.explorerPlanId, contextPanel: "plans" } });
      ElMessage.success(`已打开 ${plan.title} · V${plan.revision}；下一次完整 READY 会保存为 V${plan.revision + 1}`);
    } catch (caught) {
      ElMessage.error(caught instanceof Error ? caught.message : "Plan 编辑入口加载失败");
    } finally { busy.value = false; }
    return;
  }
  busy.value = true;
  try {
    let result;
    try {
      result = await api.createRevisionDraft(planId, plan.revision, { explorerThreadId: plan.sourceExplorerThreadId, discardUnmergedRun: false, clientRequestId: `keep-editing-${planId}-${plan.revision}` });
    } catch (caught) {
      if (!(caught instanceof Error) || !caught.message.includes("UNMERGED_RUN_CONFIRMATION_REQUIRED")) throw caught;
      await ElMessageBox.confirm("This revision has an unmerged Run. Continuing will terminate its Executor, remove its worktree, and run cleanup hooks. The Run, ExecutionThread, and audit journal are retained permanently.", "Discard unmerged execution", { type: "warning", confirmButtonText: "Clean up and edit V" + String(plan.revision + 1), cancelButtonText: "Cancel" });
      result = await api.createRevisionDraft(planId, plan.revision, { explorerThreadId: plan.sourceExplorerThreadId, discardUnmergedRun: true, clientRequestId: `keep-editing-cleanup-${planId}-${plan.revision}` });
    }
    drawerOpen.value = false;
    await router.push({ path: `/projects/${projectId.value}/explorer`, query: { ...route.query, explorerId: result.explorerThread.id } });
    await nextTick();
    if (timeline.value) scrollTimelineToLatest(timeline.value);
    (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus();
    ElMessage.success(`Editing ${planId} · V${plan.revision} → V${result.draft.targetRevision}`);
  } catch (caught) {
    if (caught !== "cancel") ElMessage.error(caught instanceof Error ? caught.message : "Keep editing failed");
  } finally { busy.value = false; }
}

function selectContextPanel(selection: ContextPanel) {
  contextPanel.value = selection;
}

function syncPanelStateFromRoute() {
  const routeContextPanel = route.query.contextPanel;
  if (routeContextPanel === "candidate" || routeContextPanel === "plans" || routeContextPanel === "confirmed" || routeContextPanel === "enqueued" || routeContextPanel === "dispatched" || routeContextPanel === "active" || routeContextPanel === "attention" || routeContextPanel === "plan-center") contextPanel.value = routeContextPanel;
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

function planEventTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function runRoutePath(runId: string, explorerId?: string | null, explorerPlanId?: string | null): string {
  const query = new URLSearchParams();
  const sourceExplorerId = explorerId ?? thread.value?.id;
  if (sourceExplorerId) query.set("explorerId", sourceExplorerId);
  if (explorerPlanId) query.set("explorerPlanId", explorerPlanId);
  query.set("contextPanel", contextPanel.value);
  query.set("runId", runId);
  return `/projects/${encodeURIComponent(projectId.value)}/explorer?${query.toString()}`;
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

function openPlanRun(plan: Plan): void {
  const runId = plan.runId ?? plan.dispatch?.runId;
  if (!runId) return;
  void openRunView(runId, plan.sourceExplorerThreadId, plan.explorerPlanId ?? null);
}

async function openProjectRun(run: Run): Promise<void> {
  try {
    const plan = await api.getPlan(run.planId);
    await openRunView(run.id, plan.plan.sourceExplorerThreadId, plan.plan.explorerPlanId ?? null);
  } catch {
    await openRunView(run.id);
  }
}

async function createExplorer() {
  if (creatingExplorer.value) return;
  const requestProjectId = projectId.value;
  creatingExplorer.value = true;
  closeEvents();
  requestScope.invalidate();
  resetThreadState();
  try {
    const created = await api.createExplorer(requestProjectId);
    if (projectId.value !== requestProjectId) return;
    explorers.value = [created.explorer, ...explorers.value.filter((item) => item.id !== created.explorer.id)];
    explorerError.value = null;
    thread.value = created.explorer;
    try { project.value = (await api.selectProjectExplorer(requestProjectId, created.explorer.id)).project; } catch { /* Legacy API instances may not have a Project registry yet. */ }
    await router.push({ path: route.path, query: explorerRouteQuery(created.explorer.id), hash: "" });
    const requestToken = requestScope.begin(requestProjectId);
    activeRequestToken = requestToken;
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
  void router.push({ path: projectPathForModule("explore", selectedProjectId), query: { contextPanel: contextPanel.value, ...(projectExecutionMode.value ? { workspace: "project-execution" } : {}) } });
}

function selectProjectExecution() {
  closeEvents();
  closeRequirementStatusEvents();
  requestScope.invalidate();
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

function openProjectSettingsDialog(selectedProjectId: string) {
  projectSettingsProjectId.value = selectedProjectId;
  projectSettingsOpen.value = true;
}

function closeProjectSettings(value: boolean) {
  projectSettingsOpen.value = value;
  if (!value) projectSettingsProjectId.value = null;
}

async function handleProjectSettingsSaved(savedProject: Project) {
  projects.value = projects.value.map((item) => item.id === savedProject.id ? { ...item, ...savedProject } : item);
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
      await ElMessageBox.confirm("归档后项目历史仍可查看，但不能创建新的 Explorer Turn 或 Run。", `归档 ${selectedProject.name}？`, { type: "warning", confirmButtonText: "归档项目", cancelButtonText: "取消" });
      response = await api.archiveProject(selectedProjectId);
      ElMessage.success("项目已归档");
    } else {
      response = await api.activateProject(selectedProjectId);
      ElMessage.success("项目已恢复");
    }
    projects.value = projects.value.map((item) => item.id === selectedProjectId ? { ...item, ...response.project } : item);
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
  requestScope.invalidate();
  resetThreadState();
  const selected = explorers.value.find((item) => item.id === explorerId);
  if (selected?.state !== "ARCHIVED") {
    try { project.value = (await api.selectProjectExplorer(projectId.value, explorerId)).project; } catch { /* Keep navigation available for legacy API instances. */ }
  }
  await router.push({ path: route.path, query: explorerRouteQuery(explorerId), hash: "" });
}

async function selectExplorerPlan(explorerPlanId: string, shouldScroll = true): Promise<void> {
  const currentThread = thread.value;
  const selectedPlan = explorerPlans.value.find((plan) => plan.id === explorerPlanId);
  if (!currentThread || !selectedPlan || selectedPlan.explorerThreadId !== currentThread.id) return;
  const requestProjectId = projectId.value;
  const requestToken = activeRequestToken;
  const requestVersion = ++planProjectionVersion;
  const previousPlanId = activeExplorerPlanId.value;
  if (previousPlanId && previousPlanId !== selectedPlan.id) requirementDrafts.set(previousPlanId, draft.value);
  if (previousPlanId !== selectedPlan.id) draft.value = requirementDrafts.get(selectedPlan.id) ?? "";
  closeEvents();
  activeExplorerPlanId.value = selectedPlan.id;
  thread.value = { ...currentThread, activeExplorerPlanId: selectedPlan.id };
  try {
    const activation = await api.activateExplorerPlan(requestProjectId, currentThread.id, selectedPlan.id);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
    thread.value = activation.explorer;
    explorers.value = explorers.value.map((item) => item.id === currentThread.id ? activation.explorer : item);
    try {
      const planGroupsResponse = await api.explorerPlanGroups(requestProjectId, currentThread.id);
      if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
      explorerPlans.value = planGroupsResponse.items;
    } catch {
      // Task workspace switching remains available when the background tree refresh is temporarily unavailable.
    }
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
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

async function openAddRequirementDialog(): Promise<void> {
  const currentThread = thread.value;
  if (!currentThread || currentThread.state === "ARCHIVED" || project.value?.status === "ARCHIVED") return;
  try {
    const { value } = await ElMessageBox.prompt("描述这项需求要解决什么问题，或希望得到什么结果。", "新增需求", {
      inputType: "textarea",
      inputPlaceholder: "输入需求描述…",
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      inputValidator: (input) => Boolean(input.trim()) || "请输入需求描述",
    });
    const description = value.trim();
    const response = await api.createExplorerPlan(projectId.value, currentThread.id);
    if (thread.value?.id !== currentThread.id) return;
    explorerPlans.value = [...explorerPlans.value, response.explorerPlan].sort((a, b) => a.ordinal - b.ordinal);
    thread.value = response.explorer;
    await selectExplorerPlan(response.explorerPlan.id, false);
    if (thread.value?.id !== currentThread.id) return;
    drawerTab.value = "explorer";
    drawerOpen.value = true;
    draft.value = description;
    await router.replace({ path: route.path, query: { ...route.query, explorerId: currentThread.id, explorerPlanId: response.explorerPlan.id, requirementTab: "explorer" } });
    await nextTick();
    document.querySelector<HTMLTextAreaElement>(".drawer-conversation-column .composer textarea")?.focus();
    await sendTurn();
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    ElMessage.error(caught instanceof Error ? `新建需求失败：${caught.message}` : "新建需求失败");
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
  await router.replace({ path: route.path, query: { ...route.query, explorerId: thread.value?.id, explorerPlanId, requirementTab: "explorer" } });
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
    const query: Record<string, string | string[] | null | undefined> = { ...route.query, explorerId: thread.value?.id, explorerPlanId, requirementTab: "task" };
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

async function renameExplorerPlan(explorerPlanId: string): Promise<void> {
  const currentThread = thread.value;
  const current = explorerPlans.value.find((plan) => plan.id === explorerPlanId);
  if (!currentThread || !current) return;
  try {
    const { value } = await ElMessageBox.prompt("输入需求名称", "重命名需求", { inputValue: current.title, confirmButtonText: "保存", cancelButtonText: "取消", inputValidator: (value) => Boolean(value.trim()) || "名称不能为空" });
    const response = await api.renameExplorerPlan(projectId.value, currentThread.id, explorerPlanId, value.trim());
    if (thread.value?.id !== currentThread.id) return;
    explorerPlans.value = explorerPlans.value.map((plan) => plan.id === explorerPlanId ? response.explorerPlan : plan);
    ElMessage.success("需求已重命名");
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    ElMessage.error(caught instanceof Error ? `重命名需求失败：${caught.message}` : "重命名需求失败");
  }
}

function selectPlanFromCard(plan: Plan, event?: MouseEvent): void {
  const target = event?.target as HTMLElement | null;
  if (target?.closest("button, a, .el-button")) return;
  if (plan.explorerPlanId) void selectExplorerPlan(plan.explorerPlanId);
}

function planRequirementLabel(plan: Plan): string {
  const requirement = explorerPlans.value.find((item) => item.id === plan.explorerPlanId);
  return requirement ? taskDisplayTitle(requirement) : "需求分区";
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
      explorers.value = explorers.value.map((item) => item.id === explorerId ? response.explorer : item);
      if (thread.value?.id === explorerId) thread.value = response.explorer;
      else await selectExplorer(explorerId);
      ElMessage.success("线程已恢复");
      return;
    }
    await ElMessageBox.confirm("归档后线程历史仍可查看，但不能继续创建新的 Explorer Turn。", `归档 ${selected.title}？`, { type: "warning", confirmButtonText: "归档线程", cancelButtonText: "取消" });
    const response = await api.archiveExplorer(projectId.value, explorerId);
    explorers.value = explorers.value.map((item) => item.id === explorerId ? response.explorer : item);
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

async function refreshActivity() {
  if (!thread.value) return;
  const explorerPlanId = activeExplorerPlan.value?.id;
  if (!explorerPlanId) return;
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  try {
    const response = await api.explorerActivity(requestProjectId, requestThreadId, explorerPlanId);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId || activeExplorerPlan.value?.id !== explorerPlanId) return;
    activity.value = response.items;
    explorerEventSequence = Math.max(explorerEventSequence ?? 0, response.lastEventSequence ?? 0);
  } catch {
    // activity 投影追赶期间，以 turn stream 为消息真相来源，避免重复或丢失内容。
  }
}

/**
 * 合并流式增量触发的投影刷新。尾部会再执行一次，保证最终状态与事件流一致；
 * 页面卸载或切换线程时必须调用 cancelProjectionRefresh 清掉待执行任务。
 */
function scheduleProjectionRefresh() {
  if (projectionRefreshTimer !== null) return;
  projectionRefreshTimer = setTimeout(() => {
    projectionRefreshTimer = null;
    if (!thread.value) return;
    void refreshActivity();
    void refreshPlanProjection();
  }, PROJECTION_REFRESH_INTERVAL_MS);
}

function cancelProjectionRefresh() {
  if (projectionRefreshTimer === null) return;
  clearTimeout(projectionRefreshTimer);
  projectionRefreshTimer = null;
}

function cancelLoopRefresh() {
  if (loopRefreshTimer === null) return;
  clearTimeout(loopRefreshTimer);
  loopRefreshTimer = null;
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
    const runPlan = routeRun ? threadPlans.value.find((plan) => (plan.planId ?? plan.id) === routeRun.planId && plan.revision === routeRun.planRevision) : undefined;
    const runExplorerPlanId = runPlan?.explorerPlanId;
    activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === routePlanId) ? routePlanId : explorerPlans.value.some((plan) => plan.id === runExplorerPlanId) ? runExplorerPlanId ?? null : explorerPlans.value.some((plan) => plan.id === selected.activeExplorerPlanId) ? selected.activeExplorerPlanId ?? null : explorerPlans.value[0]?.id ?? null;
    const projection = normalizePlanProjection(selected, null, plansResponse.items);
    applyPlanProjection(projection, confirmedResponse?.items ?? [], null);
    const workspaceLoaded = await loadActivePlanWorkspace(selected.id, activeExplorerPlanId.value, requestProjectId, requestToken);
    if (!workspaceLoaded) return false;
    if (eventSource) connectLoopEvents();
    explorerPaused.value = agentLoop.value?.state === "PAUSED";
    const routeDrawerTab = route.query.requirementTab;
    if (activeRunId.value) {
      drawerTab.value = "task";
      drawerOpen.value = true;
    } else if (routePlanId && activeExplorerPlan.value) {
      drawerTab.value = routeDrawerTab === "plan" || routeDrawerTab === "task" ? routeDrawerTab : "explorer";
      drawerOpen.value = true;
      if (drawerTab.value === "plan" && selectedRequirementRow.value?.plan) void openPlanDetail(selectedRequirementRow.value.plan);
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
  const [healthResponse, projectListResponse, projectResponse, explorerResponse, projectRunsResponse, requirementsResponse] = await Promise.all([optional(() => api.health()), optional(() => api.projects()), api.project(requestProjectId), api.explorers(requestProjectId), api.projectRuns(requestProjectId), optional(() => api.explorerPlanRequirements())]);
  if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  projects.value = projectListResponse?.items ?? [];
  project.value = projectResponse.project;
  if (healthResponse?.model) explorerModel.value = healthResponse.model;
  explorers.value = explorerResponse.items;
  projectRuns.value = projectRunsResponse.items;
  planRequirements.value = requirementsResponse?.requirements.areas ?? defaultPlanRequirements;
  explorerError.value = null;

  // 固定执行线程只加载项目目录；没有 Explorer 时不能为进入执行模式而
  // 隐式创建 Explorer/ExplorerPlan。
  if (projectExecutionMode.value) {
    thread.value = null;
    return true;
  }

  const routeExplorerId = typeof route.query.explorerId === "string" ? route.query.explorerId : null;
  let selected = routeExplorerId ? explorerResponse.items.find((item) => item.id === routeExplorerId) : undefined;
  if (!routeExplorerId && projectResponse.project.currentExplorerThreadId) selected = explorerResponse.items.find((item) => item.id === projectResponse.project.currentExplorerThreadId);
  if (!routeExplorerId && thread.value) selected = explorerResponse.items.find((item) => item.id === thread.value?.id);
  if (!selected) selected = explorerResponse.items.find((item) => item.state !== "ARCHIVED" && item.contextMode === "FRESH" && item.messageCount === 0);
  if (!selected) {
    selected = (await api.createExplorer(requestProjectId)).explorer;
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    explorers.value = [selected, ...explorers.value.filter((item) => item.id !== selected?.id)];
    try { project.value = (await api.selectProjectExplorer(requestProjectId, selected.id)).project; } catch { /* Keep the directory usable for legacy API instances. */ }
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  }
  if (!selected) return false;
  thread.value = selected;
  const loaded = await loadExplorerDetails(selected, requestProjectId, requestToken);
  if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
  if (typeof route.query.explorerId !== "string" || route.query.explorerId !== selected.id || route.query.explorerPlanId !== activeExplorerPlanId.value) {
    await router.replace({ path: route.path, query: explorerRouteQuery(selected.id, activeExplorerPlanId.value, true), hash: route.hash });
  }
  return loaded;
}

/** 先加载 Project/Explorer 目录，再加载当前线程详情，避免详情失败清空已成功的目录。 */
async function load(): Promise<boolean> {
  const requestProjectId = projectId.value;
  const requestToken = requestScope.begin(requestProjectId);
  activeRequestToken = requestToken;
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
  if (!content || activePlanBusy.value || sendingCurrentPlan.value || busy.value || !thread.value || thread.value.state === "ARCHIVED" || project.value?.status === "ARCHIVED") return false;
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  const now = new Date().toISOString();
  const currentPlanId = activeExplorerPlan.value?.id ?? thread.value.activeExplorerPlanId ?? undefined;
  if (!currentPlanId) { ElMessage.error("请先选择一个需求再发送消息"); return false; }
  requirementDrafts.delete(currentPlanId);
  const previousFailure = failedExplorerSends.get(currentPlanId);
  const retrying = previousFailure?.content === content ? previousFailure : null;
  const optimisticUser = retrying
    ? turns.value.find((turn) => turn.id === retrying.optimisticUserId) ?? createOptimisticUserTurn({ id: retrying.optimisticUserId, threadId: requestThreadId, content, createdAt: now, sequence: turns.value.length + 1 })
    : createOptimisticUserTurn({ id: `local-user-${Date.now()}`, threadId: requestThreadId, content, createdAt: now, sequence: turns.value.length + 1 });
  optimisticUser.explorerPlanId = currentPlanId;
  let assistantActivityId = retrying?.assistantActivityId ?? "";
  if (retrying) {
    if (retrying.failedAssistantTurnId) turns.value = turns.value.filter((turn) => turn.id !== retrying.failedAssistantTurnId);
    if (!turns.value.some((turn) => turn.id === optimisticUser.id)) turns.value = [...turns.value, optimisticUser];
    activity.value = activity.value.map((item) => item.id === retrying.assistantActivityId ? { ...item, status: "RUNNING", summary: "Plan Explorer 正在处理…", occurredAt: now } : item);
  } else {
    turns.value = [...turns.value, optimisticUser];
    assistantActivityId = `local-assistant-activity-${Date.now()}`;
    const optimisticAssistant: ExplorerActivityItem = { id: assistantActivityId, explorerId: optimisticUser.threadId, turnId: `local-assistant-turn-${Date.now()}`, sequence: optimisticUser.sequence + 1, kind: "ASSISTANT_MESSAGE", status: "RUNNING", title: "Plan Explorer", summary: "Plan Explorer 正在处理…", details: null, occurredAt: new Date().toISOString(), explorerPlanId: currentPlanId };
    activity.value = [...activity.value, { id: `local-user-activity-${optimisticUser.id}`, explorerId: optimisticUser.threadId, turnId: optimisticUser.id, sequence: optimisticUser.sequence, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: content, details: null, occurredAt: now, explorerPlanId: currentPlanId }, optimisticAssistant];
  }
  const failedSend: FailedExplorerSend = retrying ?? { content, clientTurnId: `client-turn-${Date.now()}`, optimisticUserId: optimisticUser.id, assistantActivityId, failedAssistantTurnId: null };
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
    if (thread.value) thread.value = { ...thread.value, messageCount: thread.value.messageCount + 2, lastActivityAt: response.turn.assistant.createdAt };
    ElMessage.success("消息已发送");
    return true;
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return false;
    const message = caught instanceof Error ? caught.message : "API 未连接";
    const failedAssistantTurnId = `local-assistant-${Date.now()}`;
    turns.value = [...turns.value, { id: failedAssistantTurnId, threadId: optimisticUser.threadId, role: "assistant", content: `消息发送失败：${message}。保留原描述，可在此需求中重试。`, status: "FAILED", error: message, createdAt: new Date().toISOString(), sequence: optimisticUser.sequence + 1, explorerPlanId: currentPlanId }];
    failedExplorerSends.set(currentPlanId, { ...failedSend, failedAssistantTurnId });
    draft.value = content;
    activity.value = activity.value.map((item) => item.id === failedSend.assistantActivityId ? { ...item, status: "FAILED", summary: `消息发送失败：${message}。请重试。`, occurredAt: new Date().toISOString() } : item);
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

async function openInputRequest() {
  if (!pendingInput.value) return;
  inputDialogOpen.value = true;
}

function updateInputProgress(progress: ExplorerInputProgress) {
  if (pendingInput.value?.id !== progress.requestId) return;
  inputProgress.value = progress;
  const scope = inputProgressScope();
  const request = inputRequests.value.find((item) => item.id === progress.requestId);
  if (scope && request) saveExplorerInputProgressDraft(scope, request, progress);
}

/** 提交结构化选择；失败时保留对话框状态，允许用户修正或重试而不丢答案。 */
async function submitInput(answers: Record<string, { answers: string[] }>) {
  const request = pendingInput.value;
  const currentThread = thread.value;
  const explorerPlanId = activeExplorerPlan.value?.id;
  if (!request || !currentThread || !explorerPlanId || inputAnswerInFlight.value === request.id) return;
  const requestProjectId = projectId.value;
  inputAnswerInFlight.value = request.id;
  const submission = api.answerInput(requestProjectId, request.id, answers, `answer-${request.id}`);
  // The API waits for the Provider to acknowledge the answer. Close the modal
  // immediately and show its saved draft/status in the timeline while that runs.
  inputDialog.value?.onSubmitted();
  try {
    const response = await submission;
    if (thread.value?.id !== currentThread.id || activeExplorerPlan.value?.id !== explorerPlanId) return;
    setInputRequests([...inputRequests.value.filter((item) => item.id !== response.request.id), response.request]);
    inputProgress.value = null;
    ElMessage.success("选择已提交，Plan Explorer 将继续当前回合");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "提交选择失败，请重试";
    if (thread.value?.id !== currentThread.id || activeExplorerPlan.value?.id !== explorerPlanId) return;
    try {
      const current = await api.inputRequests(requestProjectId, currentThread.id, explorerPlanId);
      setInputRequests(current.items);
    } catch {
      // Keep the local draft and avoid inviting a duplicate submission when
      // the server cannot confirm whether it accepted the first request.
    }
    if (pendingInput.value?.id === request.id) {
      inputDialog.value?.onFailed(message);
      inputDialogOpen.value = true;
      ElMessage.error(`${message}，已保留本次选择`);
    } else {
      ElMessage.warning("提交状态尚未确认；页面会继续显示已保存的选择，请勿重复提交");
    }
  } finally {
    if (inputAnswerInFlight.value === request.id) inputAnswerInFlight.value = null;
  }
}

async function cancelInput() {
  if (!pendingInput.value || !thread.value) return;
  try {
    await api.cancelExplorerTurn(projectId.value, thread.value.id, pendingInput.value.localTurnId, "user_cancelled");
    inputDialogOpen.value = false;
    pendingInput.value = null;
    inputProgress.value = null;
    ElMessage.info("本轮已取消");
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "取消本轮失败"); }
}

function mergeTurn(turn: ExplorerTurn) {
  const index = turns.value.findIndex((item) => item.id === turn.id);
  if (index < 0) turns.value = [...turns.value, turn];
  else turns.value = turns.value.map((item) => item.id === turn.id ? { ...item, ...turn } : item);
}

async function refreshTurnsAfterEvent() {
  if (!thread.value) return;
  const explorerPlanId = activeExplorerPlan.value?.id;
  if (!explorerPlanId) return;
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  const response = await api.getExplorerTurns(requestProjectId, requestThreadId, explorerPlanId);
  if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId || activeExplorerPlan.value?.id !== explorerPlanId) return;
  turns.value = response.items;
  await refreshActivity();
  await refreshPlanProjection();
  const inputResponse = await api.inputRequests(requestProjectId, requestThreadId, explorerPlanId);
  if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId || activeExplorerPlan.value?.id !== explorerPlanId) return;
  setInputRequests(inputResponse.items);
  if (!pendingInput.value) inputDialogOpen.value = false;
  await nextTick();
  if (timeline.value) scrollTimelineToLatest(timeline.value);
}

function connectEvents() {
  if (!thread.value || !activeExplorerPlan.value || typeof EventSource === "undefined") return;
  connectRequirementStatusEvents();
  const connectionProjectId = projectId.value;
  const connectionThreadId = thread.value.id;
  const connectionPlanId = activeExplorerPlan.value.id;
  const connectionToken = activeRequestToken;
  const isConnectionCurrent = () => isCurrentProjectScope(connectionProjectId, connectionToken) && thread.value?.id === connectionThreadId && activeExplorerPlan.value?.id === connectionPlanId;
  eventSource?.close();
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  if (explorerEventSequence !== null) replayGate.markReady();
  eventSource = new EventSource(api.explorerEventsUrl(connectionProjectId, connectionThreadId, connectionPlanId, explorerEventSequence ?? undefined));
  eventSource.addEventListener("stream.ready", () => {
    if (!isConnectionCurrent()) return;
    replayGate.accept("stream.ready");
    void refreshTurnsAfterEvent();
  });
  eventSource.addEventListener("turn.text.delta", (raw) => {
    if (!isConnectionCurrent() || !replayGate.accept("turn.text.delta")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { turnId: string; text: string };
    const current = turns.value.find((turn) => turn.id === payload.turnId);
    if (current) mergeTurn({ ...current, content: current.content + payload.text, status: "RUNNING" });
    scheduleProjectionRefresh();
  });
  eventSource.addEventListener("turn.input_required", async (raw) => {
    if (!isConnectionCurrent() || !replayGate.accept("turn.input_required")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { requestId: string };
    const response = await api.inputRequests(connectionProjectId, connectionThreadId, connectionPlanId);
    if (!isConnectionCurrent()) return;
    setInputRequests(response.items);
    pendingInput.value = response.items.find((item) => item.id === payload.requestId) ?? null;
    recoveryInput.value = null;
    inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
    void refreshPlanProjection();
  });
  eventSource.addEventListener("title.updated", (raw) => {
    if (!isConnectionCurrent() || !replayGate.accept("title.updated")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { explorerId: string; title: string; titleStatus: ExplorerThread["titleStatus"] };
    if (payload.explorerId !== connectionThreadId || !thread.value) return;
    thread.value = { ...thread.value, title: payload.title, titleStatus: payload.titleStatus };
    explorers.value = explorers.value.map((item) => item.id === payload.explorerId ? { ...item, title: payload.title, titleStatus: payload.titleStatus } : item);
  });
  for (const eventName of ["turn.accepted", "turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.input.resolved", "plan.ready"]) eventSource.addEventListener(eventName, () => { if (!isConnectionCurrent() || !replayGate.accept(eventName)) return; void refreshTurnsAfterEvent(); });
  for (const eventName of ["plan.created", "plan.renamed"]) eventSource.addEventListener(eventName, () => { if (!isConnectionCurrent() || !replayGate.accept(eventName)) return; void refreshPlanProjection(); });
  eventSource.addEventListener("thread.state.changed", () => { if (!isConnectionCurrent() || !replayGate.accept("thread.state.changed")) return; closeEvents(); void load().then((loaded) => { if (loaded) connectEvents(); }); });
  connectLoopEvents();
}

function connectRequirementStatusEvents() {
  if (!thread.value || typeof EventSource === "undefined") return;
  const connectionProjectId = projectId.value;
  const connectionThreadId = thread.value.id;
  if (requirementStatusEventSource && requirementStatusScope?.projectId === connectionProjectId && requirementStatusScope.threadId === connectionThreadId) return;
  closeRequirementStatusEvents();
  const connectionToken = activeRequestToken;
  const source = new EventSource(api.explorerRequirementStatusEventsUrl(connectionProjectId, connectionThreadId, explorerEventSequence ?? undefined));
  requirementStatusEventSource = source;
  requirementStatusScope = { projectId: connectionProjectId, threadId: connectionThreadId };
  source.addEventListener("requirement.status", (raw) => {
    if (requirementStatusEventSource !== source || !isCurrentProjectScope(connectionProjectId, connectionToken) || thread.value?.id !== connectionThreadId) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { explorerPlanId: string; turnId: string | null; status: NonNullable<ExplorerPlan["runtimeStatus"]>; occurredAt: string };
    if (!explorerPlans.value.some((plan) => plan.id === payload.explorerPlanId && plan.explorerThreadId === connectionThreadId)) return;
    explorerPlans.value = explorerPlans.value.map((plan) => plan.id === payload.explorerPlanId ? { ...plan, runtimeStatus: payload.status, lastActivityAt: payload.occurredAt } : plan);
  });
}

function connectLoopEvents() {
  if (!agentLoop.value || typeof EventSource === "undefined") return;
  const connectionProjectId = projectId.value;
  const connectionThreadId = thread.value?.id;
  const connectionToken = activeRequestToken;
  const loopId = agentLoop.value.id;
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  loopEventSource = new EventSource(api.agentLoopEventsUrl(loopId));
  loopEventSource.addEventListener("stream.ready", () => { replayGate.accept("stream.ready"); });
  for (const eventName of ["agent.loop.started", "agent.step.started", "agent.step.model_text_delta", "agent.step.tool_requested", "agent.step.tool_completed", "agent.step.tool_denied", "agent.step.tool_failed", "agent.step.tool_needs_reconciliation", "agent.step.input_required", "agent.step.input_resolved", "agent.step.context_compacted", "agent.step.gate_checked", "agent.provider.activity", "agent.input.required", "agent.input.resolved", "agent.loop.paused", "agent.loop.resumed", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required"]) {
    // 状态与门禁事件立即刷新；步骤级事件（文本增量、工具活动）合并到固定间隔，避免每个事件都拉取 Loop。
    const immediate = AGENT_LOOP_IMMEDIATE_REFRESH_EVENTS.has(eventName);
    loopEventSource.addEventListener(eventName, () => {
      if (!isCurrentProjectScope(connectionProjectId, connectionToken) || thread.value?.id !== connectionThreadId || !replayGate.accept(eventName)) return;
      const refresh = () => {
        void api.agentLoop(loopId).then(async (response) => {
          if (!isCurrentProjectScope(connectionProjectId, connectionToken) || thread.value?.id !== connectionThreadId || agentLoop.value?.id !== loopId) return;
          agentLoop.value = response.loop;
          explorerPaused.value = response.loop.state === "PAUSED";
          await refreshActivity();
          if (immediate) await refreshPlanProjection();
        }).catch(() => undefined);
      };
      if (immediate) { cancelLoopRefresh(); refresh(); return; }
      if (loopRefreshTimer !== null) return;
      loopRefreshTimer = setTimeout(() => { loopRefreshTimer = null; refresh(); }, PROJECTION_REFRESH_INTERVAL_MS);
    });
  }
}

function closeRequirementStatusEvents() { requirementStatusEventSource?.close(); requirementStatusEventSource = null; requirementStatusScope = null; }
function closeEvents() { eventSource?.close(); loopEventSource?.close(); eventSource = null; loopEventSource = null; cancelProjectionRefresh(); cancelLoopRefresh(); }

async function confirmPlan() {
  if (!candidate.value || !candidate.value.id && !candidate.value.planId || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId!;
  const activeDraft = revisionDraft.value;
  if (activeDraft && activeDraft.planId === id) {
    if (activeDraft.status !== "READY_TO_CONFIRM") {
      ElMessage.info(activeDraft.status === "BASE_CHANGED" ? "Default branch changed. Rebase the revision draft before confirmation." : "Continue exploring until this revision draft is ready to confirm.");
      return;
    }
    busy.value = true;
    try {
      const response = await api.confirmRevisionDraft(id, activeDraft.draftId);
      drawerTab.value = "plan";
      drawerOpen.value = true;
      await refreshPlanProjection();
      detailPlan.value = response.plan;
      ElMessage.success(`Revision ${activeDraft.targetRevision} confirmed · ${response.confirmation?.stage ?? "FROZEN"}`);
    } catch (caught) { error.value = caught instanceof Error ? `Confirm revision failed: ${caught.message}` : "Confirm revision failed"; }
    finally { busy.value = false; }
    return;
  }
  busy.value = true;
  try {
    const response = await api.confirmPlan(id, candidate.value.revision);
    await refreshPlanProjection();
    if (response.plan.status === "DRAFT") {
      const failure = response.dispatch?.lastError ?? "Plan 校验未通过";
      error.value = `确认停在 ${response.confirmation.stage}：${failure}`;
      ElMessage.error(error.value);
      return;
    }
    drawerTab.value = "plan";
    drawerOpen.value = true;
    detailPlan.value = response.plan;
    const runText = response.run ? ` · Run ${response.run.id}` : "";
    const issueText = response.dispatch?.lastError ? ` · ${response.dispatch.lastError}` : "";
    ElMessage.success(`Plan 已确认 · ${response.confirmation.stage}${runText}${issueText}`);
  } catch (caught) { error.value = caught instanceof Error ? `Confirm plan 失败：${caught.message}` : "Confirm plan 失败"; } finally { busy.value = false; }
}

async function enqueuePlan(plan: Plan | null = candidate.value) {
  if (!plan || plan.status !== "READY" || busy.value) return;
  if (isConversationArtifactPlan(plan)) {
    ElMessage.error("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
    return;
  }
  const id = plan.id ?? plan.planId;
  if (!id) return;
  busy.value = true;
  try {
    const enqueuedPlan = (await (plan.revision > 1 ? api.enqueuePlanRevision(id, plan.revision) : api.enqueuePlan(id))).plan;
    enqueued.value = [enqueuedPlan, ...enqueued.value.filter((item) => planIdentity(item) !== planIdentity(enqueuedPlan))];
    candidate.value = null;
    await refreshPlanProjection();
    drawerTab.value = "task";
    drawerOpen.value = true;
    ElMessage.success("Plan 已进入 Enqueued 阶段");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";
    if (message === "CONVERSATION_ARTIFACT_NOT_EXECUTABLE") {
      ElMessage.error("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
    } else {
      error.value = message ? `Enqueue plan 失败：${message}` : "Enqueue plan 失败";
    }
  } finally {
    busy.value = false;
  }
}

async function startPlanRun(plan: Plan): Promise<void> {
  const id = plan.id ?? plan.planId;
  if (!id || plan.status !== "ENQUEUED" || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await (plan.revision > 1 ? api.startPlanRevisionRun(id, plan.revision) : api.startPlanRun(id));
    await refreshPlanProjection();
    drawerTab.value = "task";
    drawerOpen.value = true;
    const runId = result.run?.id ?? selectedRequirementRow.value?.plan?.runId ?? selectedRequirementRow.value?.plan?.dispatch?.runId;
    if (result.run) projectRuns.value = [result.run, ...projectRuns.value.filter((run) => run.id !== result.run!.id)];
    if (runId) await openRunView(runId, thread.value?.id, activeExplorerPlan.value?.id);
    ElMessage.success(result.dispatch?.waitReason ? `Plan 已派发，正在等待：${result.dispatch.waitReason}` : "Plan 已进入 Dispatched 阶段");
  } catch (caught) {
    error.value = caught instanceof Error ? `Start run 失败：${caught.message}` : "Start run 失败";
    ElMessage.error(error.value);
  } finally {
    busy.value = false;
  }
}

function canCreateConfigurationRevision(plan: Plan): boolean {
  return canCreateConfigurationRevisionFor(plan, project.value);
}

async function revisePlanConfiguration(plan: Plan): Promise<void> {
  const id = plan.id ?? plan.planId;
  if (!id || plan.status !== "DISPATCHED" || plan.runId || plan.dispatch?.status !== "WAITING" || plan.dispatch.waitReason !== "NEEDS_CONFIGURATION" || !canCreateConfigurationRevision(plan) || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.revisePlanConfiguration(id);
    await refreshPlanProjection();
    contextPanel.value = "confirmed";
    ElMessage.success("已基于当前配置创建新 Revision，请重新 Enqueue 并 Start run");
  } catch (caught) {
    error.value = caught instanceof Error ? `Create updated revision 失败：${caught.message}` : "Create updated revision 失败";
    ElMessage.error(error.value);
  } finally {
    busy.value = false;
  }
}

function handlePlanCenterConfigurationRevised(): void {
  void refreshPlanProjection();
  contextPanel.value = "confirmed";
}

async function discardPlan() {
  if (!candidate.value || candidate.value.status !== "DRAFT" || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId;
  if (!id) return;
  const activeDraft = revisionDraft.value;
  if (activeDraft && activeDraft.planId === id) {
    try {
      await ElMessageBox.confirm(`Discard revision V${activeDraft.targetRevision}? The confirmed V${activeDraft.basedOnRevision} remains unchanged.`, "Discard revision draft", { confirmButtonText: "Discard revision", cancelButtonText: "Keep editing", type: "warning" });
    } catch { return; }
    busy.value = true;
    try {
      await api.discardRevisionDraft(id, activeDraft.draftId);
      drawerOpen.value = false;
      await refreshPlanProjection();
      ElMessage.success(`Revision ${activeDraft.targetRevision} discarded`);
    } catch (caught) { error.value = caught instanceof Error ? `Discard revision failed: ${caught.message}` : "Discard revision failed"; }
    finally { busy.value = false; }
    return;
  }
  try {
    await ElMessageBox.confirm(`Discard “${candidate.value.title}”? This Plan will be kept as Discarded and cannot be confirmed, enqueued, or started.`, "Discard plan", { confirmButtonText: "Discard plan", cancelButtonText: "Keep editing", type: "warning" });
  } catch {
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await api.discardPlan(id);
    candidate.value = null;
    drawerOpen.value = false;
    await refreshPlanProjection();
    ElMessage.success("Plan discarded");
  } catch (caught) {
    error.value = caught instanceof Error ? `Discard plan 失败：${caught.message}` : "Discard plan 失败";
    ElMessage.error(error.value);
  } finally {
    busy.value = false;
  }
}

function reloadExplorer() {
  closeEvents();
  requestScope.invalidate();
  resetThreadState();
  void load().then((loaded) => { if (loaded && mounted.value) connectEvents(); });
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
  requestScope.invalidate();
  resetThreadState();
  thread.value = selected;
  const requestToken = requestScope.begin(requestProjectId);
  activeRequestToken = requestToken;
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
  requestScope.invalidate();
  resetProjectState(next);
  void load().then((loaded) => { if (loaded && mounted.value) connectEvents(); });
});
watch(projectExecutionMode, (active, previous) => {
  if (!mounted.value || active === previous) return;
  closeEvents();
  closeRequirementStatusEvents();
  requestScope.invalidate();
  resetThreadState();
  if (active) {
    thread.value = null;
    void load();
  } else {
    void reloadSelectedExplorer();
  }
});
watch(() => route.query.explorerId, (routeExplorerId, previousExplorerId) => {
  if (!mounted.value || routeExplorerId === previousExplorerId || routeExplorerId === thread.value?.id) return;
  if (suppressNextExplorerRouteReload) {
    suppressNextExplorerRouteReload = false;
    return;
  }
  void reloadSelectedExplorer();
});
watch(() => route.query.explorerPlanId, (routePlanId, previousPlanId) => {
  if (!mounted.value || routePlanId === previousPlanId || !thread.value || typeof routePlanId !== "string" || routePlanId === activeExplorerPlan.value?.id) return;
  void selectExplorerPlan(routePlanId, true);
});
watch(activeRunId, (runId) => {
  if (!runId) return;
  drawerTab.value = "task";
  drawerOpen.value = true;
});
watch(() => route.query.requirementTab, (tab) => {
  if (tab !== "explorer" && tab !== "plan" && tab !== "task") return;
  drawerTab.value = tab;
  drawerOpen.value = true;
});
onMounted(() => { mounted.value = true; syncPanelStateFromRoute(); void load().then((loaded) => { if (loaded) connectEvents(); }); syncHashPanel(route.hash); });
onBeforeUnmount(() => { mounted.value = false; requestScope.invalidate(); closeEvents(); closeRequirementStatusEvents(); });
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
            <h1>{{ thread ? explorerDisplayTitle(thread) : "Explorer" }}</h1>
            <p>在当前探索线程中查看和管理需求。</p>
          </div>
        </header>
        <div v-if="error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">Retry</el-button></div>
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
            <div class="eyebrow">{{ thread ? explorerDisplayTitle(thread) : "EXPLORER" }}</div>
            <h2 :title="sharedDrawerTitle">{{ sharedDrawerTitle }}</h2>
          </div>
          <el-button text circle aria-label="关闭详情抽屉" @click="closeSharedDrawer"><Close /></el-button>
        </header>
        <nav class="shared-drawer-tabs" role="tablist" aria-label="需求详情类型">
          <button type="button" role="tab" :aria-selected="drawerTab === 'explorer'" :class="{ active: drawerTab === 'explorer' }" @click="switchDrawerTab('explorer')">探索对话</button>
          <button type="button" role="tab" :aria-selected="drawerTab === 'plan'" :disabled="!selectedRequirementRow?.plan" :class="{ active: drawerTab === 'plan' }" @click="switchDrawerTab('plan')">Plan 详情</button>
          <button type="button" role="tab" :aria-selected="drawerTab === 'task'" :disabled="!taskPanelPlan || selectedRequirementRow?.taskStatus.label === '—'" :class="{ active: drawerTab === 'task' }" @click="switchDrawerTab('task')">Run</button>
        </nav>
        <div class="shared-drawer-content">
          <section v-if="drawerTab === 'plan'" class="shared-drawer-pane plan-detail-pane" role="tabpanel" aria-label="Plan 详情">
            <PlanDetailContent
              :plan="detailPlan"
              :error="detailLoadError"
              :revisions="detailRevisions"
              :read-only="Boolean(detailPlan && detailLatestRevision !== null && detailPlan.revision !== detailLatestRevision)"
              :revision-draft-status="revisionDraft?.status ?? null"
              @close="closeSharedDrawer"
              @confirm="confirmPlan"
              @discard="discardPlan"
              @keep-editing="keepEditingPlan"
              @select-revision="selectPlanRevision"
            />
          </section>
          <section v-if="drawerTab === 'task'" class="shared-drawer-pane task-detail-pane" role="tabpanel" aria-label="Run">
            <RunDetailView v-if="activeRunId" :key="activeRunId" embedded :project-id="projectId" :run-id="activeRunId" @close="closeRunView" @open-plan="openPlanDetail" />
            <template v-else-if="taskPanelPlan">
              <header class="task-detail-heading"><div class="eyebrow">EXECUTION · REVISION {{ taskPanelPlan.revision }}</div><h3>{{ taskPanelPlan.title }}</h3><p>任务状态：{{ selectedRequirementRow?.taskStatus.label ?? '—' }}</p></header>
              <div v-if="taskPanelPlan.status === 'READY' && isConversationArtifactPlan(taskPanelPlan)" class="task-action-panel task-action-attention"><strong>此 Plan 是对话产物，不能入队执行。</strong><p>请在探索对话中改为“仓库文件”产物，指定目标路径后确认新版本。</p><el-button type="primary" plain @click="returnToCurrentRequirementChat">返回探索对话修订</el-button></div>
              <div v-else-if="taskPanelPlan.status === 'READY'" class="task-action-panel"><strong>Plan 已确认，可以入队。</strong><p>入队和开始运行是两个独立步骤。</p><el-button type="primary" :loading="busy" @click="enqueuePlan(taskPanelPlan)"><ArrowDown :size="15" /> 入队</el-button></div>
              <div v-else-if="taskPanelPlan.status === 'ENQUEUED'" class="task-action-panel"><strong>Plan 已入队，等待明确开始运行。</strong><p>开始运行后会进入该需求的 Run 对话。</p><el-button type="primary" :loading="busy" @click="startPlanRun(taskPanelPlan)"><Right :size="15" /> 开始运行</el-button></div>
              <div v-else-if="taskPanelPlan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" class="task-action-panel task-action-attention"><strong>等待处理项目执行配置</strong><p>{{ taskPanelPlan.dispatch.lastError ?? '此 Plan 需要项目验证命令配置。' }}</p><el-button plain @click="openProjectSettingsDialog(taskPanelPlan.projectId)">配置项目命令</el-button><el-button v-if="canCreateConfigurationRevision(taskPanelPlan)" type="primary" :loading="busy" @click="revisePlanConfiguration(taskPanelPlan)">创建更新版本</el-button></div>
              <div v-else class="task-action-panel"><strong>{{ selectedRequirementRow?.taskStatus.label ?? '任务状态未知' }}</strong><p>{{ taskPanelPlan.dispatch?.lastError ?? taskPanelPlan.attentionReason ?? '当前任务正在等待执行状态更新。' }}</p><el-button plain @click="refreshThread"><Refresh :size="14" /> 刷新状态</el-button></div>
              <el-button class="task-plan-link" text @click="openPlanDetail(taskPanelPlan)"><Document :size="15" /> 查看结构化 Plan</el-button>
            </template>
            <div v-else class="shared-drawer-empty"><strong>当前需求还没有可执行 Plan</strong><p>Plan 确认并进入任务阶段后，这里会显示入队操作和 Run 对话。</p></div>
          </section>
              <section v-if="drawerTab === 'explorer'" class="conversation-column drawer-conversation-column">
      <ProjectExecutionThreadPanel v-if="projectExecutionMode" :project-id="projectId" :project="project" />
      <template v-else>
      <div v-if="!activeRunId" class="conversation-header">
        <div class="conversation-header-copy">
          <h1 :title="explorerDisplayTitle(thread)">{{ explorerDisplayTitle(thread) }}</h1>
          <p v-if="revisionDraft" class="revision-draft-banner" role="status">Editing {{ revisionDraft.planId }} · V{{ revisionDraft.basedOnRevision }} → V{{ revisionDraft.targetRevision }} · {{ revisionDraft.status === 'READY_TO_CONFIRM' ? 'Ready to confirm' : revisionDraft.status === 'BASE_CHANGED' ? 'Base changed' : 'Continue editing' }}</p>
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
            @toggle-pause="toggleExplorerPause"
          />
        </div>
      </div>
      <div v-if="!activeRunId && explorerPaused" class="demo-notice pause-notice"><VideoPause :size="14" /> ExplorerThread is paused. New turns are disabled until you resume the thread.<el-button text @click="toggleExplorerPause">Resume</el-button></div>
      <div v-if="!activeRunId && error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">Retry</el-button></div>
      <div v-if="!activeRunId" class="timeline-stage">
      <div class="timeline-shell">
      <div ref="timeline" class="timeline" v-loading="loading" @scroll="updateTimelineScrollState">
        <div :id="activeExplorerPlan ? explorerPlanAnchorId(activeExplorerPlan.id) : undefined" :data-nav-key="activeExplorerPlan ? `explorer-plan-${activeExplorerPlan.id}` : undefined" class="explorer-plan-anchor" aria-hidden="true" />
        <div v-if="activeExplorerPlan" class="active-plan-banner"><span class="eyebrow">需求 {{ activeExplorerPlan.ordinal }}</span><strong>{{ taskDisplayTitle(activeExplorerPlan) }}</strong><small>{{ activeExplorerPlan.latestUserMessageSummary ?? '尚未开始探索' }}</small></div>
        <div class="timeline-day">{{ visibleTurns.length ? 'EXPLORER ACTIVITY' : 'NEW EXPLORATION' }}</div>
        <div v-if="!visibleActivity.length && !visibleInputRequests.length && !candidate && !detachedPlans.length" class="timeline-empty"><Connection :size="24" /><strong>{{ activeExplorerPlan ? taskDisplayTitle(activeExplorerPlan) : '开始一次全新的需求探索' }}</strong><span>当前需求还没有消息；切换需求不会删除其他对话内容。</span></div>
        <template v-for="(item, index) in timelineItems" :key="item.key">
          <article v-if="item.kind === 'input'" :id="inputRequestTarget(item.request)" :data-nav-key="`input:${item.request.id}`" :class="['input-request-card', 'timeline-input-request', { recovery: item.request.status === 'RECOVERY_REQUIRED', answered: item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED', cancelled: item.request.status === 'CANCELLED' }]">
            <div class="input-request-card-icon"><Check v-if="item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED'" :size="16" /><Warning v-else-if="item.request.status === 'RECOVERY_REQUIRED' || item.request.status === 'CANCELLED'" :size="16" /><InfoFilled v-else :size="16" /></div>
            <div class="input-request-card-body">
              <div class="message-meta"><strong>Plan Explorer input</strong><span :class="['agent-chip', { 'input-resolved-chip': item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED' }]">{{ inputStatusLabel(item.request) }}</span></div>
              <div class="input-request-event-times"><span><strong>问题生成</strong><time>{{ formatTurnTime(item.request.createdAt) }}</time></span><span v-if="item.request.answeredAt"><strong>回答提交</strong><time>{{ formatTurnTime(item.request.answeredAt) }}</time></span></div>
              <p v-if="item.request.status === 'SUBMITTING' || inputAnswerInFlight === item.request.id">已提交的答案正在等待 Provider 确认。刷新后会保留非敏感答案草稿，请勿重复提交。</p>
              <p v-else-if="item.request.status === 'RECOVERY_REQUIRED'">App Server 在回答确认前中断。本次回答不会自动重试，请恢复 Provider 会话后从此线程继续。</p>
              <p v-else-if="item.request.status === 'CANCELLED'">本次结构化输入已取消，问题和当时的时间点仍保留在对话记录中。</p>
              <p v-else-if="item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED'">本轮结构化问题与回答已按原始时间线保留。</p>
              <p v-else>{{ item.request.questions.length }} 个结构化问题正在等待回答，回答后本轮才能继续。</p>
              <div class="input-request-section-label">问题与回答</div>
              <div class="input-stream-questions">
                <div v-for="(question, questionIndex) in item.request.questions" :key="question.id" class="input-stream-question">
                  <span class="question-index">{{ questionIndex + 1 }}</span>
                  <div><strong>{{ question.header }}</strong><p>{{ question.question }}</p><small :class="{ answered: inputAnswerLabelsFor(item.request, question).length }">回答：{{ inputAnswerText(item.request, question) }}</small></div>
                </div>
              </div>
            </div>
            <el-button v-if="pendingInput?.id === item.request.id && inputAnswerInFlight !== item.request.id" type="primary" plain @click="openInputRequest">回答</el-button>
          </article>
          <article v-else-if="item.kind === 'plan'" :id="detachedPlanAnchorId(item.plan)" :data-nav-key="planAnchorKey(item.plan)" class="inline-plan-card plan-created-event"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">PLAN CREATED · REVISION {{ item.plan.revision }}</div><h2>{{ item.plan.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(item.plan.status) }}</el-tag></div><p class="candidate-summary">{{ item.plan.resolvedContract?.objective.goal ?? item.plan.contract?.goal ?? item.plan.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p><div class="candidate-actions"><el-button v-if="isCandidatePlan(item.plan)" @click="openPlanDetail(item.plan)">View full plan <Right :size="15" /></el-button><el-button v-if="isCandidatePlan(item.plan) && item.plan.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="isCandidatePlan(item.plan) && item.plan.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(item.plan.status) }}</span></div></article>
          <article v-else-if="item.activity.kind === 'USER_MESSAGE'" :id="activityTarget(item.activity, index)" :data-nav-key="activityTarget(item.activity, index)" :class="['message-card', 'user-message', { 'user-message-expanded': isUserMessageExpanded(item.activity.id), 'failed-message': item.activity.status === 'FAILED' }]">
            <button
              :id="`user-message-summary-${item.activity.id}`"
              class="user-message-summary"
              :class="{ expanded: isUserMessageExpanded(item.activity.id) }"
              type="button"
              :aria-expanded="isUserMessageExpanded(item.activity.id)"
              :aria-controls="`user-message-content-${item.activity.id}`"
              @click="toggleUserMessage(item.activity.id)"
            >
              <span class="user-message-summary-copy">
                <strong>{{ userMessageSummary(item.activity.summary).title }}</strong>
                <span v-if="userMessageSummary(item.activity.summary).preview" class="user-message-summary-preview">{{ userMessageSummary(item.activity.summary).preview }}</span>
              </span>
              <span class="user-message-summary-footer">
                <time>{{ formatTurnTime(item.activity.occurredAt) }}</time>
                <span class="user-message-summary-action">{{ isUserMessageExpanded(item.activity.id) ? '收起' : '展开' }}<ArrowUp v-if="isUserMessageExpanded(item.activity.id)" :size="14" /><ArrowDown v-else :size="14" /></span>
              </span>
            </button>
            <div v-if="isUserMessageExpanded(item.activity.id)" :id="`user-message-content-${item.activity.id}`" class="user-message-content">
              <div class="message-meta"><strong>{{ item.activity.title }}</strong><span>{{ formatTurnTime(item.activity.occurredAt) }}</span></div>
              <MarkdownMessage :source="item.activity.summary" />
            </div>
          </article>
          <article v-else-if="item.activity.kind === 'ASSISTANT_MESSAGE'" :id="activityTarget(item.activity, index)" :data-nav-key="activityTarget(item.activity, index)" :class="['message-card', 'assistant-message', item.activity.status === 'FAILED' ? 'failed-message' : '', item.activity.status === 'RUNNING' ? 'processing-message' : '']">
            <div class="message-avatar agent-avatar"><span :class="['brand-dot', { 'brand-dot-processing': item.activity.status === 'RUNNING' }]" /></div>
            <div class="message-body"><div class="message-meta"><strong>{{ item.activity.title }}</strong><span :class="['agent-chip', { 'processing-chip': item.activity.status === 'RUNNING' }]">{{ item.activity.status === 'RUNNING' ? 'Running' : item.activity.status === 'FAILED' ? 'Failed' : 'Read only' }}</span><span>{{ formatTurnTime(item.activity.occurredAt) }}</span></div><MarkdownMessage :source="readableAssistantText(item.activity.summary)" :streaming="item.activity.status === 'RUNNING'" /><div v-if="planForActivity(item.activity)" :id="planAnchorId(planForActivity(item.activity))" :data-nav-key="planAnchorKey(planForActivity(item.activity))" class="inline-plan-card"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">CANDIDATE PLAN · REVISION {{ planForActivity(item.activity)?.revision }}</div><h2>{{ planForActivity(item.activity)?.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(planForActivity(item.activity)?.status ?? 'DRAFT') }}</el-tag></div><p class="candidate-summary">{{ planForActivity(item.activity)?.contract?.goal ?? planForActivity(item.activity)?.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p><div class="candidate-stats"><div><span>Tasks</span><strong>{{ planForActivity(item.activity)?.contract?.tasks.length ?? planForActivity(item.activity)?.tasks?.length ?? 0 }}</strong></div><div><span>Scope entries</span><strong>{{ planForActivity(item.activity)?.contract?.include.length ?? planForActivity(item.activity)?.include?.length ?? 0 }}</strong></div><div><span>Verification</span><strong>{{ planForActivity(item.activity)?.contract?.verificationCommandIds.length ?? planForActivity(item.activity)?.verificationCommands?.length ?? 0 }} checks</strong></div><div><span>Merge</span><strong class="risk-low">Human review</strong></div></div><div class="candidate-actions"><el-button v-if="isCandidatePlan(planForActivity(item.activity))" @click="openPlanDetail(planForActivity(item.activity)!)">View full plan <Right :size="15" /></el-button><el-button v-if="isCandidatePlan(planForActivity(item.activity)) && planForActivity(item.activity)?.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="isCandidatePlan(planForActivity(item.activity)) && planForActivity(item.activity)?.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(planForActivity(item.activity)?.status ?? 'DRAFT') }}</span></div></div></div>
          </article>
          <article v-else :id="activityTarget(item.activity, index)" class="loop-activity-card" :class="{ waiting: item.activity.status === 'WAITING', failed: item.activity.status === 'FAILED' }"><div class="loop-activity-icon"><InfoFilled v-if="activityIconKind(item.activity.kind) === 'info'" :size="14" /><Check v-else-if="activityIconKind(item.activity.kind) === 'success'" :size="14" /><Warning v-else :size="14" /></div><div class="loop-activity-copy"><div class="loop-activity-meta"><strong>{{ activityKindLabel(item.activity.kind) }}</strong><span>{{ formatTurnTime(item.activity.occurredAt) }}</span><span class="agent-chip">{{ activityStatusLabel(item.activity) }}</span></div><p>{{ item.activity.summary }}</p><code v-if="typeof item.activity.details?.tool === 'string'">{{ item.activity.details.tool }}</code></div></article>
        </template>
      </div>
      <button v-if="showScrollToLatest" class="scroll-to-latest" type="button" aria-label="Scroll to latest message" title="Scroll to latest message" @click="jumpToLatest"><img class="scroll-to-latest-image" :src="scrollToLatestIcon" alt="" /></button>
      </div>
      </div>
      <div v-if="!activeRunId" class="composer"><div class="composer-input"><textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused" aria-label="Explorer message" placeholder="继续探索，或提出修改…" @keydown="handleComposerKeydown" /><span class="composer-mode">Plan Mode</span></div><div class="composer-footer"><ProviderUsageFooter :model="explorerModel" :context="contextUsage" context-note="estimated" /><span v-if="inputAnswerInFlight || inputCardRequest?.status === 'SUBMITTING'" class="composer-status" role="status" aria-live="polite">正在提交结构化答案，确认后本轮会继续…</span><span v-else-if="pendingInput" class="composer-status" role="status" aria-live="polite">请先回答上方结构化问题，再继续探索。</span><span v-else-if="sendingCurrentPlan" class="composer-status" role="status" aria-live="polite">Message sent · waiting for Plan Explorer…</span><el-button class="composer-send" type="primary" circle :loading="activePlanBusy && !activePlanWaitingForInput || sendingCurrentPlan" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || !draft.trim() || explorerPaused || activePlanBusy || sendingCurrentPlan || busy" aria-label="Send message" :title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : 'Send message'" @click="sendTurn"><ArrowUp :size="18" /></el-button></div></div>
      </template>
    </section>
        </div>
      </div>
    </el-drawer>
    <ExplorerInputDialog ref="inputDialog" v-model="inputDialogOpen" :request="pendingInput" :progress="inputProgress" @submit="submitInput" @cancel="cancelInput" @progress="updateInputProgress" />
    <ProjectCreateDialog v-model="projectCreateOpen" @project-created="handleProjectCreated" />
    <ProjectSettingsDialog :model-value="projectSettingsOpen" :project-id="projectSettingsProjectId" @update:model-value="closeProjectSettings" @saved="handleProjectSettingsSaved" />
    <ExplorerRenameDialog v-model="renameDialogOpen" :initial-title="thread?.title ?? ''" :saving="renameSaving" :error="renameError" @submit="renameThread" />
    <ExplorerPolicyDrawer :model-value="policyOpen" @update:model-value="setPolicyOpen" />
  </div>
</template>
