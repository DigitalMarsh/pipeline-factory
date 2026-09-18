<!--
  模块职责：承载 Explorer 对话、消息流、计划定位、输入请求和 SSE 生命周期。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, CircleCheck, Connection, InfoFilled, Promotion, Refresh, Right, VideoPause, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { AgentLoop, CodexRateLimitsStatus, ExplorerActivityItem, ExplorerInputRequest, ExplorerPlan, ExplorerThread, ExplorerTurn, Plan, PlanRevisionDraft, Project, Run } from "../types";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import ExplorerPolicyDrawer from "../components/ExplorerPolicyDrawer.vue";
import ThreadRail from "../components/ThreadRail.vue";
import { isTimelineAtLatest as isTimelineAtLatestPosition, scrollTimelineToLatest } from "../utils/scrollTimeline";
import { optional } from "../utils/optional";
import { closePolicyPanel, openPolicyPanel } from "../utils/policyPanel";
import { createOptimisticUserTurn, settleOptimisticTurn } from "../utils/optimisticTurn";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import { isExplorerTurnProcessing } from "../utils/turnStatus";
import { formatContextUsage, formatConversationId, formatRateLimit } from "../utils/explorerStatus";
import { createSseReplayGate } from "../utils/sseReplayGate";
import ExplorerInputDialog from "../components/ExplorerInputDialog.vue";
import MarkdownMessage from "../components/MarkdownMessage.vue";
import ProjectSettingsDialog from "../components/ProjectSettingsDialog.vue";
import ProjectCreateDialog from "../components/ProjectCreateDialog.vue";
import ExplorerRenameDialog from "../components/ExplorerRenameDialog.vue";
import PlanCenterPanel from "../components/PlanCenterPanel.vue";
import ExplorerHeaderStatus from "../components/ExplorerHeaderStatus.vue";
import RunDetailView from "./RunDetailView.vue";
import scrollToLatestIcon from "../assets/scroll-to-latest.png";
import { normalizePlanProjection } from "../utils/planProjection";
import { parsePlanProtocolDisplay } from "../utils/planProtocolDisplay";
import { planActivityBindings as buildPlanActivityBindings, planIdentity } from "../utils/planTimeline";
import { buildTaskTree, taskDisplayTitle } from "../utils/taskTree";
import type { TaskTreeItem } from "../utils/taskTree";
import { inputAnswerLabels, resolveQuestionAnswers } from "../utils/explorerInput";
import { createProjectRequestScope, projectPathForModule } from "../utils/projectRoutes";
import { buildExplorerTimeline, explorerTimelineTarget } from "../utils/explorerTimeline";
import { formatAgentLoopCompletion, formatAgentLoopGate, formatAgentLoopTerminal } from "../utils/agentLoopPresentation";
import { summarizeUserMessage } from "../utils/messageSummary";
import { parseMissingRunCommands } from "../utils/runPrerequisites";

const route = useRoute();
const router = useRouter();
// 页面状态按 Project 当前 Explorer、候选 Plan、已派发 Plan 和消息流分层保存，
// 避免切换 Project/Thread 时把旧项目的响应式数据留在当前视图。
const projectId = computed(() => String(route.params.projectId ?? ""));
const project = ref<Project | null>(null);
const projects = ref<Project[]>([]);
const thread = ref<ExplorerThread | null>(null);
const explorers = ref<ExplorerThread[]>([]);
const explorerPlans = ref<ExplorerPlan[]>([]);
const taskTreePlans = ref<Plan[]>([]);
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
const drawerOpen = ref(false);
const detailPlan = ref<Plan | null>(null);
const detailRevisions = ref<number[]>([]);
const detailLoadError = ref<string | null>(null);
const policyOpen = ref(false);
const renameDialogOpen = ref(false);
const renameSaving = ref(false);
const renameError = ref<string | null>(null);
const explorerPaused = ref(false);
type LeftPanel = "projects" | "explorers";
const leftPanel = ref<LeftPanel>("explorers");
type ContextPanel = "candidate" | "confirmed" | "enqueued" | "dispatched" | "active" | "attention" | "plan-center";
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
const sendingTurn = ref(false);
const showScrollToLatest = ref(false);
const timeline = ref<HTMLElement | null>(null);
const pendingInput = ref<ExplorerInputRequest | null>(null);
const recoveryInput = ref<ExplorerInputRequest | null>(null);
const inputRequests = ref<ExplorerInputRequest[]>([]);
type InputProgress = { requestId: string; currentIndex: number; values: Record<string, string[]>; otherValues: Record<string, string> };
const inputProgress = ref<InputProgress | null>(null);
const agentLoop = ref<AgentLoop | null>(null);
const explorerModel = ref("gpt-5.6-luna");
const statusOpen = ref(false);
const rateLimitStatus = ref<CodexRateLimitsStatus | null>(null);
const rateLimitLoading = ref(false);
const inputDialogOpen = ref(false);
const inputDialog = ref<{ onSubmitted: () => void; onFailed: (message: string) => void } | null>(null);
const mounted = ref(false);
const requestScope = createProjectRequestScope();
let eventSource: EventSource | null = null;
let loopEventSource: EventSource | null = null;
let explorerEventSequence: number | null = null;
let planProjectionVersion = 0;
let activeRequestToken = 0;
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
const contextPanelTitle = computed(() => ({ candidate: "候选方案", confirmed: "已确认方案", enqueued: "已入队方案", dispatched: "已派发方案", active: "运行中任务", attention: "待处理事项", "plan-center": "计划中心" } as const)[contextPanel.value]);
const contextPanelCount = computed(() => contextPanel.value === "candidate" ? candidateCount.value : contextPanel.value === "confirmed" ? confirmedCount.value : contextPanel.value === "enqueued" ? enqueuedCount.value : contextPanel.value === "dispatched" ? dispatchedCount.value : contextPanel.value === "active" ? activeRunCount.value : contextPanel.value === "attention" ? needsAttentionCount.value : planCenterCount.value);
const contextMenuItems = computed(() => [
  { key: "candidate" as ContextPanel, label: "候选方案", railLabel: "候选", entryClass: "context-entry-candidate", count: candidateCount.value, icon: Promotion },
  { key: "confirmed" as ContextPanel, label: "已确认方案", railLabel: "已确认", entryClass: "context-entry-confirmed", count: confirmedCount.value, icon: Check },
  { key: "enqueued" as ContextPanel, label: "已入队方案", railLabel: "已入队", entryClass: "context-entry-enqueued", count: enqueuedCount.value, icon: ArrowDown },
  { key: "dispatched" as ContextPanel, label: "已派发方案", railLabel: "已派发", entryClass: "context-entry-dispatched", count: dispatchedCount.value, icon: CircleCheck },
  { key: "active" as ContextPanel, label: "运行中任务", railLabel: "运行中", entryClass: "context-entry-active", count: activeRunCount.value, icon: Connection },
  { key: "attention" as ContextPanel, label: "待处理事项", railLabel: "待处理", entryClass: "context-entry-attention", count: needsAttentionCount.value, icon: Warning },
]);
const inputCardRequest = computed(() => pendingInput.value ?? recoveryInput.value);
const contextUsage = computed(() => formatContextUsage(turns.value));
const conversationId = computed(() => formatConversationId(thread.value?.id ?? "no-thread"));
const rateLimits = computed(() => ({ fiveHour: formatRateLimit(rateLimitStatus.value?.fiveHour ?? null), sevenDay: formatRateLimit(rateLimitStatus.value?.sevenDay ?? null) }));
const rateLimitNote = computed(() => rateLimitStatus.value?.available ? "数据来自 Codex App Server 的精确窗口。" : rateLimitStatus.value?.reason ?? "当前服务未提供 Codex 速率限制遥测。");
const agentLoopLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[agentLoop.value?.state ?? ""] ?? "No active loop");
const agentLoopGateLabel = computed(() => formatAgentLoopGate(agentLoop.value?.diagnostics));
const agentLoopTerminalLabel = computed(() => formatAgentLoopTerminal(agentLoop.value?.diagnostics));
const agentLoopCompletionLabel = computed(() => agentLoop.value ? formatAgentLoopCompletion(agentLoop.value) : null);
const activeExplorerPlan = computed(() => {
  const requested = activeExplorerPlanId.value ?? thread.value?.activeExplorerPlanId ?? explorerPlans.value[0]?.id;
  return explorerPlans.value.find((plan) => plan.id === requested) ?? explorerPlans.value[0] ?? null;
});
const explorationProgress = computed(() => activeExplorerPlan.value?.exploration ?? thread.value?.exploration ?? { status: "INCOMPLETE" as const, missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null });
const activeTimelineKey = ref("");
const activePlanKey = ref("");
const expandedUserMessageIds = ref<Set<string>>(new Set());
const expandedTaskIds = ref<Set<string>>(new Set());
function belongsToActivePlan(planId: string | null | undefined): boolean {
  const activeId = activeExplorerPlan.value?.id;
  if (!activeId) return true;
  return (planId ?? explorerPlans.value[0]?.id) === activeId;
}
const visibleTurns = computed(() => turns.value.filter((turn) => belongsToActivePlan(turn.explorerPlanId)));
const visibleActivity = computed(() => (activity.value.length ? activity.value : visibleTurns.value.map((turn) => ({ id: `fallback-${turn.id}`, explorerId: turn.threadId, turnId: turn.id, sequence: turn.sequence, kind: turn.role === "user" ? "USER_MESSAGE" : "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : turn.status === "RUNNING" ? "RUNNING" : turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED" ? "WAITING" : "COMPLETED", title: turn.role === "user" ? "You" : "Plan Explorer", summary: turn.role === "assistant" ? readableAssistantText(turnContent(turn)) : turnContent(turn), details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt, explorerPlanId: turn.explorerPlanId })) as ExplorerActivityItem[]).filter((item) => belongsToActivePlan(item.explorerPlanId)));
const visibleInputRequests = computed(() => inputRequests.value.filter((item) => belongsToActivePlan(item.explorerPlanId)));
const activePlanBusy = computed(() => visibleTurns.value.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED"));
const allPlans = computed<Plan[]>(() => {
  const unique = new Map<string, Plan>();
  for (const plan of [candidate.value, ...confirmedPlans.value, ...enqueued.value, ...dispatched.value]) if (plan) unique.set(planIdentity(plan), plan);
  return [...unique.values()];
});
const planBindings = computed(() => buildPlanActivityBindings(allPlans.value, visibleActivity.value));
const detachedPlans = computed(() => allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId) && ![...planBindings.value.values()].some((bound) => planIdentity(bound) === planIdentity(plan))));
const timelineItems = computed(() => buildExplorerTimeline(visibleActivity.value, inputRequests.value, detachedPlans.value));
const taskTreeItems = computed(() => {
  const uniquePlans = new Map<string, Plan>();
  for (const plan of [...taskTreePlans.value, ...allPlans.value]) uniquePlans.set(planIdentity(plan), plan);
  return buildTaskTree(explorerPlans.value, [...uniquePlans.values()], visibleActivity.value);
});

function setPolicyOpen(value: boolean) {
  policyOpen.value = value ? openPolicyPanel(policyOpen.value) : closePolicyPanel(policyOpen.value);
}

type ThreadActionCommand = "toggle-pause" | "rename" | "policy" | "refresh" | "new-task";

function openRenameDialog() {
  if (!thread.value) return;
  renameError.value = null;
  renameDialogOpen.value = true;
}

function handleThreadAction(command: ThreadActionCommand) {
  if (command === "new-task") {
    void createExplorerPlan();
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

function userMessageSummary(content: string) {
  return summarizeUserMessage(content);
}

function planActivityDetails(item: ExplorerActivityItem): Record<string, unknown> | null {
  return item.kind === "ASSISTANT_MESSAGE" && item.details?.planProtocol === true && item.details.status === "READY" ? item.details : null;
}

function planForActivity(item: ExplorerActivityItem): Plan | null {
  return planBindings.value.get(item.id) ?? null;
}

/** 使用 Plan 身份而不是消息起始点作为锚点，保证右侧 Plans 点击后定位到聊天中的计划卡片。 */
function planAnchorId(plan: Plan | null): string {
  return plan ? `plan-generated-${planIdentity(plan)}` : "";
}

function planAnchorKey(plan: Plan | null): string {
  return plan ? `plan-${planIdentity(plan)}` : "";
}

function detachedPlanAnchorId(plan: Plan): string {
  return `plan-created-${planIdentity(plan)}`;
}

function explorerPlanAnchorId(explorerPlanId: string): string {
  return `explorer-plan-${explorerPlanId}`;
}

function isCandidatePlan(plan: Plan | null): boolean {
  return Boolean(plan && candidate.value && planIdentity(plan) === planIdentity(candidate.value));
}

function isConversationPlan(plan: Plan | null | undefined): boolean {
  return plan?.contract?.artifactMode === "CONVERSATION" || plan?.resolvedContract?.artifact?.mode === "CONVERSATION" || plan?.generatedSpec?.artifact?.mode === "CONVERSATION";
}

function planActivityGoal(item: ExplorerActivityItem): string {
  const details = planActivityDetails(item);
  return typeof details?.goal === "string" ? details.goal : "结构化执行方案已完成校验。";
}

function planActivityCount(item: ExplorerActivityItem, key: string): number {
  const value = planActivityDetails(item)?.[key];
  return typeof value === "number" ? value : 0;
}

function setInputRequests(items: ExplorerInputRequest[]) {
  const nextPending = items.find((item) => belongsToActivePlan(item.explorerPlanId) && item.status === "OPEN") ?? null;
  if (nextPending?.id !== pendingInput.value?.id) inputProgress.value = null;
  inputRequests.value = items;
  pendingInput.value = nextPending;
  recoveryInput.value = items.find((item) => belongsToActivePlan(item.explorerPlanId) && item.status === "RECOVERY_REQUIRED") ?? null;
}

function isCurrentProjectScope(requestProjectId: string, requestToken = activeRequestToken): boolean {
  return requestScope.isCurrent(requestToken, requestProjectId) && projectId.value === requestProjectId;
}

function resetThreadState() {
  thread.value = null;
  explorerPlans.value = [];
  taskTreePlans.value = [];
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
  policyOpen.value = false;
  renameDialogOpen.value = false;
  renameError.value = null;
  renameSaving.value = false;
  inputDialogOpen.value = false;
  explorerPaused.value = false;
  activeTimelineKey.value = "";
  activePlanKey.value = "";
  expandedUserMessageIds.value = new Set();
  expandedTaskIds.value = new Set();
  busy.value = false;
  sendingTurn.value = false;
}

/** 项目切换时保留目录投影，清空旧线程数据，避免旧 SSE 或异步请求重新填充当前工作区。 */
function resetProjectState(nextProjectId = projectId.value) {
  project.value = projects.value.find((item) => item.id === nextProjectId) ?? null;
  explorers.value = [];
  projectRuns.value = [];
  showArchivedExplorers.value = false;
  resetThreadState();
}

function inputAnswerLabelsFor(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string[] {
  const progress = inputProgress.value?.requestId === request.id ? inputProgress.value : null;
  if (progress) {
    const values = resolveQuestionAnswers(question, progress.values[question.id] ?? [], progress.otherValues[question.id] ?? "");
    if (question.isSecret) return values.length ? ["已隐藏"] : [];
    return values;
  }
  return inputAnswerLabels(question, request.redactedAnswerSummary);
}

function inputAnswerText(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string {
  const labels = inputAnswerLabelsFor(request, question);
  if (labels.length) return labels.join("、");
  if (request.status === "RECOVERY_REQUIRED") return "等待恢复";
  if (request.status === "ANSWERED" || request.status === "AUTO_RESOLVED") return "已提交";
  return "尚未选择";
}

async function loadTaskTreePlans(requestProjectId: string, groups: ExplorerPlan[]): Promise<Plan[]> {
  const planIds = [...new Set(groups.map((group) => group.candidatePlanId).filter((planId): planId is string => Boolean(planId)))];
  const plans = await Promise.all(planIds.map(async (planId) => {
    try {
      return (await api.getPlan(planId)).plan;
    } catch {
      return null;
    }
  }));
  return plans.filter((plan): plan is Plan => plan !== null && plan.projectId === requestProjectId);
}

async function refreshPlanProjection(): Promise<void> {
  const explorerId = thread.value?.id;
  if (!explorerId) return;
  const requestProjectId = projectId.value;
  const requestToken = activeRequestToken;
  const requestVersion = ++planProjectionVersion;
  try {
    const [explorerResponse, planGroupsResponse, plansResponse, confirmedResponse, candidateResponse, revisionDraftResponse] = await Promise.all([
      api.explorer(requestProjectId, explorerId),
      api.explorerPlanGroups(requestProjectId, explorerId),
      api.explorerPlans(requestProjectId, explorerId),
      optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId)),
      optional(() => api.explorerCandidate(requestProjectId, explorerId)),
      optional(() => api.explorerRevisionDraft(requestProjectId, explorerId)),
    ]);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== explorerId) return;
    explorerPlans.value = planGroupsResponse.items;
    const nextTaskTreePlans = await loadTaskTreePlans(requestProjectId, explorerPlans.value);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== explorerId) return;
    taskTreePlans.value = nextTaskTreePlans;
    const routePlanId = typeof route.query.explorerPlanId === "string" ? route.query.explorerPlanId : null;
    activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === routePlanId) ? routePlanId : explorerPlans.value.some((plan) => plan.id === explorerResponse.explorer.activeExplorerPlanId) ? explorerResponse.explorer.activeExplorerPlanId ?? null : explorerPlans.value[0]?.id ?? null;
    ensureTaskExpanded(activeExplorerPlanId.value);
    const projection = normalizePlanProjection(explorerResponse.explorer, candidateResponse?.plan ?? null, plansResponse.items);
    applyPlanProjection(projection, confirmedResponse?.items ?? [], revisionDraftResponse?.draft ?? null);
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
  const activeTurn = turns.value.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED");
  busy.value = activeTurn;
  sendingTurn.value = activeTurn;
  explorerEventSequence = Math.max(explorerEventSequence ?? 0, workspace.lastEventSequence ?? 0);
  inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
  return true;
}

function planFromRevisionDraft(item: PlanRevisionDraft): Plan {
  return {
    id: item.planId,
    planId: item.planId,
    title: item.title,
    revision: item.targetRevision,
    status: "DRAFT",
    projectId: item.projectId,
    sourceExplorerThreadId: item.sourceExplorerThreadId,
    ...(item.explorerPlanId ? { explorerPlanId: item.explorerPlanId } : activeExplorerPlanId.value ? { explorerPlanId: activeExplorerPlanId.value } : {}),
    sourceTurnId: item.sourceTurnId,
    providerThreadId: item.providerThreadId,
    providerTurnId: item.providerTurnId,
    providerItemId: item.providerItemId,
    ...(item.contract ? { contract: item.contract } : {}),
    ...(item.resolvedContract ? { resolvedContract: item.resolvedContract } : {}),
    queuedAt: null,
    dispatchedAt: null,
    runId: null,
    lastEventAt: item.updatedAt,
    attentionReason: item.status === "BASE_CHANGED" ? "The default branch changed; rebase this draft before confirming." : null,
  };
}

function applyPlanProjection(projection: ReturnType<typeof normalizePlanProjection>, confirmed: Plan[], activeRevisionDraft: PlanRevisionDraft | null = null): void {
  thread.value = projection.thread;
  revisionDraft.value = activeRevisionDraft;
  candidate.value = activeRevisionDraft ? planFromRevisionDraft(activeRevisionDraft) : projection.candidate;
  confirmedPlans.value = confirmed.filter((plan) => plan.status === "READY");
  enqueued.value = projection.dispatched.filter((plan) => plan.status === "ENQUEUED");
  dispatched.value = projection.dispatched.filter((plan) => plan.dispatchedAt !== null && plan.dispatchedAt !== undefined);
}

function formatTurnTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function inputRequestTarget(request: ExplorerInputRequest): string {
  return `input-request-${request.id}`;
}

function inputStatusLabel(request: ExplorerInputRequest): string {
  return ({
    OPEN: "Waiting for answer",
    SUBMITTING: "Submitting",
    ANSWERED: "Answered",
    AUTO_RESOLVED: "Auto-resolved",
    CANCELLED: "Cancelled",
    RECOVERY_REQUIRED: "Recovery required",
  } as Record<ExplorerInputRequest["status"], string>)[request.status];
}

function explorerDisplayTitle(item: ExplorerThread | null): string {
  return item?.title || "探索线程";
}

function activityTarget(item: ExplorerActivityItem, index: number): string {
  return explorerTimelineTarget(item, index);
}

function activityStatusLabel(item: ExplorerActivityItem): string {
  if (item.status === "WAITING") return "Waiting";
  if (item.status === "FAILED") return "Failed";
  if (item.status === "RUNNING") return "Running";
  return "Completed";
}

function activityKindLabel(kind: ExplorerActivityItem["kind"]): string {
  return ({
    REASONING_SUMMARY: "Reasoning",
    INPUT_REQUIRED: "Input required",
    INPUT_RESOLVED: "Input resolved",
    TOOL_STARTED: "Tool started",
    TOOL_COMPLETED: "Tool completed",
    TOOL_DENIED: "Tool denied",
    MCP_ACTIVITY: "MCP activity",
    CONTEXT_COMPACTED: "Context checkpoint",
    GATE_CHECKED: "Gate checked",
    TURN_STATUS: "Turn status",
  } as Partial<Record<ExplorerActivityItem["kind"], string>>)[kind] ?? kind;
}

function activityIconKind(kind: ExplorerActivityItem["kind"]): "info" | "success" | "warning" {
  if (kind === "TOOL_DENIED" || kind === "GATE_CHECKED") return "warning";
  if (kind === "TOOL_COMPLETED" || kind === "INPUT_RESOLVED") return "success";
  return "info";
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
  detailPlan.value = null;
  detailRevisions.value = [];
  detailLoadError.value = null;
  drawerOpen.value = true;
  if (revisionDraft.value && planId === revisionDraft.value.planId && plan.revision === revisionDraft.value.targetRevision) {
    try {
      const history = await api.planRevisions(planId);
      if (projectId.value !== requestedProjectId || activeRequestToken !== requestToken) return;
      detailRevisions.value = history.items.map((item) => item.revision);
    } catch {
      // The current mutable draft remains usable even if historical metadata is temporarily unavailable.
    }
    detailPlan.value = planFromRevisionDraft(revisionDraft.value);
    return;
  }
  try {
    try {
      const report = await api.reconcileProjectMerges(requestedProjectId);
      const diagnostic = plan.runId ? report.items.find((item) => item.runId === plan.runId && item.reason) : undefined;
      if (diagnostic?.reason) ElMessage.warning(`Merge 状态检测：${diagnostic.reason}`);
    }
    catch (caught) { ElMessage.warning(`Merge 状态检测失败，已展示最近保存的状态：${caught instanceof Error ? caught.message : "暂不可用"}`); }
    const [response, history] = await Promise.all([api.getPlan(planId), api.planRevisions(planId)]);
    if (projectId.value !== requestedProjectId || activeRequestToken !== requestToken) return;
    const resolvedContract = response.revision?.resolvedContract ?? response.plan.resolvedContract;
    detailPlan.value = { ...response.plan, dispatch: response.dispatch, mergeRequest: response.mergeRequest, ...(resolvedContract ? { resolvedContract } : {}) };
    detailRevisions.value = history.items.map((item) => item.revision);
  } catch (caught) {
    if (projectId.value !== requestedProjectId || activeRequestToken !== requestToken) return;
    detailLoadError.value = caught instanceof Error ? `无法加载完整 Plan：${caught.message}` : "无法加载完整 Plan";
  }
}

async function selectPlanRevision(revisionNumber: number): Promise<void> {
  const current = detailPlan.value;
  const planId = current?.id ?? current?.planId;
  if (!current || !planId || current.revision === revisionNumber) return;
  try {
    const response = await api.getPlanRevision(planId, revisionNumber);
    detailPlan.value = { ...current, revision: response.revision.revision, status: "READY", ...(response.revision.contract ? { contract: response.revision.contract } : {}), ...(response.revision.resolvedContract ? { resolvedContract: response.revision.resolvedContract } : {}) };
  } catch (caught) { detailLoadError.value = caught instanceof Error ? `无法加载 V${revisionNumber}：${caught.message}` : `无法加载 V${revisionNumber}`; }
}

/** 从任何 Plan 详情回到其原始 Explorer；清理确认由服务端强制，前端只负责明确告知不可逆后果。 */
async function keepEditingPlan(plan: Plan): Promise<void> {
  const planId = plan.id ?? plan.planId;
  if (!planId || busy.value) return;
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
  if (routeContextPanel === "candidate" || routeContextPanel === "confirmed" || routeContextPanel === "enqueued" || routeContextPanel === "dispatched" || routeContextPanel === "active" || routeContextPanel === "attention" || routeContextPanel === "plan-center") contextPanel.value = routeContextPanel;
}

function panelStateQuery() {
  return { contextPanel: contextPanel.value };
}

function explorerRouteQuery(explorerId?: string, explorerPlanId?: string | null, preserveRun = false) {
  const query = { ...route.query };
  delete query.leftPanel;
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
  const query: Record<string, string | string[] | null | undefined> = { ...route.query, runId };
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

function planRunPath(plan: Plan): string | null {
  const runId = plan.runId ?? plan.dispatch?.runId;
  return runId ? runRoutePath(runId, plan.sourceExplorerThreadId, plan.explorerPlanId ?? null) : null;
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
  void router.push({ path: projectPathForModule("explore", selectedProjectId), query: { contextPanel: contextPanel.value } });
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
  if (explorerId === thread.value?.id) return;
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
  activeExplorerPlanId.value = selectedPlan.id;
  ensureTaskExpanded(selectedPlan.id);
  thread.value = { ...currentThread, activeExplorerPlanId: selectedPlan.id };
  try {
    const activation = await api.activateExplorerPlan(requestProjectId, currentThread.id, selectedPlan.id);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
    thread.value = activation.explorer;
    explorers.value = explorers.value.map((item) => item.id === currentThread.id ? activation.explorer : item);
    try {
      const planGroupsResponse = await api.explorerPlanGroups(requestProjectId, currentThread.id);
      const nextTaskTreePlans = await loadTaskTreePlans(requestProjectId, planGroupsResponse.items);
      if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
      explorerPlans.value = planGroupsResponse.items;
      taskTreePlans.value = nextTaskTreePlans;
    } catch {
      // Task workspace switching remains available when the background tree refresh is temporarily unavailable.
    }
    if (!isCurrentProjectScope(requestProjectId, requestToken) || requestVersion !== planProjectionVersion || thread.value?.id !== currentThread.id) return;
    await router.replace({ path: route.path, query: explorerRouteQuery(currentThread.id, selectedPlan.id), hash: route.hash });
    await loadActivePlanWorkspace(currentThread.id, selectedPlan.id, requestProjectId, requestToken);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== currentThread.id) return;
    if (shouldScroll) {
      await nextTick();
      jumpToTimelineTarget(explorerPlanAnchorId(selectedPlan.id), `explorer-plan-${selectedPlan.id}`);
      const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      composer?.focus();
    }
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? `Task 工作区加载失败：${caught.message}` : "Task 工作区加载失败");
  }
}

async function createExplorerPlan(): Promise<void> {
  const currentThread = thread.value;
  if (!currentThread || currentThread.state === "ARCHIVED") return;
  try {
    const response = await api.createExplorerPlan(projectId.value, currentThread.id);
    explorerPlans.value = [...explorerPlans.value, response.explorerPlan].sort((a, b) => a.ordinal - b.ordinal);
    thread.value = response.explorer;
    await selectExplorerPlan(response.explorerPlan.id, false);
    await nextTick();
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
    ElMessage.success(`${taskDisplayTitle(response.explorerPlan)} 已创建`);
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? `新建 Task 失败：${caught.message}` : "新建 Task 失败");
  }
}

function selectPlanFromCard(plan: Plan, event?: MouseEvent): void {
  const target = event?.target as HTMLElement | null;
  if (target?.closest("button, a, .el-button")) return;
  if (plan.explorerPlanId) void selectExplorerPlan(plan.explorerPlanId);
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
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  try {
    const response = await api.explorerActivity(requestProjectId, requestThreadId, activeExplorerPlan.value?.id);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
    activity.value = response.items;
    explorerEventSequence = Math.max(explorerEventSequence ?? 0, response.lastEventSequence ?? 0);
  } catch {
    // activity 投影追赶期间，以 turn stream 为消息真相来源，避免重复或丢失内容。
  }
}

async function loadRateLimits() {
  if (rateLimitLoading.value) return;
  rateLimitLoading.value = true;
  try {
    rateLimitStatus.value = (await api.codexRateLimits()).rateLimits;
  } catch {
    rateLimitStatus.value = null;
  } finally {
    rateLimitLoading.value = false;
  }
}

async function loadExplorerDetails(selected: ExplorerThread, requestProjectId: string, requestToken: number): Promise<boolean> {
  try {
    const [planGroupsResponse, plansResponse, confirmedResponse, candidateResponse, revisionDraftResponse] = await Promise.all([
      api.explorerPlanGroups(requestProjectId, selected.id),
      api.explorerPlans(requestProjectId, selected.id),
      optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id)),
      optional(() => api.explorerCandidate(requestProjectId, selected.id)),
      optional(() => api.explorerRevisionDraft(requestProjectId, selected.id)),
    ]);
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    explorerPlans.value = planGroupsResponse.items;
    const nextTaskTreePlans = await loadTaskTreePlans(requestProjectId, explorerPlans.value);
    if (!isCurrentProjectScope(requestProjectId, requestToken)) return false;
    taskTreePlans.value = nextTaskTreePlans;
    const routePlanId = typeof route.query.explorerPlanId === "string" ? route.query.explorerPlanId : null;
    activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === routePlanId) ? routePlanId : explorerPlans.value.some((plan) => plan.id === selected.activeExplorerPlanId) ? selected.activeExplorerPlanId ?? null : explorerPlans.value[0]?.id ?? null;
    ensureTaskExpanded(activeExplorerPlanId.value);
    const projection = normalizePlanProjection(selected, candidateResponse?.plan ?? null, plansResponse.items);
    applyPlanProjection(projection, confirmedResponse?.items ?? [], revisionDraftResponse?.draft ?? null);
    const workspaceLoaded = await loadActivePlanWorkspace(selected.id, activeExplorerPlanId.value, requestProjectId, requestToken);
    if (!workspaceLoaded) return false;
    if (eventSource) connectLoopEvents();
    explorerPaused.value = agentLoop.value?.state === "PAUSED";
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
async function sendTurn() {
  const content = draft.value.trim();
  if (!content || activePlanBusy.value || !thread.value || thread.value.state === "ARCHIVED" || project.value?.status === "ARCHIVED") return;
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  const now = new Date().toISOString();
  const currentPlanId = activeExplorerPlan.value?.id ?? thread.value.activeExplorerPlanId ?? undefined;
  const optimisticUser = createOptimisticUserTurn({
    id: `local-user-${Date.now()}`,
    threadId: thread.value.id,
    content,
    createdAt: now,
    sequence: turns.value.length + 1,
  });
  if (currentPlanId) optimisticUser.explorerPlanId = currentPlanId;
  turns.value = [...turns.value, optimisticUser];
  const optimisticAssistant: ExplorerActivityItem = { id: `local-assistant-activity-${Date.now()}`, explorerId: optimisticUser.threadId, turnId: `local-assistant-turn-${Date.now()}`, sequence: optimisticUser.sequence + 1, kind: "ASSISTANT_MESSAGE", status: "RUNNING", title: "Plan Explorer", summary: "Plan Explorer 正在处理…", details: null, occurredAt: new Date().toISOString(), explorerPlanId: currentPlanId };
  activity.value = [...activity.value, { id: `local-user-activity-${optimisticUser.id}`, explorerId: optimisticUser.threadId, turnId: optimisticUser.id, sequence: optimisticUser.sequence, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: content, details: null, occurredAt: now, explorerPlanId: currentPlanId }, optimisticAssistant];
  draft.value = "";
  busy.value = true;
  sendingTurn.value = true;
  await nextTick();
  if (timeline.value) scrollTimelineToLatest(timeline.value);
  try {
    const response = await api.startExplorerTurn(requestProjectId, requestThreadId, content, `client-turn-${Date.now()}`, currentPlanId);
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
    if (response.loopId) {
      const loopResponse = await api.agentLoop(response.loopId);
      if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
      agentLoop.value = loopResponse.loop;
      connectLoopEvents();
    }
    turns.value = settleOptimisticTurn(turns.value, optimisticUser.id, response.turn);
    await refreshActivity();
    if (thread.value) thread.value = { ...thread.value, messageCount: thread.value.messageCount + 2, lastActivityAt: response.turn.assistant.createdAt };
    ElMessage.success("消息已发送");
  } catch (caught) {
    if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
    const message = caught instanceof Error ? caught.message : "API 未连接";
    turns.value = [...turns.value, { id: `local-assistant-${Date.now()}`, threadId: optimisticUser.threadId, role: "assistant", content: `消息已发送，但模型回复失败：${message}`, status: "FAILED", error: message, createdAt: new Date().toISOString(), sequence: optimisticUser.sequence + 1, explorerPlanId: currentPlanId }];
    sendingTurn.value = false;
    busy.value = false;
  } finally { if (!sendingTurn.value) busy.value = false; await nextTick(); if (timeline.value) scrollTimelineToLatest(timeline.value); }
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

function updateInputProgress(progress: InputProgress) {
  inputProgress.value = progress;
}

/** 提交结构化选择；失败时保留对话框状态，允许用户修正或重试而不丢答案。 */
async function submitInput(answers: Record<string, { answers: string[] }>) {
  if (!pendingInput.value) return;
  try {
    const response = await api.answerInput(projectId.value, pendingInput.value.id, answers, `answer-${Date.now()}`);
    setInputRequests([...inputRequests.value.filter((item) => item.id !== response.request.id), response.request]);
    inputProgress.value = null;
    inputDialog.value?.onSubmitted();
    pendingInput.value = null;
    ElMessage.success("选择已提交，Plan Explorer 将继续当前回合");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "提交选择失败，请重试";
    inputDialog.value?.onFailed(message);
    ElMessage.error(message);
  }
}

async function cancelInput() {
  if (!pendingInput.value || !thread.value) return;
  try {
    await api.cancelExplorerTurn(projectId.value, thread.value.id, pendingInput.value.localTurnId, "user_cancelled");
    inputDialogOpen.value = false;
    pendingInput.value = null;
    inputProgress.value = null;
    busy.value = false;
    sendingTurn.value = false;
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
  const requestProjectId = projectId.value;
  const requestThreadId = thread.value.id;
  const requestToken = activeRequestToken;
  const response = await api.getExplorerTurns(requestProjectId, requestThreadId, activeExplorerPlan.value?.id);
  if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
  turns.value = response.items;
  await refreshActivity();
  await refreshPlanProjection();
  const inputResponse = await api.inputRequests(requestProjectId, requestThreadId, undefined, activeExplorerPlan.value?.id);
  if (!isCurrentProjectScope(requestProjectId, requestToken) || thread.value?.id !== requestThreadId) return;
  setInputRequests(inputResponse.items);
  const activeTurn = response.items.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED");
  if (!pendingInput.value) { inputDialogOpen.value = false; busy.value = activeTurn; sendingTurn.value = activeTurn; }
  await nextTick();
  if (timeline.value) scrollTimelineToLatest(timeline.value);
}

function connectEvents() {
  if (!thread.value || typeof EventSource === "undefined") return;
  const connectionProjectId = projectId.value;
  const connectionThreadId = thread.value.id;
  const connectionToken = activeRequestToken;
  const isConnectionCurrent = () => isCurrentProjectScope(connectionProjectId, connectionToken) && thread.value?.id === connectionThreadId;
  eventSource?.close();
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  if (explorerEventSequence !== null) replayGate.markReady();
  eventSource = new EventSource(api.explorerEventsUrl(connectionProjectId, connectionThreadId, explorerEventSequence ?? undefined));
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
    void refreshActivity();
    void refreshPlanProjection();
  });
  eventSource.addEventListener("turn.input_required", async (raw) => {
    if (!isConnectionCurrent() || !replayGate.accept("turn.input_required")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { requestId: string };
    const response = await api.inputRequests(connectionProjectId, connectionThreadId, undefined, activeExplorerPlan.value?.id);
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
    loopEventSource.addEventListener(eventName, () => {
      if (!isCurrentProjectScope(connectionProjectId, connectionToken) || thread.value?.id !== connectionThreadId || !replayGate.accept(eventName)) return;
      void api.agentLoop(loopId).then(async (response) => {
        if (!isCurrentProjectScope(connectionProjectId, connectionToken) || thread.value?.id !== connectionThreadId || agentLoop.value?.id !== loopId) return;
        agentLoop.value = response.loop;
        explorerPaused.value = response.loop.state === "PAUSED";
        await refreshActivity();
        if (["agent.step.gate_checked", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required"].includes(eventName)) await refreshPlanProjection();
      }).catch(() => undefined);
    });
  }
}

function closeEvents() { eventSource?.close(); loopEventSource?.close(); eventSource = null; loopEventSource = null; }

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
      await api.confirmRevisionDraft(id, activeDraft.draftId);
      drawerOpen.value = false;
      await refreshPlanProjection();
      contextPanel.value = "confirmed";
      ElMessage.success(`Revision ${activeDraft.targetRevision} confirmed`);
    } catch (caught) { error.value = caught instanceof Error ? `Confirm revision failed: ${caught.message}` : "Confirm revision failed"; }
    finally { busy.value = false; }
    return;
  }
  busy.value = true;
  try {
    await api.confirmPlan(id);
    candidate.value = null;
    drawerOpen.value = false;
    await refreshPlanProjection();
    if (contextPanel.value === "candidate") contextPanel.value = "confirmed";
  } catch (caught) { error.value = caught instanceof Error ? `Confirm plan 失败：${caught.message}` : "Confirm plan 失败"; } finally { busy.value = false; }
}

async function enqueuePlan(plan: Plan | null = candidate.value) {
  if (!plan || plan.status !== "READY" || busy.value) return;
  const id = plan.id ?? plan.planId;
  if (!id) return;
  busy.value = true;
  try {
    const enqueuedPlan = (await (plan.revision > 1 ? api.enqueuePlanRevision(id, plan.revision) : api.enqueuePlan(id))).plan;
    enqueued.value = [enqueuedPlan, ...enqueued.value.filter((item) => planIdentity(item) !== planIdentity(enqueuedPlan))];
    candidate.value = null;
    drawerOpen.value = false;
    await refreshPlanProjection();
    contextPanel.value = "enqueued";
    ElMessage.success("Plan 已进入 Enqueued 阶段");
  } catch (caught) {
    error.value = caught instanceof Error ? `Enqueue plan 失败：${caught.message}` : "Enqueue plan 失败";
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
    contextPanel.value = "dispatched";
    ElMessage.success(result.dispatch?.waitReason ? `Plan 已派发，正在等待：${result.dispatch.waitReason}` : "Plan 已进入 Dispatched 阶段");
  } catch (caught) {
    error.value = caught instanceof Error ? `Start run 失败：${caught.message}` : "Start run 失败";
    ElMessage.error(error.value);
  } finally {
    busy.value = false;
  }
}

function configurationBlockedCommands(plan: Plan): string[] {
  if (plan.dispatch?.waitReason !== "NEEDS_CONFIGURATION") return [];
  return parseMissingRunCommands(plan.dispatch.lastError ?? "");
}

function canCreateConfigurationRevision(plan: Plan): boolean {
  const missingCommands = configurationBlockedCommands(plan);
  if (!missingCommands.length || !project.value) return false;
  const registered = new Set(project.value.settings.commands.map((command) => command.commandId));
  return missingCommands.every((commandId) => registered.has(commandId));
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

function statusLabel(status: string) { return ({ DRAFT: "Candidate", DISCARDED: "Discarded", READY: "Confirmed", ENQUEUED: "Enqueued", DISPATCHED: "Dispatched", QUEUED: "Queued", STARTING: "Starting", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Ready for review", MERGED: "Merged", NEEDS_PLAN_CHANGE: "Plan change required", BLOCKED: "Blocked" } as Record<string, string>)[status] ?? status; }
function ensureTaskExpanded(taskId: string | null): void {
  if (!taskId || expandedTaskIds.value.has(taskId)) return;
  expandedTaskIds.value = new Set([...expandedTaskIds.value, taskId]);
}

function isTaskExpanded(taskId: string): boolean {
  return expandedTaskIds.value.has(taskId);
}

function toggleTaskExpanded(taskId: string): void {
  const next = new Set(expandedTaskIds.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  expandedTaskIds.value = next;
}

async function selectPlanTreeItem(item: TaskTreeItem): Promise<void> {
  if (activeRunId.value) await closeRunView();
  if (activeExplorerPlan.value?.id !== item.task.id) await selectExplorerPlan(item.task.id, false);
  await nextTick();
  const current = taskTreeItems.value.find((candidate) => candidate.task.id === item.task.id);
  if (current?.planTarget) jumpToTimelineTarget(current.planTarget, current.planKey ?? "");
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
watch(() => route.query.explorerId, (routeExplorerId, previousExplorerId) => {
  if (!mounted.value || routeExplorerId === previousExplorerId || routeExplorerId === thread.value?.id) return;
  void reloadSelectedExplorer();
});
watch(() => route.query.explorerPlanId, (routePlanId, previousPlanId) => {
  if (!mounted.value || routePlanId === previousPlanId || !thread.value || typeof routePlanId !== "string" || routePlanId === activeExplorerPlan.value?.id) return;
  void selectExplorerPlan(routePlanId, true);
});
onMounted(() => { mounted.value = true; syncPanelStateFromRoute(); void load().then((loaded) => { if (loaded) connectEvents(); }); syncHashPanel(route.hash); });
onBeforeUnmount(() => { mounted.value = false; requestScope.invalidate(); closeEvents(); });
</script>

<template>
  <div class="console-layout">
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
      :plan-center-active="contextPanel === 'plan-center'"
      :plan-center-count="planCenterCount"
      :task-tree-items="taskTreeItems"
      :active-explorer-plan-id="activeExplorerPlan?.id ?? null"
      :expanded-task-ids="[...expandedTaskIds]"
      :explorer-paused="explorerPaused"
      @select-panel="leftPanel = $event"
      @select-plan-center="selectContextPanel('plan-center')"
      @create-explorer="createExplorer"
      @create-project="openProjectCreateDialog"
      @select-project="switchProject"
      @open-project="switchProject"
      @open-project-settings="openProjectSettingsDialog"
      @archive-project="toggleProjectArchive"
      @select-explorer="selectExplorer"
      @toggle-show-archived="showArchivedExplorers = $event"
      @archive-explorer="toggleExplorerArchive"
      @select-explorer-plan="selectExplorerPlan($event)"
      @toggle-task-expanded="toggleTaskExpanded"
      @select-plan-tree-item="selectPlanTreeItem"
      @thread-action="handleThreadAction"
    />
    <section class="conversation-column">
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
      <RunDetailView v-if="activeRunId" :key="activeRunId" embedded :project-id="projectId" :run-id="activeRunId" @close="closeRunView" />
      <div v-if="!activeRunId" class="timeline-stage">
      <div class="timeline-shell">
      <div ref="timeline" class="timeline" v-loading="loading" @scroll="updateTimelineScrollState">
        <div :id="activeExplorerPlan ? explorerPlanAnchorId(activeExplorerPlan.id) : undefined" :data-nav-key="activeExplorerPlan ? `explorer-plan-${activeExplorerPlan.id}` : undefined" class="explorer-plan-anchor" aria-hidden="true" />
        <div v-if="activeExplorerPlan" class="active-plan-banner"><span class="eyebrow">TASK {{ activeExplorerPlan.ordinal }}</span><strong>{{ taskDisplayTitle(activeExplorerPlan) }}</strong><small>{{ activeExplorerPlan.latestUserMessageSummary ?? '尚未开始探索' }}</small></div>
        <div class="timeline-day">{{ visibleTurns.length ? 'EXPLORER ACTIVITY' : 'NEW EXPLORATION' }}</div>
        <div v-if="!visibleActivity.length && !visibleInputRequests.length && !candidate && !detachedPlans.length" class="timeline-empty"><Connection :size="24" /><strong>{{ activeExplorerPlan ? taskDisplayTitle(activeExplorerPlan) : '开始一次全新的需求探索' }}</strong><span>当前 Task 还没有消息；切换 Task 不会删除其他分区内容。</span></div>
        <template v-for="(item, index) in timelineItems" :key="item.key">
          <article v-if="item.kind === 'input'" :id="inputRequestTarget(item.request)" :data-nav-key="`input:${item.request.id}`" :class="['input-request-card', 'timeline-input-request', { recovery: item.request.status === 'RECOVERY_REQUIRED', answered: item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED', cancelled: item.request.status === 'CANCELLED' }]">
            <div class="input-request-card-icon"><Check v-if="item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED'" :size="16" /><Warning v-else-if="item.request.status === 'RECOVERY_REQUIRED' || item.request.status === 'CANCELLED'" :size="16" /><InfoFilled v-else :size="16" /></div>
            <div class="input-request-card-body">
              <div class="message-meta"><strong>Plan Explorer input</strong><span :class="['agent-chip', { 'input-resolved-chip': item.request.status === 'ANSWERED' || item.request.status === 'AUTO_RESOLVED' }]">{{ inputStatusLabel(item.request) }}</span></div>
              <div class="input-request-event-times"><span><strong>问题生成</strong><time>{{ formatTurnTime(item.request.createdAt) }}</time></span><span v-if="item.request.answeredAt"><strong>回答提交</strong><time>{{ formatTurnTime(item.request.answeredAt) }}</time></span></div>
              <p v-if="item.request.status === 'RECOVERY_REQUIRED'">App Server 在回答确认前中断。本次回答不会自动重试，请恢复 Provider 会话后从此线程继续。</p>
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
            <el-button v-if="pendingInput?.id === item.request.id" type="primary" plain @click="openInputRequest">回答</el-button>
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
      <div v-if="!activeRunId" class="composer"><div class="composer-input"><textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused" aria-label="Explorer message" placeholder="继续探索，或提出修改…" @keydown="handleComposerKeydown" /><span class="composer-mode">Plan Mode</span></div><div class="composer-footer"><div class="composer-metadata" aria-label="模型与上下文信息"><span class="composer-fact"><small>MODEL</small><strong>{{ explorerModel }}</strong></span><span class="composer-fact"><small>CONTEXT</small><strong>{{ contextUsage }}</strong><em>estimated</em></span><el-popover v-model:visible="statusOpen" placement="top-end" :width="330" trigger="click" @show="void loadRateLimits()"><template #reference><button class="composer-status-trigger" type="button" aria-label="Status" :aria-expanded="statusOpen"><i aria-hidden="true" /><span>STATUS</span><InfoFilled :size="12" /></button></template><div class="codex-status-popover" role="dialog" aria-label="Codex usage status"><div class="codex-status-title"><InfoFilled :size="14" /><strong>状态</strong><button type="button" aria-label="关闭" @click="statusOpen = false">关闭</button></div><div class="codex-status-row"><span>模型：</span><strong>{{ explorerModel }}</strong></div><div class="codex-status-row"><span>会话/对话串：</span><code :title="thread?.id ?? 'no-thread'">{{ conversationId }}</code></div><div class="codex-status-row"><span>背景信息：</span><strong>{{ contextUsage }}</strong><em>estimated</em></div><div class="codex-status-row"><span>5 小时限额：</span><strong>{{ rateLimits.fiveHour.remaining }}</strong><small>{{ rateLimits.fiveHour.reset }}</small></div><div class="codex-status-row"><span>7 天限额：</span><strong>{{ rateLimits.sevenDay.remaining }}</strong><small>{{ rateLimits.sevenDay.reset }}</small></div><p class="codex-status-note">{{ rateLimitNote }}</p></div></el-popover></div><span v-if="sendingTurn" class="composer-status" role="status" aria-live="polite">Message sent · waiting for Plan Explorer…</span><el-button class="composer-send" type="primary" circle :loading="busy" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || !draft.trim() || explorerPaused || busy" aria-label="Send message" :title="busy ? '当前回合执行中，完成后可发送' : 'Send message'" @click="sendTurn"><ArrowUp :size="18" /></el-button></div></div>
    </section>
    <aside class="context-panel-shell">
      <div class="context-panel">
      <div class="context-header"><div class="context-header-title"><div class="context-header-title-row"><h2 id="context-panel-title">{{ contextPanelTitle }}</h2><span class="context-header-count" :aria-label="`${contextPanelTitle}: ${contextPanelCount}`">{{ contextPanelCount }}</span></div></div><el-button text circle aria-label="Refresh" @click="refreshThread"><Refresh :size="16" /></el-button></div>
      <div class="context-panel-scroll">
        <section v-if="contextPanel === 'candidate'" class="context-panel-content" aria-labelledby="context-panel-title">
          <article v-if="candidate" class="context-plan-card context-plan-card-clickable" @click="selectPlanFromCard(candidate, $event)"><div class="context-plan-card-head"><div class="mini-plan-title"><span class="mini-icon"><Promotion :size="16" /></span><div><strong>{{ candidate.title }}</strong><small>Revision {{ candidate.revision }}<template v-if="isConversationPlan(candidate)"> · Conversation review only</template></small></div></div><el-tag size="small" type="warning" effect="light">{{ revisionDraft ? revisionDraft.status : statusLabel(candidate.status) }}</el-tag></div><div class="context-plan-goal"><span>GOAL</span><p>{{ candidate.contract?.goal ?? candidate.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p></div><div class="candidate-actions"><el-button @click.stop="openPlanDetail(candidate)">View full plan <Right :size="15" /></el-button><el-button v-if="!revisionDraft && candidate.status === 'DRAFT'" type="primary" :loading="busy" @click.stop="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="revisionDraft?.status === 'READY_TO_CONFIRM'" type="primary" :loading="busy" @click.stop="confirmPlan">Confirm V{{ revisionDraft.targetRevision }} <Check :size="15" /></el-button><span v-else-if="revisionDraft" class="confirmed-note">{{ revisionDraft.status === 'BASE_CHANGED' ? 'Rebase required before confirmation' : 'Continue exploring to complete this revision' }}</span></div></article>
          <div v-else class="context-empty"><CircleCheck :size="24" /><p>No candidate plan</p><small>Continue exploring. A reviewable candidate appears here when this ExplorerThread produces a plan.</small></div>
        </section>
        <section v-else-if="contextPanel === 'confirmed'" class="context-panel-content" aria-labelledby="context-panel-title">
          <div v-if="confirmedPlans.length" class="context-plan-list" role="list"><article v-for="plan in confirmedPlans" :key="plan.planId ?? plan.id ?? plan.title" class="context-plan-row confirmed-plan-row context-plan-row-clickable" role="listitem" @click="selectPlanFromCard(plan, $event)"><div class="context-plan-row-head"><div class="mini-plan-title"><span class="mini-icon success"><Check :size="16" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Revision {{ plan.revision }}</small></div></div><el-tag size="small" type="success" effect="light">{{ statusLabel(plan.status) }}</el-tag></div><div class="context-plan-row-meta"><span>Source thread</span><code>{{ plan.sourceExplorerThreadId }}</code></div><div class="context-plan-row-meta"><span>Run</span><span class="context-plan-muted">{{ isConversationPlan(plan) ? 'Conversation artifact · review only' : 'Ready to enqueue' }}</span></div><div class="context-plan-row-footer"><span class="event-time">Last event {{ planEventTime(plan.lastEventAt) }}</span><div class="context-plan-actions"><el-button size="small" plain @click.stop="openPlanDetail(plan)">View full plan</el-button><el-button v-if="plan.status === 'READY' && !isConversationPlan(plan)" size="small" type="primary" :loading="busy" @click.stop="enqueuePlan(plan)">Enqueue plan <ArrowDown :size="14" /></el-button></div></div></article></div>
          <div v-else class="context-empty"><Check :size="24" /><p>No confirmed plans</p><small>Plans appear here after you confirm them. Enqueue remains a separate step.</small></div>
        </section>
        <section v-else-if="contextPanel === 'enqueued'" class="context-panel-content" aria-labelledby="context-panel-title">
          <div v-if="enqueued.length" class="context-plan-list" role="list"><article v-for="plan in enqueued" :key="plan.planId ?? plan.id ?? plan.title" class="context-plan-row enqueued-plan-row context-plan-row-clickable" role="listitem" @click="selectPlanFromCard(plan, $event)"><div class="context-plan-row-head"><div class="mini-plan-title"><span class="mini-icon"><ArrowDown :size="16" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Revision {{ plan.revision }}</small></div></div><el-tag size="small" type="warning" effect="light">{{ statusLabel(plan.status) }}</el-tag></div><div class="context-plan-row-meta"><span>Source thread</span><code>{{ plan.sourceExplorerThreadId }}</code></div><div class="context-plan-row-meta"><span>Run</span><span class="context-plan-muted">Ready for manual start</span></div><div class="context-plan-row-footer"><span class="event-time">Enqueued {{ planEventTime(plan.queuedAt ?? plan.lastEventAt) }}</span><div class="context-plan-actions"><el-button size="small" plain @click.stop="openPlanDetail(plan)">View full plan</el-button><el-button v-if="plan.status === 'ENQUEUED'" size="small" type="primary" :loading="busy" @click.stop="startPlanRun(plan)">Start run <Right :size="14" /></el-button></div></div></article></div>
          <div v-else class="context-empty"><ArrowDown :size="24" /><p>No enqueued plans</p><small>Use Enqueue in Confirmed, then explicitly Start run here.</small></div>
        </section>
        <section v-else-if="contextPanel === 'dispatched'" class="context-panel-content" aria-labelledby="context-panel-title">
          <div v-if="dispatched.length" class="context-plan-list" role="list"><article v-for="plan in dispatched" :key="plan.planId ?? plan.id ?? plan.title" class="context-plan-row context-plan-row-clickable" role="listitem" @click="selectPlanFromCard(plan, $event)"><div class="context-plan-row-head"><div class="mini-plan-title"><span class="mini-icon success"><CircleCheck :size="16" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Revision {{ plan.revision }}</small></div></div><el-tag size="small" :type="plan.status === 'MERGED' ? 'success' : plan.status === 'BLOCKED' || plan.status === 'NEEDS_PLAN_CHANGE' ? 'danger' : plan.status === 'IN_PROGRESS' || plan.status === 'VERIFYING' ? 'primary' : 'warning'" effect="light">{{ statusLabel(plan.status) }}</el-tag></div><div class="context-plan-row-meta"><span>Run</span><RouterLink v-if="planRunPath(plan)" :to="planRunPath(plan)!" class="context-plan-link" @click.stop>{{ plan.runId }} <Right :size="13" /></RouterLink><span v-else class="context-plan-muted">{{ plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION' ? 'Needs configuration' : plan.dispatch?.waitReason ?? 'Waiting for scheduler' }}</span></div><div v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" class="context-configuration-notice">Missing verification commands: {{ configurationBlockedCommands(plan).join(', ') }}</div><div class="context-plan-row-meta"><span>State</span><span class="context-plan-muted">{{ plan.status === 'DISPATCHED' ? 'Waiting for run' : statusLabel(plan.status) }}</span></div><div class="context-plan-row-footer"><span class="event-time">Dispatched {{ planEventTime(plan.dispatchedAt ?? plan.lastEventAt) }}</span><div class="context-plan-actions"><el-button size="small" plain @click.stop="openPlanDetail(plan)">View full plan</el-button><template v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'"><el-button size="small" plain @click.stop="openProjectSettingsDialog(plan.projectId)">Configure verification commands</el-button><el-button v-if="canCreateConfigurationRevision(plan)" size="small" type="primary" :loading="busy" @click.stop="revisePlanConfiguration(plan)">Create updated revision</el-button></template><RouterLink v-else-if="planRunPath(plan)" :to="planRunPath(plan)!" class="context-plan-link" @click.stop>View run <Right :size="13" /></RouterLink></div></div></article></div>
          <div v-else class="context-empty"><CircleCheck :size="24" /><p>No plans dispatched from this thread yet.</p><small>Start run moves an Enqueued plan here and retains its execution history.</small><el-button text @click="contextPanel = 'enqueued'">View Enqueued <Right :size="14" /></el-button></div>
        </section>
        <section v-else-if="contextPanel === 'active'" class="context-panel-content" aria-labelledby="context-panel-title"><div v-if="activeRuns.length" class="context-plan-list" role="list"><article v-for="run in activeRuns" :key="run.id" class="context-plan-row active-run-row" role="listitem"><div class="context-plan-row-head"><div class="mini-plan-title"><span class="mini-icon"><Connection :size="16" /></span><div><strong>Run {{ run.id }}</strong><small>Plan {{ run.planId }} · Revision {{ run.planRevision }}</small></div></div><el-tag size="small" type="primary" effect="light">{{ statusLabel(run.status) }}</el-tag></div><div class="context-plan-row-meta"><span>State</span><span class="context-plan-muted">{{ statusLabel(run.status) }}</span></div><div class="context-plan-row-footer"><span class="event-time">{{ run.startedAt ? `Started ${planEventTime(run.startedAt)}` : `Created ${planEventTime(run.createdAt)}` }}</span><button type="button" class="context-plan-link context-plan-link-button" @click="void openProjectRun(run)">Open run <Right :size="13" /></button></div></article></div><div v-else class="context-empty"><Connection :size="24" /><p>No active runs</p><small>Starting, running, and verifying runs across this project appear here.</small></div></section>
         <section v-else-if="contextPanel === 'attention'" class="context-panel-content" aria-labelledby="context-panel-title"><div v-if="attentionPlans.length" class="context-plan-list" role="list"><article v-for="plan in attentionPlans" :key="plan.planId ?? plan.id ?? plan.title" class="context-plan-row attention-row" role="listitem" @click="selectPlanFromCard(plan, $event)"><div class="context-plan-row-head"><div class="mini-plan-title"><span class="mini-icon warning"><Warning :size="16" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Revision {{ plan.revision }}</small></div></div><el-tag size="small" type="danger" effect="light">{{ statusLabel(plan.status) }}</el-tag></div><div class="context-plan-row-meta"><span>Reason</span><span class="context-attention-reason">{{ plan.attentionReason ?? 'This plan requires review before execution can continue.' }}</span></div><div class="context-plan-row-footer"><span class="event-time">Last event {{ planEventTime(plan.lastEventAt) }}</span><div class="context-plan-actions"><el-button size="small" plain @click.stop="openPlanDetail(plan)">View full plan</el-button><RouterLink v-if="planRunPath(plan)" :to="planRunPath(plan)!" class="context-plan-link">Open run <Right :size="13" /></RouterLink></div></div></article></div><div v-else class="context-empty"><Warning :size="24" /><p>No items need attention</p><small>Blocked, terminated, and plan-change-required dispatched plans appear here.</small></div></section>
        <section v-else-if="contextPanel === 'plan-center'" class="context-panel-content" aria-label="计划中心"><PlanCenterPanel :project-id="projectId" :project="project" @plans-changed="refreshPlanProjection" @configuration-revised="handlePlanCenterConfigurationRevised" @configure-commands="openProjectSettingsDialog" @view-plan="openPlanDetail" @open-run="openPlanRun" @count="planCenterCount = $event" /></section>
      </div>
      </div>
      <nav class="context-entry-rail" role="tablist" aria-label="上下文分区">
        <button v-for="item in contextMenuItems" :key="item.key" type="button" :class="['context-entry-button', item.entryClass, { active: contextPanel === item.key }]" role="tab" :data-context="item.key" :aria-pressed="contextPanel === item.key" :aria-selected="contextPanel === item.key" :aria-label="item.label" @click="selectContextPanel(item.key)">
          <span class="context-entry-icon"><component :is="item.icon" :size="17" /></span>
          <span class="context-entry-label">{{ item.railLabel }}</span>
          <span class="context-entry-count">{{ item.count }}</span>
        </button>
      </nav>
    </aside>
  <PlanDetailDrawer v-model="drawerOpen" :plan="detailPlan" :error="detailLoadError" :revisions="detailRevisions" :revision-draft-status="revisionDraft?.status ?? null" @confirm="confirmPlan" @discard="discardPlan" @keep-editing="keepEditingPlan" @select-revision="selectPlanRevision" />
    <ExplorerInputDialog ref="inputDialog" v-model="inputDialogOpen" :request="pendingInput" @submit="submitInput" @cancel="cancelInput" @progress="updateInputProgress" />
    <ProjectCreateDialog v-model="projectCreateOpen" @project-created="handleProjectCreated" />
    <ProjectSettingsDialog :model-value="projectSettingsOpen" :project-id="projectSettingsProjectId" @update:model-value="closeProjectSettings" @saved="handleProjectSettingsSaved" />
    <ExplorerRenameDialog v-model="renameDialogOpen" :initial-title="thread?.title ?? ''" :saving="renameSaving" :error="renameError" @submit="renameThread" />
    <ExplorerPolicyDrawer :model-value="policyOpen" @update:model-value="setPolicyOpen" />
  </div>
</template>
