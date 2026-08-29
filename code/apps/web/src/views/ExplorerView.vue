<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Check, CircleCheck, InfoFilled, MoreFilled, Promotion, Refresh, Right, VideoPause, VideoPlay } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { AgentLoop, ExplorerInputRequest, ExplorerThread, ExplorerTurn, Plan } from "../types";
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
import scrollToLatestIcon from "../assets/scroll-to-latest.png";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? "project-demo"));
const thread = ref<ExplorerThread | null>(null);
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
const agentLoop = ref<AgentLoop | null>(null);
const explorerModel = ref("gpt-5.6-luna");
const statusOpen = ref(false);
const inputDialogOpen = ref(false);
const inputDialog = ref<{ onSubmitted: () => void; onFailed: (message: string) => void } | null>(null);
let eventSource: EventSource | null = null;
let loopEventSource: EventSource | null = null;
let explorerEventSequence: number | null = null;
const { visible: showThreadBanner, dismiss: dismissThreadBanner } = useDismissibleNotice();
type TimelineNavItem = { key: string; label: string; detail: string; target: string };

const fallbackThread: ExplorerThread = { id: "thread-demo", projectId: "project-demo", parentThreadId: null, state: "ACTIVE", messageCount: 8, summaryRef: null, lastActivityAt: new Date().toISOString(), exploration: { status: "INCOMPLETE", missing: ["Goal and scope"], completed: [], candidatePlanId: null, lastAssessedTurnId: null } };
const fallbackPlan: Plan = { id: "plan-demo-1", title: "Build ExplorerThread workspace", revision: 1, status: "DRAFT", projectId: "project-demo", sourceExplorerThreadId: "thread-demo", queuedAt: null, runId: null, lastEventAt: new Date().toISOString(), attentionReason: null };
const candidateCount = computed(() => candidate.value ? 1 : 0);
const dispatchedCount = computed(() => dispatched.value.length);
const activeRunCount = computed(() => dispatched.value.filter((plan) => plan.status === "IN_PROGRESS" || plan.status === "VERIFYING").length);
const needsAttentionCount = computed(() => dispatched.value.filter((plan) => plan.status === "BLOCKED" || Boolean(plan.attentionReason)).length);
const inputCardRequest = computed(() => pendingInput.value ?? recoveryInput.value);
const contextUsage = computed(() => formatContextUsage(turns.value));
const conversationId = computed(() => formatConversationId(thread.value?.id ?? "thread-demo"));
const rateLimits = computed(() => ({ fiveHour: formatRateLimit(null), sevenDay: formatRateLimit(null) }));
const agentLoopLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[agentLoop.value?.state ?? ""] ?? "No active loop");
const explorationProgress = computed(() => thread.value?.exploration ?? { status: "INCOMPLETE" as const, missing: [], completed: [], candidatePlanId: null, lastAssessedTurnId: null });
const activeTimelineKey = ref("message-intro");
const messageTimelineItems = computed<TimelineNavItem[]>(() => [
  { key: "message-intro", label: "Your request", detail: "10:42", target: "message-intro" },
  { key: "message-intro-response", label: "Plan Explorer", detail: "Scope mapped", target: "message-intro-response" },
  ...(inputCardRequest.value ? [{ key: "message-input-request", label: "Input required", detail: inputCardRequest.value.status === "RECOVERY_REQUIRED" ? "Recovery" : "Waiting", target: "message-input-request" }] : []),
  ...turns.value.map((turn) => ({ key: `message-${turn.id}`, label: turn.role === "user" ? "You" : "Plan Explorer", detail: formatTurnTime(turn.createdAt), target: `message-${turn.id}` })),
]);
const planTimelineItems = computed<TimelineNavItem[]>(() => [
  ...(candidate.value ? [{ key: "plan-candidate", label: candidate.value.title, detail: `Candidate · Rev ${candidate.value.revision}`, target: "plan-candidate" }] : []),
  ...dispatched.value.map((plan) => ({ key: `plan-${planIdentity(plan)}`, label: plan.title, detail: `${statusLabel(plan.status)} · Rev ${plan.revision}`, target: `plan-event-${planIdentity(plan)}` })),
]);

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

function formatTurnTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function planIdentity(plan: Plan): string {
  return plan.planId ?? plan.id ?? plan.title;
}

function jumpToTimelineTarget(targetId: string, key: string) {
  const target = document.getElementById(targetId);
  if (!timeline.value || !target) return;
  timeline.value.scrollTo({ top: Math.max(0, target.offsetTop - 20), behavior: "smooth" });
  activeTimelineKey.value = key;
}

function updateActiveTimeline() {
  if (!timeline.value) return;
  const nodes = [...timeline.value.querySelectorAll<HTMLElement>("[data-nav-key]")];
  const marker = timeline.value.scrollTop + 72;
  let current = nodes[0]?.dataset.navKey ?? activeTimelineKey.value;
  for (const node of nodes) {
    if (node.offsetTop <= marker && node.dataset.navKey) current = node.dataset.navKey;
    if (node.offsetTop > marker) break;
  }
  activeTimelineKey.value = current;
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
  if (route.hash === "#candidate") await router.replace({ hash: "" });
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
    candidate.value = (await api.createCandidate(projectId.value, title)).plan;
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
  if (route.hash) await router.replace({ hash: "" });
}

function setMemoryPanelOpen(open: boolean) {
  if (!open) void closeMemoryPanel();
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [healthResponse, threadResponse] = await Promise.all([optional(() => api.health()), api.thread(projectId.value)]);
    if (healthResponse?.model) explorerModel.value = healthResponse.model;
    const [plansResponse, turnsResponse, candidateResponse] = await Promise.all([
      api.plans(projectId.value),
      api.explorerTurnsV4(projectId.value, threadResponse.thread.id),
      optional(() => api.candidate(projectId.value)),
    ]);
    thread.value = threadResponse.thread;
    candidate.value = candidateResponse?.plan ?? null;
    dispatched.value = plansResponse.items;
    turns.value = turnsResponse.items;
    explorerEventSequence = turnsResponse.lastEventSequence ?? null;
    const loopResponse = await api.explorerAgentLoops(projectId.value, threadResponse.thread.id);
    agentLoop.value = [...loopResponse.items].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null;
    if (eventSource) connectLoopEvents();
    explorerPaused.value = agentLoop.value?.state === "PAUSED";
    const activeTurn = turns.value.some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT");
    busy.value = activeTurn;
    sendingTurn.value = activeTurn;
    const inputResponse = await api.inputRequests(projectId.value, threadResponse.thread.id);
    pendingInput.value = inputResponse.items.find((item) => item.status === "OPEN") ?? null;
    recoveryInput.value = inputResponse.items.find((item) => item.status === "RECOVERY_REQUIRED") ?? null;
    inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
    await nextTick();
    updateTimelineScrollState();
  } catch (caught) {
    thread.value = fallbackThread;
    candidate.value = fallbackPlan;
    dispatched.value = [];
    turns.value = [];
    error.value = caught instanceof Error ? "API 未连接，当前显示本地演示数据" : "API 未连接，当前显示本地演示数据";
  } finally {
    loading.value = false;
  }
}

async function sendTurn() {
  const content = draft.value.trim();
  if (!content || busy.value) return;
  const now = new Date().toISOString();
  const optimisticUser = createOptimisticUserTurn({
    id: `local-user-${Date.now()}`,
    threadId: thread.value?.id ?? "thread-demo",
    content,
    createdAt: now,
    sequence: turns.value.length + 1,
  });
  turns.value = [...turns.value, optimisticUser];
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

async function submitInput(answers: Record<string, { answers: string[] }>) {
  if (!pendingInput.value) return;
  try {
    await api.answerInput(projectId.value, pendingInput.value.id, answers, `answer-${Date.now()}`);
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
  const inputResponse = await api.inputRequests(projectId.value, thread.value.id);
  pendingInput.value = inputResponse.items.find((item) => item.status === "OPEN") ?? null;
  recoveryInput.value = inputResponse.items.find((item) => item.status === "RECOVERY_REQUIRED") ?? null;
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
  });
  eventSource.addEventListener("turn.input_required", async (raw) => {
    if (!replayGate.accept("turn.input_required")) return;
    const payload = JSON.parse((raw as MessageEvent).data) as { requestId: string };
    if (!thread.value) return;
    const response = await api.inputRequests(projectId.value, thread.value.id);
    pendingInput.value = response.items.find((item) => item.id === payload.requestId) ?? null;
    recoveryInput.value = null;
    inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
  });
  for (const eventName of ["turn.completed", "turn.failed", "turn.cancelled", "turn.input.resolved"]) eventSource.addEventListener(eventName, () => { if (!replayGate.accept(eventName)) return; void refreshTurnsAfterEvent(); });
  eventSource.addEventListener("thread.state.changed", () => { if (!replayGate.accept("thread.state.changed")) return; void load(); });
  connectLoopEvents();
}

function connectLoopEvents() {
  if (!agentLoop.value || typeof EventSource === "undefined") return;
  loopEventSource?.close();
  const replayGate = createSseReplayGate();
  loopEventSource = new EventSource(api.agentLoopEventsUrl(agentLoop.value.id));
  loopEventSource.addEventListener("stream.ready", () => { replayGate.accept("stream.ready"); });
  for (const eventName of ["agent.loop.started", "agent.step.started", "agent.input.required", "agent.input.resolved", "agent.loop.paused", "agent.loop.resumed", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required"]) {
    loopEventSource.addEventListener(eventName, () => {
      if (!replayGate.accept(eventName)) return;
      if (!agentLoop.value) return;
      void api.agentLoop(agentLoop.value.id).then((response) => { agentLoop.value = response.loop; explorerPaused.value = response.loop.state === "PAUSED"; }).catch(() => undefined);
    });
  }
}

function closeEvents() { eventSource?.close(); loopEventSource?.close(); eventSource = null; loopEventSource = null; }

async function confirmPlan() {
  if (!candidate.value || !candidate.value.id && !candidate.value.planId || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId!;
  busy.value = true;
  try { candidate.value = (await api.confirm(id)).plan; } catch (caught) { error.value = caught instanceof Error ? `Confirm plan 失败：${caught.message}` : "Confirm plan 失败"; } finally { busy.value = false; }
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
  } catch (caught) {
    error.value = caught instanceof Error ? `Enqueue plan 失败：${caught.message}` : "Enqueue plan 失败";
  }
  busy.value = false;
}

function statusLabel(status: string) { return ({ DRAFT: "Candidate", READY: "Confirmed", QUEUED: "Queued", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Ready for review", MERGED: "Merged", NEEDS_PLAN_CHANGE: "Plan change required", BLOCKED: "Blocked" } as Record<string, string>)[status] ?? status; }
watch(() => route.hash, syncHashPanel);
watch(candidate, () => syncHashPanel(route.hash));
onMounted(() => { void load().then(connectEvents); syncHashPanel(route.hash); });
onBeforeUnmount(closeEvents);
</script>

<template>
  <div class="console-layout">
    <ThreadRail :thread="thread" :candidate-count="candidateCount" :dispatched-count="dispatchedCount" :active-run-count="activeRunCount" :needs-attention-count="needsAttentionCount" />
    <section class="conversation-column">
      <div class="conversation-header"><div><div class="eyebrow"><span class="mode-dot" /> PLAN MODE · READ ONLY</div><h1>ExplorerThread</h1><p>Shape the work before anything changes in the repository.</p></div><div class="conversation-tools"><el-button class="new-thread-button" plain aria-label="新建" title="新建">新建</el-button><el-button circle plain :aria-label="explorerPaused ? 'Resume' : 'Pause'" @click="toggleExplorerPause"><VideoPlay v-if="explorerPaused" :size="16" /><VideoPause v-else :size="16" /></el-button><el-popover v-model:visible="moreOpen" placement="bottom-end" :width="250" trigger="click"><template #reference><el-button circle plain aria-label="More"><MoreFilled :size="16" /></el-button></template><div class="thread-more-menu"><div class="eyebrow">THREAD ACTIONS</div><p>Manage read-only exploration without changing the repository.</p><el-button text @click="setPolicyOpen(true); moreOpen = false">View policy</el-button><el-button text @click="moreOpen = false; refreshThread()">Refresh thread</el-button></div></el-popover></div></div>
      <div v-if="agentLoop" class="agent-loop-strip" role="status"><div><span class="eyebrow">EXPLORER AGENT LOOP</span><strong>{{ agentLoopLabel }}</strong></div><span class="agent-loop-budget">Steps {{ agentLoop.stepCount }} / {{ agentLoop.maxSteps }}</span><el-button v-if="agentLoop.state === 'RUNNING' || agentLoop.state === 'PAUSED'" size="small" plain @click="toggleExplorerPause">{{ agentLoop.state === 'PAUSED' ? 'Resume loop' : 'Pause loop' }}</el-button></div>
      <div v-if="showThreadBanner" class="thread-banner" role="status" @click="dismissThreadBanner"><InfoFilled :size="16" /><span>Explorer can inspect the repository and Git history. Write, shell, test and commit tools are disabled until a plan is confirmed and dispatched.</span><el-button text aria-label="View Explorer policy" @click.stop="setPolicyOpen(true)">View policy <Right :size="14" /></el-button></div>
      <div v-if="explorationProgress.status === 'INCOMPLETE' && explorationProgress.lastAssessedTurnId" class="exploration-progress exploration-progress-incomplete" role="status"><Refresh :size="15" /><div><strong>方案仍在探索中</strong><span>本轮结束不代表设计完成，Explorer 正在继续确认：{{ explorationProgress.missing.join('、') }}</span></div></div>
      <div v-else-if="explorationProgress.status === 'READY'" class="exploration-progress exploration-progress-ready" role="status"><CircleCheck :size="15" /><div><strong>完整设计方案已生成</strong><span>请在 CandidatePlan 中查看完整契约，确认后再下发执行。</span></div></div>
      <div v-if="explorerPaused" class="demo-notice pause-notice"><VideoPause :size="14" /> ExplorerThread is paused. New turns are disabled until you resume the thread.<el-button text @click="toggleExplorerPause">Resume</el-button></div>
      <div v-if="error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">Retry</el-button></div>
      <div class="timeline-stage">
      <aside class="timeline-rail timeline-rail-messages" aria-label="Message timeline">
        <div class="timeline-rail-heading"><span>MESSAGES</span><strong>{{ messageTimelineItems.length }}</strong></div>
        <button v-for="item in messageTimelineItems" :key="item.key" type="button" :class="['timeline-rail-item', { active: activeTimelineKey === item.key }]" :aria-current="activeTimelineKey === item.key ? 'location' : undefined" @click="jumpToTimelineTarget(item.target, item.key)"><span class="timeline-rail-marker"><i /></span><span class="timeline-rail-copy"><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span></button>
      </aside>
      <div class="timeline-shell">
      <div ref="timeline" class="timeline" v-loading="loading" @scroll="updateTimelineScrollState">
        <div class="timeline-day">TODAY · 10:42</div>
        <article id="message-intro" data-nav-key="message-intro" class="message-card user-message"><div class="message-avatar user-avatar">LS</div><div class="message-body"><div class="message-meta"><strong>You</strong><span>10:42</span></div><p>We need an ExplorerThread-first workspace where I can review the full plan before sending it to execution.</p></div></article>
        <article id="message-intro-response" data-nav-key="message-intro-response" class="message-card assistant-message"><div class="message-avatar agent-avatar"><span class="brand-dot" /></div><div class="message-body"><div class="message-meta"><strong>Plan Explorer</strong><span class="agent-chip">Read only</span><span>10:42</span></div><p>I mapped the thread model, the confirmation boundary and the plan projection. I found one design that meets the scope without changing execution permissions.</p><div class="insight-row"><span><Check :size="13" /> Scope checked</span><span><Check :size="13" /> Dependencies checked</span><span><Check :size="13" /> Verification defined</span></div></div></article>
        <div class="timeline-marker"><span>PLAN CANDIDATE GENERATED</span></div>
        <article id="plan-candidate" data-nav-key="plan-candidate" class="candidate-card" v-if="candidate"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">CANDIDATE PLAN · REVISION {{ candidate.revision }}</div><h2>{{ candidate.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(candidate.status) }}</el-tag></div><p class="candidate-summary">{{ candidate.contract?.goal ?? candidate.goal ?? 'A complete, reviewable execution contract generated from this ExplorerThread.' }}</p><div class="candidate-stats"><div><span>Tasks</span><strong>{{ candidate.contract?.tasks.length ?? candidate.tasks?.length ?? 0 }}</strong></div><div><span>Scope entries</span><strong>{{ candidate.contract?.include.length ?? candidate.include?.length ?? 0 }}</strong></div><div><span>Verification</span><strong>{{ candidate.contract?.verificationCommandIds.length ?? candidate.verificationCommands?.length ?? 0 }} checks</strong></div><div><span>Merge</span><strong class="risk-low">Human review</strong></div></div><div class="candidate-actions"><el-button @click="drawerOpen = true">View full plan <Right :size="15" /></el-button><el-button v-if="candidate.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="candidate.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(candidate.status) }}</span></div></article>
        <div v-if="dispatched.length" class="timeline-marker plan-marker"><span>DISPATCHED PLAN TIMELINE</span></div>
        <div v-if="dispatched.length" class="plan-event-list">
          <article v-for="plan in dispatched" :id="`plan-event-${planIdentity(plan)}`" :key="`event-${planIdentity(plan)}`" :data-nav-key="`plan-${planIdentity(plan)}`" class="plan-event-card"><div class="plan-event-icon"><CircleCheck :size="16" /></div><div><div class="plan-event-meta"><strong>{{ statusLabel(plan.status) }}</strong><span>Rev {{ plan.revision }}</span></div><h3>{{ plan.title }}</h3><p>Dispatched from ExplorerThread and available in the plan registry.</p></div></article>
        </div>
        <article id="message-input-request" data-nav-key="message-input-request" v-if="inputCardRequest" :class="['input-request-card', { recovery: Boolean(recoveryInput) }]">
          <div class="input-request-card-icon"><InfoFilled :size="16" /></div>
          <div class="input-request-card-body">
            <div class="message-meta"><strong>{{ recoveryInput ? 'Plan Explorer input needs recovery' : 'Plan Explorer needs your input' }}</strong><span class="agent-chip">{{ recoveryInput ? 'Recovery required' : (inputCardRequest.isBlocking ? 'Blocking' : 'Optional') }}</span></div>
            <p v-if="recoveryInput">The App Server connection ended before this answer was confirmed. No answer was retried automatically; restart the provider session and continue from this thread.</p>
            <p v-else>{{ inputCardRequest.questions.length }} structured question{{ inputCardRequest.questions.length === 1 ? '' : 's' }} are waiting before this turn can continue.</p>
          </div>
          <el-button v-if="pendingInput" type="primary" plain @click="openInputRequest">Answer</el-button>
        </article>
        <div class="timeline-marker"><span>THREAD READY FOR YOUR NEXT TURN</span></div>
        <template v-for="turn in turns" :key="turn.id">
          <article :id="`message-${turn.id}`" :data-nav-key="`message-${turn.id}`" :aria-busy="isExplorerTurnProcessing(turn) ? 'true' : undefined" :class="['message-card', turn.role === 'user' ? 'user-message' : 'assistant-message', turn.status === 'FAILED' ? 'failed-message' : '', isExplorerTurnProcessing(turn) ? 'processing-message' : '']"><div :class="['message-avatar', turn.role === 'user' ? 'user-avatar' : 'agent-avatar']">{{ turn.role === 'user' ? 'LS' : '' }}<span v-if="turn.role === 'assistant'" :class="['brand-dot', { 'brand-dot-processing': isExplorerTurnProcessing(turn) }]" /></div><div class="message-body"><div class="message-meta"><strong>{{ turn.role === 'user' ? 'You' : 'Plan Explorer' }}</strong><span v-if="turn.role === 'assistant'" :class="['agent-chip', { 'processing-chip': isExplorerTurnProcessing(turn) }]"><span v-if="isExplorerTurnProcessing(turn)" class="processing-dot" aria-hidden="true" />{{ turn.status === 'FAILED' ? 'Failed' : turn.status === 'WAITING_FOR_INPUT' ? 'Waiting for input' : turn.status === 'RUNNING' ? 'Running' : 'Read only' }}</span><span>{{ formatTurnTime(turn.createdAt) }}</span></div><p :aria-live="isExplorerTurnProcessing(turn) ? 'polite' : undefined">{{ turnContent(turn) }}<span v-if="isExplorerTurnProcessing(turn)" class="processing-dots" aria-hidden="true"><i /><i /><i /></span></p></div></article>
        </template>
      </div>
      <button v-if="showScrollToLatest" class="scroll-to-latest" type="button" aria-label="Scroll to latest message" title="Scroll to latest message" @click="jumpToLatest"><img class="scroll-to-latest-image" :src="scrollToLatestIcon" alt="" /></button>
      </div>
      <aside class="timeline-rail timeline-rail-plans" aria-label="Plan timeline">
        <div class="timeline-rail-heading"><span>PLANS</span><strong>{{ planTimelineItems.length }}</strong></div>
        <button v-for="item in planTimelineItems" :key="item.key" type="button" :class="['timeline-rail-item', { active: activeTimelineKey === item.key }]" :aria-current="activeTimelineKey === item.key ? 'location' : undefined" @click="jumpToTimelineTarget(item.target, item.key)"><span class="timeline-rail-marker"><i /></span><span class="timeline-rail-copy"><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span></button>
        <div v-if="!planTimelineItems.length" class="timeline-rail-empty">No generated plans yet.</div>
      </aside>
      </div>
      <div class="composer"><div class="composer-input"><textarea v-model="draft" :disabled="explorerPaused || busy" aria-label="Explorer message" placeholder="继续探索，或提出修改…" @keydown="handleComposerKeydown" /><span class="composer-mode">Plan Mode</span></div><div class="composer-footer"><div class="composer-metadata" aria-label="模型与上下文信息"><span class="composer-fact"><small>MODEL</small><strong>{{ explorerModel }}</strong></span><span class="composer-fact"><small>CONTEXT</small><strong>{{ contextUsage }}</strong><em>estimated</em></span><el-popover v-model:visible="statusOpen" placement="top-end" :width="330" trigger="click"><template #reference><button class="composer-status-trigger" type="button" aria-label="Status" :aria-expanded="statusOpen"><i aria-hidden="true" /><span>STATUS</span><InfoFilled :size="12" /></button></template><div class="codex-status-popover" role="dialog" aria-label="Codex usage status"><div class="codex-status-title"><InfoFilled :size="14" /><strong>状态</strong><button type="button" aria-label="关闭" @click="statusOpen = false">关闭</button></div><div class="codex-status-row"><span>模型：</span><strong>{{ explorerModel }}</strong></div><div class="codex-status-row"><span>会话/对话串：</span><code :title="thread?.id ?? 'thread-demo'">{{ conversationId }}</code></div><div class="codex-status-row"><span>背景信息：</span><strong>{{ contextUsage }}</strong><em>estimated</em></div><div class="codex-status-row"><span>5 小时限额：</span><strong>{{ rateLimits.fiveHour.remaining }}</strong><small>{{ rateLimits.fiveHour.reset }}</small></div><div class="codex-status-row"><span>7 天限额：</span><strong>{{ rateLimits.sevenDay.remaining }}</strong><small>{{ rateLimits.sevenDay.reset }}</small></div><p class="codex-status-note">当前服务未提供 Codex 速率限制遥测。</p></div></el-popover></div><span v-if="sendingTurn" class="composer-status" role="status" aria-live="polite">Message sent · waiting for Plan Explorer…</span><el-button class="composer-send" type="primary" circle :loading="busy" :disabled="!draft.trim() || explorerPaused || busy" aria-label="Send message" title="Send message" @click="sendTurn"><ArrowUp :size="18" /></el-button></div></div>
    </section>
    <aside class="context-panel"><div class="context-header"><div><div class="eyebrow">THREAD CONTEXT</div><h2>Working set</h2></div><el-button text circle aria-label="Refresh" @click="refreshThread"><Refresh :size="16" /></el-button></div><div class="context-section"><div class="context-section-title">CURRENT CANDIDATE <span>{{ candidateCount }}</span></div><div class="mini-plan" v-if="candidate" @click="drawerOpen = true"><div class="mini-plan-title"><span class="mini-icon"><Promotion :size="14" /></span><strong>{{ candidate.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="warning" effect="light">{{ statusLabel(candidate.status) }}</el-tag><span>Rev {{ candidate.revision }}</span></div><div class="mini-plan-link">View full plan <Right :size="13" /></div></div><div v-else class="context-empty compact"><CircleCheck :size="20" /><p>No candidate plan</p><small>Use Plan candidates to create a reviewable plan.</small></div></div><div class="context-section"><div class="context-section-title">DISPATCHED PLANS <span>{{ dispatched.length }}</span></div><div v-if="dispatched.length === 0" class="context-empty"><CircleCheck :size="20" /><p>No plans dispatched from this thread yet.</p><small>Confirmed plans will appear here and remain queryable even when the model is offline.</small></div><div v-else v-for="plan in dispatched" :key="plan.planId ?? plan.id" class="mini-plan dispatched"><div class="mini-plan-title"><span class="mini-icon success"><CircleCheck :size="14" /></span><strong>{{ plan.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="success" effect="light">{{ statusLabel(plan.status) }}</el-tag><span>Rev {{ plan.revision }}</span></div></div></div><div class="context-section context-memory"><div class="context-section-title">THREAD MEMORY</div><div class="memory-row"><span class="memory-icon">◎</span><div><strong>Context summary</strong><small>Updated just now</small></div><Right :size="14" /></div><div class="memory-row"><span class="memory-icon">↗</span><div><strong>Successor threads</strong><small>None yet</small></div><Right :size="14" /></div></div></aside>
    <PlanDetailDrawer v-model="drawerOpen" :plan="candidate" @confirm="confirmPlan" @enqueue="enqueuePlan" />
    <ExplorerInputDialog ref="inputDialog" v-model="inputDialogOpen" :request="pendingInput" @submit="submitInput" @cancel="cancelInput" />
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
        <div class="help-card" v-if="memoryPanel === 'summary'"><strong>Current ExplorerThread memory</strong><p>The thread keeps the project context, confirmed boundaries and recent exploration turns available to the Plan Explorer.</p><p class="memory-detail">Thread: {{ thread?.id ?? "thread-demo" }}<br />Messages: {{ thread?.messageCount ?? 0 }}<br />Last activity: {{ thread?.lastActivityAt ? new Date(thread.lastActivityAt).toLocaleString('zh-CN') : "—" }}</p></div>
        <div class="help-card" v-else><strong>No successor thread yet</strong><p>This ExplorerThread remains the active project thread. A successor will appear here when context compression creates one, while preserving the parent thread lineage.</p></div>
        <el-button type="primary" @click="closeMemoryPanel">Done <Right /></el-button>
      </div>
    </el-drawer>
  </div>
</template>
