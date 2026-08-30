<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, CircleCheck, Connection, InfoFilled, MoreFilled, Promotion, Refresh, Right, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { AgentLoop, CodexRateLimitsStatus, ExplorerActivityItem, ExplorerInputRequest, ExplorerThread, ExplorerTurn, Plan, Project } from "../types";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import ExplorerPolicyDrawer from "../components/ExplorerPolicyDrawer.vue";
import ThreadRail from "../components/ThreadRail.vue";
import { isTimelineAtLatest as isTimelineAtLatestPosition, scrollTimelineToLatest } from "../utils/scrollTimeline";
import { optional } from "../utils/optional";
import { closePolicyPanel, openPolicyPanel } from "../utils/policyPanel";
import { createOptimisticUserTurn, settleOptimisticTurn } from "../utils/optimisticTurn";
import { useDismissibleNotice } from "../utils/dismissibleNotice";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import { isExplorerTurnProcessing } from "../utils/turnStatus";
import { formatContextUsage, formatConversationId, formatRateLimit } from "../utils/explorerStatus";
import { createSseReplayGate } from "../utils/sseReplayGate";
import ExplorerInputDialog from "../components/ExplorerInputDialog.vue";
import ExplorerHistoryDrawer from "../components/ExplorerHistoryDrawer.vue";
import scrollToLatestIcon from "../assets/scroll-to-latest.png";
import { normalizePlanProjection } from "../utils/planProjection";
import { parsePlanProtocolDisplay } from "../utils/planProtocolDisplay";
import { findPlanForActivity, planIdentity, planTimelineItems as buildPlanTimelineItems } from "../utils/planTimeline";
import { inputAnswerLabels, resolveQuestionAnswers } from "../utils/explorerInput";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? ""));
const project = ref<Project | null>(null);
const thread = ref<ExplorerThread | null>(null);
const explorers = ref<ExplorerThread[]>([]);
const historyOpen = ref(false);
const activity = ref<ExplorerActivityItem[]>([]);
const candidate = ref<Plan | null>(null);
const dispatched = ref<Plan[]>([]);
const turns = ref<ExplorerTurn[]>([]);
const draft = ref("");
const drawerOpen = ref(false);
const policyOpen = ref(false);
const moreOpen = ref(false);
const explorerPaused = ref(false);
const memoryPanel = ref<"summary" | "successors" | null>(null);
const candidateEmptyOpen = ref(false);
const candidateTitle = ref("New Explorer plan");
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref(false);
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
let eventSource: EventSource | null = null;
let loopEventSource: EventSource | null = null;
let explorerEventSequence: number | null = null;
let planProjectionVersion = 0;
const { visible: showThreadBanner, dismiss: dismissThreadBanner } = useDismissibleNotice();
type TimelineNavItem = { key: string; label: string; detail: string; target: string };

const candidateCount = computed(() => candidate.value ? 1 : 0);
const dispatchedCount = computed(() => dispatched.value.length);
const activeRunCount = computed(() => dispatched.value.filter((plan) => plan.status === "IN_PROGRESS" || plan.status === "VERIFYING").length);
const needsAttentionCount = computed(() => dispatched.value.filter((plan) => plan.status === "BLOCKED" || Boolean(plan.attentionReason)).length);
const inputCardRequest = computed(() => pendingInput.value ?? recoveryInput.value);
const contextUsage = computed(() => formatContextUsage(turns.value));
const conversationId = computed(() => formatConversationId(thread.value?.id ?? "no-thread"));
const rateLimits = computed(() => ({ fiveHour: formatRateLimit(rateLimitStatus.value?.fiveHour ?? null), sevenDay: formatRateLimit(rateLimitStatus.value?.sevenDay ?? null) }));
const rateLimitNote = computed(() => rateLimitStatus.value?.available ? "数据来自 Codex App Server 的精确窗口。" : rateLimitStatus.value?.reason ?? "当前服务未提供 Codex 速率限制遥测。");
const agentLoopLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[agentLoop.value?.state ?? ""] ?? "No active loop");
const explorationProgress = computed(() => thread.value?.exploration ?? { status: "INCOMPLETE" as const, missing: [], completed: [], candidatePlanId: null, lastAssessedTurnId: null });
const activeTimelineKey = ref("");
const activePlanKey = ref("");
const messageTimelineItems = computed<TimelineNavItem[]>(() => [
  ...(inputCardRequest.value ? [{ key: "message-input-request", label: "Input required", detail: inputCardRequest.value.status === "RECOVERY_REQUIRED" ? "Recovery" : "Waiting", target: "message-input-request" }] : []),
  ...turns.value.map((turn) => ({ key: `message-${turn.id}`, label: turn.role === "user" ? "You" : "Plan Explorer", detail: formatTurnTime(turn.createdAt), target: `message-${turn.id}` })),
]);
const visibleActivity = computed(() => activity.value.length ? activity.value : turns.value.map((turn) => ({ id: `fallback-${turn.id}`, explorerId: turn.threadId, turnId: turn.id, sequence: turn.sequence, kind: turn.role === "user" ? "USER_MESSAGE" : "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : turn.status === "RUNNING" ? "RUNNING" : turn.status === "WAITING_FOR_INPUT" ? "WAITING" : "COMPLETED", title: turn.role === "user" ? "You" : "Plan Explorer", summary: turn.role === "assistant" ? readableAssistantText(turnContent(turn)) : turnContent(turn), details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt })) as ExplorerActivityItem[]);
const allPlans = computed<Plan[]>(() => {
  const unique = new Map<string, Plan>();
  for (const plan of [candidate.value, ...dispatched.value]) if (plan) unique.set(planIdentity(plan), plan);
  return [...unique.values()];
});
const planTimelineItems = computed(() => buildPlanTimelineItems(allPlans.value, visibleActivity.value));
const syntheticPlanItems = computed(() => planTimelineItems.value.filter((item) => item.target.startsWith("plan-created-")));
const answeredInputRequests = computed(() => inputRequests.value.filter((request) => request.status === "ANSWERED" || request.status === "AUTO_RESOLVED").sort((a, b) => a.createdAt.localeCompare(b.createdAt)));

function setPolicyOpen(value: boolean) {
  policyOpen.value = value ? openPolicyPanel(policyOpen.value) : closePolicyPanel(policyOpen.value);
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

function planActivityDetails(item: ExplorerActivityItem): Record<string, unknown> | null {
  return item.kind === "ASSISTANT_MESSAGE" && item.details?.planProtocol === true && item.details.status === "READY" ? item.details : null;
}

function planForActivity(item: ExplorerActivityItem): Plan | null {
  return findPlanForActivity(item, allPlans.value);
}

function planAnchorId(plan: Plan | null): string {
  return plan ? `plan-generated-${planIdentity(plan)}` : "";
}

function planAnchorKey(plan: Plan | null): string {
  return plan ? `plan-${planIdentity(plan)}` : "";
}

function isCandidatePlan(plan: Plan | null): boolean {
  return Boolean(plan && candidate.value && planIdentity(plan) === planIdentity(candidate.value));
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
  const nextPending = items.find((item) => item.status === "OPEN") ?? null;
  if (nextPending?.id !== pendingInput.value?.id) inputProgress.value = null;
  inputRequests.value = items;
  pendingInput.value = nextPending;
  recoveryInput.value = items.find((item) => item.status === "RECOVERY_REQUIRED") ?? null;
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

async function refreshPlanProjection(): Promise<void> {
  const explorerId = thread.value?.id;
  if (!explorerId) return;
  const requestVersion = ++planProjectionVersion;
  try {
    const [explorerResponse, plansResponse, candidateResponse] = await Promise.all([
      api.explorer(projectId.value, explorerId),
      api.explorerPlans(projectId.value, explorerId),
      optional(() => api.explorerCandidate(projectId.value, explorerId)),
    ]);
    if (requestVersion !== planProjectionVersion || thread.value?.id !== explorerId) return;
    const projection = normalizePlanProjection(explorerResponse.explorer, candidateResponse?.plan ?? null, plansResponse.items);
    thread.value = projection.thread;
    candidate.value = projection.candidate;
    dispatched.value = projection.dispatched;
  } catch {
    // Keep the last known projection visible while the event stream catches up.
  }
}

function formatTurnTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function explorerDisplayTitle(item: ExplorerThread | null): string {
  return item?.title || "探索线程";
}

function activityTarget(item: ExplorerActivityItem, index: number): string {
  const firstForTurn = visibleActivity.value.find((candidate) => candidate.turnId === item.turnId);
  return firstForTurn?.id === item.id ? `message-${item.turnId}` : `activity-${item.id}-${index}`;
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
  const activeTurnId = current.startsWith("message-") ? current.slice("message-".length) : null;
  activePlanKey.value = activeTurnId ? planTimelineItems.value.find((item) => item.target === `message-${activeTurnId}`)?.key ?? "" : "";
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
  if (hash === "#candidate" && candidate.value) drawerOpen.value = true;
  if (hash === "#candidate" && !candidate.value) candidateEmptyOpen.value = true;
  if (hash === "#summary") memoryPanel.value = "summary";
  if (hash === "#successors") memoryPanel.value = "successors";
}

async function closeCandidateEmpty() {
  candidateEmptyOpen.value = false;
  if (route.hash === "#candidate") await router.replace({ query: route.query, hash: "" });
}

function setCandidateEmptyOpen(open: boolean) {
  if (!open) void closeCandidateEmpty();
}

async function createCandidate() {
  const title = candidateTitle.value.trim();
  if (!title || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    candidate.value = thread.value ? (await api.createExplorerCandidate(projectId.value, thread.value.id, title)).plan : null;
    await closeCandidateEmpty();
    drawerOpen.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? `候选计划创建失败：${caught.message}` : "候选计划创建失败";
  } finally {
    busy.value = false;
  }
}

async function closeMemoryPanel() {
  memoryPanel.value = null;
  if (route.hash) await router.replace({ query: route.query, hash: "" });
}

function setMemoryPanelOpen(open: boolean) {
  if (!open) void closeMemoryPanel();
}

async function createExplorer() {
  if (busy.value) return;
  try {
    const created = await api.createExplorer(projectId.value);
    explorers.value = [created.explorer, ...explorers.value.filter((item) => item.id !== created.explorer.id)];
    try { project.value = (await api.selectProjectExplorer(projectId.value, created.explorer.id)).project; } catch { /* Legacy API instances may not have a Project registry yet. */ }
    historyOpen.value = false;
    await router.push({ path: route.path, query: { explorerId: created.explorer.id }, hash: "" });
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? `新建 Explorer 失败：${caught.message}` : "新建 Explorer 失败");
  }
}

async function selectExplorer(explorerId: string) {
  if (explorerId === thread.value?.id) return;
  const selected = explorers.value.find((item) => item.id === explorerId);
  if (selected?.state !== "ARCHIVED") {
    try { project.value = (await api.selectProjectExplorer(projectId.value, explorerId)).project; } catch { /* Keep navigation available for legacy API instances. */ }
  }
  await router.push({ path: route.path, query: { explorerId }, hash: "" });
}

async function archiveExplorer(explorerId: string) {
  try {
    await api.archiveExplorer(projectId.value, explorerId);
    explorers.value = explorers.value.map((item) => item.id === explorerId ? { ...item, state: "ARCHIVED" } : item);
    ElMessage.success("ExplorerThread 已归档");
    if (thread.value?.id === explorerId) {
      const next = explorers.value.find((item) => item.state !== "ARCHIVED");
      if (next) await selectExplorer(next.id);
    }
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "ExplorerThread 归档失败"); }
}

async function activateExplorer(explorerId: string) {
  try {
    const response = await api.activateExplorer(projectId.value, explorerId);
    explorers.value = explorers.value.map((item) => item.id === explorerId ? response.explorer : item);
    ElMessage.success("ExplorerThread 已恢复");
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "ExplorerThread 恢复失败"); }
}

async function refreshActivity() {
  if (!thread.value) return;
  try {
    const response = await api.explorerActivity(projectId.value, thread.value.id);
    activity.value = response.items;
    explorerEventSequence = Math.max(explorerEventSequence ?? 0, response.lastEventSequence ?? 0);
  } catch {
    // The turn stream remains the source of truth while the activity projection catches up.
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

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [healthResponse, projectResponse, explorerResponse] = await Promise.all([optional(() => api.health()), api.project(projectId.value), api.explorers(projectId.value)]);
    project.value = projectResponse.project;
    if (healthResponse?.model) explorerModel.value = healthResponse.model;
    explorers.value = explorerResponse.items;
    const routeExplorerId = typeof route.query.explorerId === "string" ? route.query.explorerId : null;
    let selected = routeExplorerId ? explorerResponse.items.find((item) => item.id === routeExplorerId) : undefined;
    if (!routeExplorerId && projectResponse.project.currentExplorerThreadId) selected = explorerResponse.items.find((item) => item.id === projectResponse.project.currentExplorerThreadId);
    if (!routeExplorerId && thread.value) selected = explorerResponse.items.find((item) => item.id === thread.value?.id);
    if (!selected) selected = explorerResponse.items.find((item) => item.state !== "ARCHIVED" && item.contextMode === "FRESH" && item.messageCount === 0);
    if (!selected) {
      selected = (await api.createExplorer(projectId.value)).explorer;
      explorers.value = [selected, ...explorers.value];
      project.value = (await api.selectProjectExplorer(projectId.value, selected.id)).project;
    }
    const [plansResponse, turnsResponse, candidateResponse] = await Promise.all([
      api.explorerPlans(projectId.value, selected.id),
      api.explorerTurnsV4(projectId.value, selected.id),
      optional(() => api.explorerCandidate(projectId.value, selected!.id)),
    ]);
    const projection = normalizePlanProjection(selected, candidateResponse?.plan ?? null, plansResponse.items);
    thread.value = projection.thread;
    candidate.value = projection.candidate;
    dispatched.value = projection.dispatched;
    turns.value = turnsResponse.items;
    explorerEventSequence = turnsResponse.lastEventSequence ?? null;
    const activityResponse = await api.explorerActivity(projectId.value, selected.id);
    activity.value = activityResponse.items;
    explorerEventSequence = Math.max(explorerEventSequence ?? 0, activityResponse.lastEventSequence ?? 0);
    const loopResponse = await api.explorerAgentLoops(projectId.value, selected.id);
    agentLoop.value = [...loopResponse.items].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null;
    if (eventSource) connectLoopEvents();
    explorerPaused.value = agentLoop.value?.state === "PAUSED";
    const activeTurn = turns.value.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT");
    busy.value = activeTurn;
    sendingTurn.value = activeTurn;
    const inputResponse = await api.inputRequests(projectId.value, selected.id);
    setInputRequests(inputResponse.items);
    inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
    await nextTick();
    updateTimelineScrollState();
  } catch (caught) {
    project.value = null;
    thread.value = null;
    explorers.value = [];
    candidate.value = null;
    dispatched.value = [];
    turns.value = [];
    activity.value = [];
    inputRequests.value = [];
    pendingInput.value = null;
    recoveryInput.value = null;
    inputProgress.value = null;
    error.value = caught instanceof Error ? caught.message : "Project 加载失败";
  } finally {
    loading.value = false;
  }
}

async function sendTurn() {
  const content = draft.value.trim();
  if (!content || busy.value || !thread.value || thread.value.state === "ARCHIVED" || project.value?.status === "ARCHIVED") return;
  const now = new Date().toISOString();
  const optimisticUser = createOptimisticUserTurn({
    id: `local-user-${Date.now()}`,
    threadId: thread.value.id,
    content,
    createdAt: now,
    sequence: turns.value.length + 1,
  });
  turns.value = [...turns.value, optimisticUser];
  const optimisticAssistant: ExplorerActivityItem = { id: `local-assistant-activity-${Date.now()}`, explorerId: optimisticUser.threadId, turnId: `local-assistant-turn-${Date.now()}`, sequence: optimisticUser.sequence + 1, kind: "ASSISTANT_MESSAGE", status: "RUNNING", title: "Plan Explorer", summary: "Plan Explorer 正在处理…", details: null, occurredAt: new Date().toISOString() };
  activity.value = [...activity.value, { id: `local-user-activity-${optimisticUser.id}`, explorerId: optimisticUser.threadId, turnId: optimisticUser.id, sequence: optimisticUser.sequence, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: content, details: null, occurredAt: now }, optimisticAssistant];
  draft.value = "";
  busy.value = true;
  sendingTurn.value = true;
  await nextTick();
  if (timeline.value) scrollTimelineToLatest(timeline.value);
  try {
    const response = await api.startExplorerTurn(projectId.value, optimisticUser.threadId, content, `client-turn-${Date.now()}`);
    agentLoop.value = (await api.agentLoop(response.loopId)).loop;
    connectLoopEvents();
    turns.value = settleOptimisticTurn(turns.value, optimisticUser.id, response.turn);
    await refreshActivity();
    if (thread.value) thread.value = { ...thread.value, messageCount: thread.value.messageCount + 2, lastActivityAt: response.turn.assistant.createdAt };
    ElMessage.success("消息已发送");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "API 未连接";
    turns.value = [...turns.value, { id: `local-assistant-${Date.now()}`, threadId: optimisticUser.threadId, role: "assistant", content: `消息已发送，但模型回复失败：${message}`, status: "FAILED", error: message, createdAt: new Date().toISOString(), sequence: optimisticUser.sequence + 1 }];
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
  const response = await api.explorerTurnsV4(projectId.value, thread.value.id);
  turns.value = response.items;
  await refreshActivity();
  await refreshPlanProjection();
  const inputResponse = await api.inputRequests(projectId.value, thread.value.id);
  setInputRequests(inputResponse.items);
  const activeTurn = response.items.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT");
  if (!pendingInput.value) { inputDialogOpen.value = false; busy.value = activeTurn; sendingTurn.value = activeTurn; }
  await nextTick();
  if (timeline.value) scrollTimelineToLatest(timeline.value);
}

function connectEvents() {
  if (!thread.value || typeof EventSource === "undefined") return;
  eventSource?.close();
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  if (explorerEventSequence !== null) replayGate.markReady();
  eventSource = new EventSource(api.explorerEventsUrl(projectId.value, thread.value.id, explorerEventSequence ?? undefined));
  eventSource.addEventListener("stream.ready", () => {
    replayGate.accept("stream.ready");
    void refreshTurnsAfterEvent();
  });
  eventSource.addEventListener("turn.text.delta", (raw) => {
    if (!replayGate.accept("turn.text.delta")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { turnId: string; text: string };
    const current = turns.value.find((turn) => turn.id === payload.turnId);
    if (current) mergeTurn({ ...current, content: current.content + payload.text, status: "RUNNING" });
    void refreshActivity();
  });
  eventSource.addEventListener("turn.input_required", async (raw) => {
    if (!replayGate.accept("turn.input_required")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { requestId: string };
    if (!thread.value) return;
    const response = await api.inputRequests(projectId.value, thread.value.id);
    setInputRequests(response.items);
    pendingInput.value = response.items.find((item) => item.id === payload.requestId) ?? null;
    recoveryInput.value = null;
    inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
  });
  eventSource.addEventListener("title.updated", (raw) => {
    if (!replayGate.accept("title.updated")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { explorerId: string; title: string; titleStatus: ExplorerThread["titleStatus"] };
    if (payload.explorerId !== thread.value?.id) return;
    thread.value = { ...thread.value, title: payload.title, titleStatus: payload.titleStatus };
    explorers.value = explorers.value.map((item) => item.id === payload.explorerId ? { ...item, title: payload.title, titleStatus: payload.titleStatus } : item);
  });
  for (const eventName of ["turn.completed", "turn.failed", "turn.cancelled", "turn.input.resolved", "explorer.plan.ready"]) eventSource.addEventListener(eventName, () => { if (!replayGate.accept(eventName)) return; void refreshTurnsAfterEvent(); });
  eventSource.addEventListener("thread.state.changed", () => { if (!replayGate.accept("thread.state.changed")) return; void load(); });
  connectLoopEvents();
}

function connectLoopEvents() {
  if (!agentLoop.value || typeof EventSource === "undefined") return;
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  loopEventSource = new EventSource(api.agentLoopEventsUrl(agentLoop.value.id));
  loopEventSource.addEventListener("stream.ready", () => { replayGate.accept("stream.ready"); });
  for (const eventName of ["agent.loop.started", "agent.step.started", "agent.step.model_text_delta", "agent.step.tool_requested", "agent.step.tool_completed", "agent.step.tool_denied", "agent.step.tool_failed", "agent.step.tool_needs_reconciliation", "agent.step.input_required", "agent.step.input_resolved", "agent.step.context_compacted", "agent.step.gate_checked", "agent.provider.activity", "agent.input.required", "agent.input.resolved", "agent.loop.paused", "agent.loop.resumed", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required"]) {
    loopEventSource.addEventListener(eventName, () => {
      if (!replayGate.accept(eventName)) return;
      if (!agentLoop.value) return;
      void api.agentLoop(agentLoop.value.id).then(async (response) => {
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
  busy.value = true;
  try { candidate.value = (await api.confirm(id)).plan; await refreshPlanProjection(); } catch (caught) { error.value = caught instanceof Error ? `Confirm plan 失败：${caught.message}` : "Confirm plan 失败"; } finally { busy.value = false; }
}

async function enqueuePlan() {
  if (!candidate.value || candidate.value.status !== "READY" || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId!;
  busy.value = true;
  try {
    const queuedPlan = (await api.enqueue(id)).plan;
    dispatched.value = [queuedPlan, ...dispatched.value];
    candidate.value = null;
    drawerOpen.value = false;
    await refreshPlanProjection();
  } catch (caught) {
    error.value = caught instanceof Error ? `Enqueue plan 失败：${caught.message}` : "Enqueue plan 失败";
  }
  busy.value = false;
}

async function discardPlan() {
  if (!candidate.value || candidate.value.status !== "DRAFT" || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId;
  if (!id) return;
  try {
    await ElMessageBox.confirm(`Discard “${candidate.value.title}”? This Plan will be kept as Discarded and cannot be confirmed, enqueued, or started.`, "Discard plan", { confirmButtonText: "Discard plan", cancelButtonText: "Keep editing", type: "warning" });
  } catch {
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await api.discard(id);
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

function statusLabel(status: string) { return ({ DRAFT: "Candidate", DISCARDED: "Discarded", READY: "Confirmed", QUEUED: "Queued", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Ready for review", MERGED: "Merged", NEEDS_PLAN_CHANGE: "Plan change required", BLOCKED: "Blocked" } as Record<string, string>)[status] ?? status; }
watch(() => route.hash, syncHashPanel);
watch(candidate, () => syncHashPanel(route.hash));
watch(() => route.query.explorerId, () => { if (mounted.value) void load().then(connectEvents); });
onMounted(() => { mounted.value = true; void load().then(connectEvents); syncHashPanel(route.hash); });
onBeforeUnmount(closeEvents);
</script>

<template>
  <div class="console-layout">
    <ThreadRail :thread="thread" :project="project" :candidate-count="candidateCount" :dispatched-count="dispatchedCount" :active-run-count="activeRunCount" :needs-attention-count="needsAttentionCount" @open-history="historyOpen = true" />
    <section class="conversation-column">
      <div class="conversation-header"><div><div class="eyebrow"><span class="mode-dot" /> PLAN MODE · READ ONLY</div><h1>{{ explorerDisplayTitle(thread) }}</h1><p>Shape the work before anything changes in the repository.</p></div><div class="conversation-tools"><el-button class="new-thread-button" plain aria-label="新建 Explorer" title="新建 Explorer" @click="createExplorer">新建</el-button><el-button circle plain :aria-label="explorerPaused ? 'Resume' : 'Pause'" @click="toggleExplorerPause"><VideoPlay v-if="explorerPaused" :size="16" /><VideoPause v-else :size="16" /></el-button><el-popover v-model:visible="moreOpen" placement="bottom-end" :width="250" trigger="click"><template #reference><el-button circle plain aria-label="More"><MoreFilled :size="16" /></el-button></template><div class="thread-more-menu"><div class="eyebrow">THREAD ACTIONS</div><p>Manage read-only exploration without changing the repository.</p><el-button text @click="setPolicyOpen(true); moreOpen = false">View policy</el-button><el-button text @click="moreOpen = false; refreshThread()">Refresh thread</el-button></div></el-popover></div></div>
      <div v-if="agentLoop" class="agent-loop-strip" role="status"><div><span class="eyebrow">EXPLORER AGENT LOOP</span><strong>{{ agentLoopLabel }}</strong></div><span class="agent-loop-budget">Steps {{ agentLoop.stepCount }} / {{ agentLoop.maxSteps }}</span><el-button v-if="agentLoop.state === 'RUNNING' || agentLoop.state === 'PAUSED'" size="small" plain @click="toggleExplorerPause">{{ agentLoop.state === 'PAUSED' ? 'Resume loop' : 'Pause loop' }}</el-button></div>
      <div v-if="showThreadBanner" class="thread-banner" role="status" @click="dismissThreadBanner"><InfoFilled :size="16" /><span>Explorer can inspect the repository and Git history. Write, shell, test and commit tools are disabled until a plan is confirmed and dispatched.</span><el-button text aria-label="View Explorer policy" @click.stop="setPolicyOpen(true)">View policy <Right :size="14" /></el-button></div>
      <div v-if="explorationProgress.status === 'INCOMPLETE' && explorationProgress.lastAssessedTurnId" class="exploration-progress exploration-progress-incomplete" role="status"><Refresh :size="15" /><div><strong>方案仍在探索中</strong><span>本轮结束不代表设计完成，Explorer 正在继续确认：{{ explorationProgress.missing.join('、') }}</span></div></div>
      <div v-else-if="explorationProgress.status === 'READY'" class="exploration-progress exploration-progress-ready" role="status"><CircleCheck :size="15" /><div><strong>完整设计方案已生成</strong><span>请在生成它的 assistant 消息内查看完整契约，确认后再下发执行。</span></div></div>
      <div v-if="explorerPaused" class="demo-notice pause-notice"><VideoPause :size="14" /> ExplorerThread is paused. New turns are disabled until you resume the thread.<el-button text @click="toggleExplorerPause">Resume</el-button></div>
      <div v-if="error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">Retry</el-button></div>
      <div class="timeline-stage">
      <aside class="timeline-rail timeline-rail-messages" aria-label="Message timeline">
        <div class="timeline-rail-heading"><span>MESSAGES</span><strong>{{ messageTimelineItems.length }}</strong></div>
        <button v-for="item in messageTimelineItems" :key="item.key" type="button" :class="['timeline-rail-item', { active: activeTimelineKey === item.key }]" :aria-current="activeTimelineKey === item.key ? 'location' : undefined" @click="jumpToTimelineTarget(item.target, item.key)"><span class="timeline-rail-marker"><i /></span><span class="timeline-rail-copy"><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span></button>
      </aside>
      <div class="timeline-shell">
      <div ref="timeline" class="timeline" v-loading="loading" @scroll="updateTimelineScrollState">
        <div class="timeline-day">{{ turns.length ? 'EXPLORER ACTIVITY' : 'NEW EXPLORATION' }}</div>
        <div v-if="!visibleActivity.length && !candidate && !dispatched.length" class="timeline-empty"><Connection :size="24" /><strong>开始一次全新的需求探索</strong><span>在下方输入需求。当前 Explorer 与历史记录完全隔离。</span></div>
        <article id="message-input-request" data-nav-key="message-input-request" v-if="inputCardRequest" :class="['input-request-card', { recovery: Boolean(recoveryInput) }]">
          <div class="input-request-card-icon"><InfoFilled :size="16" /></div>
          <div class="input-request-card-body">
            <div class="message-meta"><strong>{{ recoveryInput ? 'Plan Explorer input needs recovery' : 'Plan Explorer needs your input' }}</strong><span class="agent-chip">{{ recoveryInput ? 'Recovery required' : (inputCardRequest.isBlocking ? 'Blocking' : 'Optional') }}</span></div>
            <p v-if="recoveryInput">The App Server connection ended before this answer was confirmed. No answer was retried automatically; restart the provider session and continue from this thread.</p>
            <p v-else>{{ inputCardRequest.questions.length }} structured question{{ inputCardRequest.questions.length === 1 ? '' : 's' }} are waiting before this turn can continue.</p>
            <div class="input-stream-questions">
              <div v-for="(question, questionIndex) in inputCardRequest.questions" :key="question.id" class="input-stream-question">
                <span class="question-index">{{ questionIndex + 1 }}</span>
                <div><strong>{{ question.header }}</strong><p>{{ question.question }}</p><small :class="{ answered: inputAnswerLabelsFor(inputCardRequest, question).length }">选择：{{ inputAnswerText(inputCardRequest, question) }}</small></div>
              </div>
            </div>
          </div>
          <el-button v-if="pendingInput" type="primary" plain @click="openInputRequest">Answer</el-button>
        </article>
        <div class="timeline-marker"><span>THREAD READY FOR YOUR NEXT TURN</span></div>
        <template v-for="(item, index) in visibleActivity" :key="item.id">
          <article v-if="item.kind === 'USER_MESSAGE' || item.kind === 'ASSISTANT_MESSAGE'" :id="activityTarget(item, index)" :data-nav-key="`message-${item.turnId}`" :class="['message-card', item.kind === 'USER_MESSAGE' ? 'user-message' : 'assistant-message', item.status === 'FAILED' ? 'failed-message' : '', item.status === 'RUNNING' ? 'processing-message' : '']">
            <div :class="['message-avatar', item.kind === 'USER_MESSAGE' ? 'user-avatar' : 'agent-avatar']">{{ item.kind === 'USER_MESSAGE' ? 'LS' : '' }}<span v-if="item.kind === 'ASSISTANT_MESSAGE'" :class="['brand-dot', { 'brand-dot-processing': item.status === 'RUNNING' }]" /></div>
            <div class="message-body"><div class="message-meta"><strong>{{ item.title }}</strong><span v-if="item.kind === 'ASSISTANT_MESSAGE'" :class="['agent-chip', { 'processing-chip': item.status === 'RUNNING' }]">{{ item.status === 'RUNNING' ? 'Running' : item.status === 'FAILED' ? 'Failed' : 'Read only' }}</span><span>{{ formatTurnTime(item.occurredAt) }}</span></div><p :aria-live="item.status === 'RUNNING' ? 'polite' : undefined">{{ item.kind === 'ASSISTANT_MESSAGE' ? readableAssistantText(item.summary) : item.summary }}<span v-if="item.status === 'RUNNING'" class="processing-dots" aria-hidden="true"><i /><i /><i /></span></p><div v-if="planForActivity(item)" :id="planAnchorId(planForActivity(item))" :data-nav-key="planAnchorKey(planForActivity(item))" class="inline-plan-card"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">CANDIDATE PLAN · REVISION {{ planForActivity(item)?.revision }}</div><h2>{{ planForActivity(item)?.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(planForActivity(item)?.status ?? 'DRAFT') }}</el-tag></div><p class="candidate-summary">{{ planForActivity(item)?.contract?.goal ?? planForActivity(item)?.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p><div class="candidate-stats"><div><span>Tasks</span><strong>{{ planForActivity(item)?.contract?.tasks.length ?? planForActivity(item)?.tasks?.length ?? 0 }}</strong></div><div><span>Scope entries</span><strong>{{ planForActivity(item)?.contract?.include.length ?? planForActivity(item)?.include?.length ?? 0 }}</strong></div><div><span>Verification</span><strong>{{ planForActivity(item)?.contract?.verificationCommandIds.length ?? planForActivity(item)?.verificationCommands?.length ?? 0 }} checks</strong></div><div><span>Merge</span><strong class="risk-low">Human review</strong></div></div><div class="candidate-actions"><el-button v-if="isCandidatePlan(planForActivity(item))" @click="drawerOpen = true">View full plan <Right :size="15" /></el-button><el-button v-if="isCandidatePlan(planForActivity(item)) && planForActivity(item)?.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="isCandidatePlan(planForActivity(item)) && planForActivity(item)?.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(planForActivity(item)?.status ?? 'DRAFT') }}</span></div></div></div>
          </article>
          <article v-else :id="activityTarget(item, index)" class="loop-activity-card" :class="{ waiting: item.status === 'WAITING', failed: item.status === 'FAILED' }"><div class="loop-activity-icon"><InfoFilled v-if="activityIconKind(item.kind) === 'info'" :size="14" /><Check v-else-if="activityIconKind(item.kind) === 'success'" :size="14" /><Warning v-else :size="14" /></div><div class="loop-activity-copy"><div class="loop-activity-meta"><strong>{{ activityKindLabel(item.kind) }}</strong><span>{{ formatTurnTime(item.occurredAt) }}</span><span class="agent-chip">{{ activityStatusLabel(item) }}</span></div><p>{{ item.summary }}</p><code v-if="typeof item.details?.tool === 'string'">{{ item.details.tool }}</code></div></article>
        </template>
        <article v-for="request in answeredInputRequests" :id="`input-transcript-${request.id}`" :key="`input-transcript-${request.id}`" class="input-transcript-card">
          <div class="input-request-card-icon"><Check :size="16" /></div>
          <div class="input-request-card-body">
            <div class="message-meta"><strong>Plan Explorer input</strong><span class="agent-chip input-resolved-chip">Answered</span><span>{{ formatTurnTime(request.answeredAt ?? request.createdAt) }}</span></div>
            <p>本轮结构化选择已提交，以下内容作为对话记录保留。</p>
            <div class="input-stream-questions">
              <div v-for="(question, questionIndex) in request.questions" :key="question.id" class="input-stream-question">
                <span class="question-index">{{ questionIndex + 1 }}</span>
                <div><strong>{{ question.header }}</strong><p>{{ question.question }}</p><small class="answered">选择：{{ inputAnswerText(request, question) }}</small></div>
              </div>
            </div>
          </div>
        </article>
        <article v-for="item in syntheticPlanItems" :id="item.target" :key="item.key" :data-nav-key="item.key" class="inline-plan-card plan-created-event"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">PLAN CREATED · REVISION {{ item.plan.revision }}</div><h2>{{ item.plan.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(item.plan.status) }}</el-tag></div><p class="candidate-summary">{{ item.plan.contract?.goal ?? item.plan.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p><div class="candidate-actions"><el-button v-if="isCandidatePlan(item.plan)" @click="drawerOpen = true">View full plan <Right :size="15" /></el-button><el-button v-if="isCandidatePlan(item.plan) && item.plan.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="isCandidatePlan(item.plan) && item.plan.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(item.plan.status) }}</span></div></article>
      </div>
      <button v-if="showScrollToLatest" class="scroll-to-latest" type="button" aria-label="Scroll to latest message" title="Scroll to latest message" @click="jumpToLatest"><img class="scroll-to-latest-image" :src="scrollToLatestIcon" alt="" /></button>
      </div>
      <aside class="timeline-rail timeline-rail-plans" aria-label="Plan timeline">
        <div class="timeline-rail-heading"><span>PLANS</span><strong>{{ planTimelineItems.length }}</strong></div>
        <button v-for="item in planTimelineItems" :key="item.key" type="button" :class="['timeline-rail-item', { active: activePlanKey === item.key }]" :aria-current="activePlanKey === item.key ? 'location' : undefined" @click="jumpToTimelineTarget(item.target, item.key)"><span class="timeline-rail-marker"><i /></span><span class="timeline-rail-copy"><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span></button>
        <div v-if="!planTimelineItems.length" class="timeline-rail-empty">No generated plans yet.</div>
      </aside>
      </div>
      <div class="composer"><div class="composer-input"><textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused || busy" aria-label="Explorer message" placeholder="继续探索，或提出修改…" @keydown="handleComposerKeydown" /><span class="composer-mode">Plan Mode</span></div><div class="composer-footer"><div class="composer-metadata" aria-label="模型与上下文信息"><span class="composer-fact"><small>MODEL</small><strong>{{ explorerModel }}</strong></span><span class="composer-fact"><small>CONTEXT</small><strong>{{ contextUsage }}</strong><em>estimated</em></span><el-popover v-model:visible="statusOpen" placement="top-end" :width="330" trigger="click" @show="void loadRateLimits()"><template #reference><button class="composer-status-trigger" type="button" aria-label="Status" :aria-expanded="statusOpen"><i aria-hidden="true" /><span>STATUS</span><InfoFilled :size="12" /></button></template><div class="codex-status-popover" role="dialog" aria-label="Codex usage status"><div class="codex-status-title"><InfoFilled :size="14" /><strong>状态</strong><button type="button" aria-label="关闭" @click="statusOpen = false">关闭</button></div><div class="codex-status-row"><span>模型：</span><strong>{{ explorerModel }}</strong></div><div class="codex-status-row"><span>会话/对话串：</span><code :title="thread?.id ?? 'no-thread'">{{ conversationId }}</code></div><div class="codex-status-row"><span>背景信息：</span><strong>{{ contextUsage }}</strong><em>estimated</em></div><div class="codex-status-row"><span>5 小时限额：</span><strong>{{ rateLimits.fiveHour.remaining }}</strong><small>{{ rateLimits.fiveHour.reset }}</small></div><div class="codex-status-row"><span>7 天限额：</span><strong>{{ rateLimits.sevenDay.remaining }}</strong><small>{{ rateLimits.sevenDay.reset }}</small></div><p class="codex-status-note">{{ rateLimitNote }}</p></div></el-popover></div><span v-if="sendingTurn" class="composer-status" role="status" aria-live="polite">Message sent · waiting for Plan Explorer…</span><el-button class="composer-send" type="primary" circle :loading="busy" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || !draft.trim() || explorerPaused || busy" aria-label="Send message" title="Send message" @click="sendTurn"><ArrowUp :size="18" /></el-button></div></div>
    </section>
    <aside class="context-panel"><div class="context-header"><div><div class="eyebrow">THREAD CONTEXT</div><h2>Working set</h2></div><el-button text circle aria-label="Refresh" @click="refreshThread"><Refresh :size="16" /></el-button></div><div class="context-section"><div class="context-section-title">CURRENT CANDIDATE <span>{{ candidateCount }}</span></div><div class="mini-plan" v-if="candidate" @click="drawerOpen = true"><div class="mini-plan-title"><span class="mini-icon"><Promotion :size="14" /></span><strong>{{ candidate.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="warning" effect="light">{{ statusLabel(candidate.status) }}</el-tag><span>Rev {{ candidate.revision }}</span></div><div class="mini-plan-link">View full plan <Right :size="13" /></div></div><div v-else class="context-empty compact"><CircleCheck :size="20" /><p>No candidate plan</p><small>Use Plan candidates to create a reviewable plan.</small></div></div><div class="context-section"><div class="context-section-title">DISPATCHED PLANS <span>{{ dispatched.length }}</span></div><div v-if="dispatched.length === 0" class="context-empty"><CircleCheck :size="20" /><p>No plans dispatched from this thread yet.</p><small>Confirmed plans will appear here and remain queryable even when the model is offline.</small></div><div v-else v-for="plan in dispatched" :key="plan.planId ?? plan.id" class="mini-plan dispatched"><div class="mini-plan-title"><span class="mini-icon success"><CircleCheck :size="14" /></span><strong>{{ plan.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="success" effect="light">{{ statusLabel(plan.status) }}</el-tag><span>Rev {{ plan.revision }}</span></div></div></div><div class="context-section context-memory"><div class="context-section-title">THREAD MEMORY</div><div class="memory-row"><span class="memory-icon">◎</span><div><strong>Context summary</strong><small>Updated just now</small></div><Right :size="14" /></div><div class="memory-row"><span class="memory-icon">↗</span><div><strong>Successor threads</strong><small>None yet</small></div><Right :size="14" /></div></div></aside>
    <ExplorerHistoryDrawer v-model="historyOpen" :explorers="explorers" :current-id="thread?.id ?? null" @select="selectExplorer" @create="createExplorer" @archive="archiveExplorer" @activate="activateExplorer" />
    <PlanDetailDrawer v-model="drawerOpen" :plan="candidate" @confirm="confirmPlan" @discard="discardPlan" @enqueue="enqueuePlan" />
    <ExplorerInputDialog ref="inputDialog" v-model="inputDialogOpen" :request="pendingInput" @submit="submitInput" @cancel="cancelInput" @progress="updateInputProgress" />
    <ExplorerPolicyDrawer :model-value="policyOpen" @update:model-value="setPolicyOpen" />
    <el-drawer :model-value="candidateEmptyOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false" @update:model-value="setCandidateEmptyOpen">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">PLAN CANDIDATES</div><h2>No candidate plan</h2></div><el-button text circle aria-label="Close candidate plans" @click="closeCandidateEmpty">×</el-button></div>
        <div class="help-card"><strong>Shape a new execution contract</strong><p>This ExplorerThread has no unconfirmed CandidatePlan yet. Create one here, then review the full contract before confirming it.</p></div>
        <label class="candidate-create-label">Plan title<input v-model="candidateTitle" aria-label="Candidate plan title" placeholder="Plan title" @keydown.enter.prevent="createCandidate" /></label>
        <el-button type="primary" :loading="busy" :disabled="!candidateTitle.trim()" @click="createCandidate">Create candidate plan <Right /></el-button>
      </div>
    </el-drawer>
    <el-drawer :model-value="memoryPanel !== null" direction="rtl" size="min(430px, 92vw)" :with-header="false" @update:model-value="setMemoryPanelOpen">
      <div class="global-drawer-shell" v-if="memoryPanel">
        <div class="drawer-header"><div><div class="eyebrow">THREAD MEMORY</div><h2>{{ memoryPanel === "summary" ? "Context summary" : "Successor threads" }}</h2></div><el-button text circle aria-label="Close thread memory" @click="closeMemoryPanel">×</el-button></div>
        <div class="help-card" v-if="memoryPanel === 'summary'"><strong>Current ExplorerThread memory</strong><p>The thread keeps the project context, confirmed boundaries and recent exploration turns available to the Plan Explorer.</p><p class="memory-detail">Thread: {{ thread?.id ?? "no-thread" }}<br />Messages: {{ thread?.messageCount ?? 0 }}<br />Last activity: {{ thread?.lastActivityAt ? new Date(thread.lastActivityAt).toLocaleString('zh-CN') : "—" }}</p></div>
        <div class="help-card" v-else><strong>No successor thread yet</strong><p>This ExplorerThread remains the active project thread. A successor will appear here when context compression creates one, while preserving the parent thread lineage.</p></div>
        <el-button type="primary" @click="closeMemoryPanel">Done <Right /></el-button>
      </div>
    </el-drawer>
  </div>
</template>
