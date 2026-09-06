<!--
  模块职责：展示 Execution Run、Executor 消息流、控制操作和执行日志。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowLeft, Check, CircleCheck, Clock, Document, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { AgentLoopStep, ExecutionTask, ExecutionThread, MergeRequest, PlanTask, Run, RunJournalEvent, ToolCall, VerificationRun } from "../types";
import { projectExecutionJournal, type ExecutionJournalEntry, type ExecutionStreamItem } from "../utils/executionStream";
import { executionTaskStatusLabel, executionTaskStatusType, executionTaskSummary, projectExecutionTasks, verificationSummary } from "../utils/executionTasks";
import { canPauseRun, canTerminateRun } from "../utils/runControls";
import { describeRunLoadError } from "../utils/runLoadError";
import { createProjectRequestScope } from "../utils/projectRoutes";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? ""));
const requestScope = createProjectRequestScope();
const run = ref<Run | null>(null);
const thread = ref<ExecutionThread | null>(null);
const verification = ref<VerificationRun | null>(null);
const mergeRequest = ref<MergeRequest | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionBusy = ref(false);
const guidance = ref("");
const sourceCommit = ref("");
const targetCommit = ref("");
const executorLoop = computed(() => run.value?.agentLoops?.find((loop) => loop.role === "executor") ?? null);
const executorSteps = ref<AgentLoopStep[]>([]);
const toolCalls = ref<ToolCall[]>([]);
const planTasks = ref<PlanTask[]>([]);
const executionMessages = ref<ExecutionStreamItem[]>([]);
const executionTimeline = ref<HTMLElement | null>(null);
const showScrollToLatest = ref(false);
const runStreamConnected = ref(false);
const executionStepsExpanded = ref(true);
const diagnosticsOpen = ref(false);
const selectedTaskId = ref<string | null>(null);
let runEventSource: EventSource | null = null;
let runEventSequence = 0;
// ExecutionThread journal 是持久化事实，conversation projection 只负责把事实转换为可读消息。
// sequence 同时作为 SSE 游标，重连时从最后一条已接受的事件继续回放。
const loopStatusLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[executorLoop.value?.state ?? ""] ?? "No loop");
const executionStatusLabel = computed(() => runStreamConnected.value ? "Live" : ["IN_PROGRESS", "STARTING"].includes(run.value?.status ?? "") ? "Reconnecting" : "Saved");
const displayedRunStatus = computed(() => mergeRequest.value?.status === "MERGED" ? "MERGED" : run.value?.status ?? "");
const executionBlockReason = computed(() => {
  for (const entry of [...(thread.value?.journal ?? [])].reverse()) {
    const reason = entry.payload.reason ?? entry.payload.error;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return null;
});
const executionTasks = computed<ExecutionTask[]>(() => projectExecutionTasks(planTasks.value, thread.value?.journal ?? [], run.value?.status ?? ""));
const executionTaskCounts = computed(() => executionTaskSummary(executionTasks.value));
const verificationStatusSummary = computed(() => verificationSummary(verification.value));

/** 用服务端 journal 重建执行对话，并更新 SSE 回放游标。 */
function setExecutionThread(next: ExecutionThread | null): void {
  thread.value = next;
  const journal = next?.journal ?? [];
  runEventSequence = Math.max(runEventSequence, ...journal.map((entry) => entry.sequence), 0);
  executionMessages.value = projectExecutionJournal(journal, next?.state ?? run.value?.status ?? "ACTIVE");
}

function isAtExecutionLatest(): boolean {
  const element = executionTimeline.value;
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

function updateExecutionScrollState(): void {
  showScrollToLatest.value = !isAtExecutionLatest();
}

function scrollExecutionToLatest(): void {
  void nextTick(() => {
    const element = executionTimeline.value;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    showScrollToLatest.value = false;
  });
}

function focusExecutionTask(task: ExecutionTask): void {
  selectedTaskId.value = task.id;
  if (!task.evidenceSequence) return;
  void nextTick(() => {
    const target = executionTimeline.value?.querySelector<HTMLElement>(`[data-sequence="${task.evidenceSequence}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

/** 接收单条 Run SSE；重复 sequence 直接忽略，避免重连导致消息重复。 */
function appendRunJournalEvent(event: RunJournalEvent): void {
  if (!thread.value || event.sequence <= runEventSequence) return;
  const shouldFollow = isAtExecutionLatest();
  const entry: ExecutionJournalEntry = { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt, payload: event.payload };
  thread.value = { ...thread.value, state: event.threadState ?? thread.value.state, journal: [...thread.value.journal, entry] };
  runEventSequence = event.sequence;
  if (event.runStatus && run.value) run.value = { ...run.value, status: event.runStatus };
  executionMessages.value = projectExecutionJournal(thread.value.journal, thread.value.state);
  if (event.runStatus && ["BLOCKED", "CANCELLED", "MERGE_READY", "MERGED"].includes(event.runStatus)) closeRunEvents();
  if (shouldFollow) scrollExecutionToLatest();
  else showScrollToLatest.value = true;
}

/** 仅为仍可能产生事实的 Run 建立 SSE；终态 Run 依赖已加载的持久化 journal。 */
function connectRunEvents(): void {
  if (!run.value || typeof EventSource === "undefined" || ["BLOCKED", "CANCELLED", "MERGE_READY", "MERGED"].includes(run.value.status)) return;
  runEventSource?.close();
  runEventSource = new EventSource(api.runEventsUrl(run.value.id, runEventSequence));
  runEventSource.addEventListener("open", () => { runStreamConnected.value = true; });
  runEventSource.addEventListener("stream.ready", () => { runStreamConnected.value = true; });
  runEventSource.addEventListener("journal.entry", (raw) => {
    try { appendRunJournalEvent(JSON.parse((raw as MessageEvent).data) as RunJournalEvent); }
    catch { /* The next reconnect will replay from the last accepted sequence. */ }
  });
  runEventSource.addEventListener("error", () => { runStreamConnected.value = false; });
}

/** 清理 EventSource 和连接状态，避免离开页面后继续轮询服务端。 */
function closeRunEvents(): void {
  runEventSource?.close();
  runEventSource = null;
  runStreamConnected.value = false;
}
async function load() {
  const requestRunId = String(route.params.runId ?? "");
  const requestProjectId = projectId.value;
  const requestToken = requestScope.begin(`${requestProjectId}:${requestRunId}`);
  loading.value = true;
  error.value = null;
  try {
    try {
      const report = await api.reconcileProjectMerges(requestProjectId);
      const diagnostic = report.items.find((item) => item.runId === requestRunId && item.reason);
      if (diagnostic?.reason) ElMessage.warning(`Merge 状态检测：${diagnostic.reason}`);
    }
    catch (caught) { ElMessage.warning(`Merge 状态检测失败，已展示最近保存的状态：${caught instanceof Error ? caught.message : "暂不可用"}`); }
    const response = await api.getRun(requestRunId);
    if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
    run.value = response.run;
    setExecutionThread(response.executionThread);
    verification.value = response.verification;
    mergeRequest.value = response.mergeRequest;
    planTasks.value = [];
    try {
      const revisionResponse = await api.getPlanRevision(response.run.planId, response.run.planRevision);
      if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
      planTasks.value = revisionResponse.revision.resolvedContract?.tasks ?? revisionResponse.revision.contract?.tasks ?? [];
    } catch (caught) { error.value = describeRunLoadError(caught, "plan-revision"); }
    const loopId = response.run.agentLoops?.[0]?.id;
    executorSteps.value = [];
    toolCalls.value = [];
    if (loopId) {
      try {
        const [stepsResponse, toolsResponse] = await Promise.all([api.agentLoopSteps(loopId), api.agentLoopTools(loopId)]);
        if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
        executorSteps.value = stepsResponse.items;
        toolCalls.value = toolsResponse.items;
      } catch (caught) { error.value = describeRunLoadError(caught, "agent-loop"); }
    }
    sourceCommit.value = response.mergeRequest?.sourceCommit ?? response.run.baseCommit;
    // Reconciliation is the source of truth for the confirmation input. Reset it
    // on every load so switching runs or refreshing cannot retain another run's SHA.
    targetCommit.value = response.mergeRequest?.detectedTargetCommit ?? response.run.baseCommit;
  } catch (caught) {
    if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) error.value = describeRunLoadError(caught, "run");
  }
  finally { if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) loading.value = false; }
}
function label(status: string) { return ({ STARTING: "Starting", IN_PROGRESS: "Running", READY_FOR_VERIFY: "Ready for verification", VERIFYING: "Verifying", MERGE_READY: "Ready for review", MERGED: "Merged", NEEDS_PLAN_CHANGE: "Plan change required", RECOVERING: "Recovering", BLOCKED: "Blocked", CANCELLED: "Cancelled" } as Record<string, string>)[status] ?? status; }
function notifyError(caught: unknown) { error.value = caught instanceof Error ? caught.message : "操作失败，请稍后重试"; }
async function controlExecutorLoop(action: "pause" | "resume" | "cancel") {
  if (!executorLoop.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    if (action === "pause") await api.pauseAgentLoop(executorLoop.value.id, "user_requested");
    if (action === "resume") await api.resumeAgentLoop(executorLoop.value.id);
    if (action === "cancel") await api.cancelAgentLoop(executorLoop.value.id, "user_requested");
    await load();
  } catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function togglePause() {
  if (!run.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const response = thread.value?.state === "PAUSED" ? await api.resumeRun(run.value.id) : await api.pauseRun(run.value.id);
    run.value = response.run;
    setExecutionThread(response.thread);
  } catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
/** 终止前要求二次确认；服务端会同步取消关联 AgentLoop 并执行 cleanup。 */
async function terminateRun() {
  if (!run.value || actionBusy.value || !canTerminateRun(run.value.status)) return;
  try {
    await ElMessageBox.confirm("Terminate this run? The confirmed Plan will remain in history.", "Terminate run", { confirmButtonText: "Terminate", cancelButtonText: "Keep running", type: "warning" });
  } catch { return; }
  actionBusy.value = true;
  try {
    await api.cancelRun(run.value.id, "user_requested");
    ElMessage.success("Run 已终止");
    await router.push(`/projects/${String(route.params.projectId)}/plans`);
  } catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function sendGuidance() {
  if (!run.value || !guidance.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { setExecutionThread((await api.addRunGuidance(run.value.id, guidance.value.trim())).thread); guidance.value = ""; ElMessage.success("已写入执行线程"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
/** 触发脱离模型会话的确定性验证，结果落入 VerificationRun 后再更新页面。 */
async function verifyRun() {
  if (!run.value || actionBusy.value) return;
  actionBusy.value = true;
  try { verification.value = (await api.verifyRun(run.value.id)).verification; await load(); ElMessage.success("验证完成"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function createReview() {
  if (!run.value || !sourceCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { mergeRequest.value = (await api.createMergeRequest(run.value.id, sourceCommit.value.trim())).mergeRequest; await load(); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function confirmMerged() {
  if (!mergeRequest.value || !targetCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { mergeRequest.value = (await api.confirmMerged(mergeRequest.value.id, targetCommit.value.trim())).mergeRequest; await load(); ElMessage.success("已确认合并到目标 Commit"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
  watch([projectId, () => route.params.runId], () => { closeRunEvents(); void load().then(() => { if (run.value) connectRunEvents(); }); });
  onMounted(async () => { await load(); connectRunEvents(); scrollExecutionToLatest(); });
  onBeforeUnmount(() => { requestScope.invalidate(); closeRunEvents(); });
</script>

<template>
  <div class="detail-page" v-loading="loading">
    <div class="detail-top"><el-button text @click="router.push(`/projects/${String(route.params.projectId)}/plans`)"><ArrowLeft :size="15" /> Back</el-button><span class="eyebrow">EXECUTION THREAD</span></div>
    <div v-if="error" class="demo-notice"><Warning :size="14" /> {{ error }}</div>
    <template v-if="run">
      <div class="detail-heading"><div><div class="eyebrow">RUN · {{ run.id }}</div><h1>Execution run</h1><p>Plan <code>{{ run.planId }}</code> · Revision {{ run.planRevision }} · <code>{{ run.branch }}</code></p></div><el-tag :type="displayedRunStatus === 'BLOCKED' ? 'danger' : displayedRunStatus === 'MERGE_READY' ? 'warning' : displayedRunStatus === 'MERGED' ? 'success' : 'warning'" effect="light">{{ label(displayedRunStatus) }}</el-tag></div>
      <div class="run-facts"><div><span>WORKSPACE</span><code>{{ run.workspacePath ?? "Not created" }}</code></div><div><span>BASE COMMIT</span><code>{{ run.baseCommit }}</code></div><div><span>THREAD</span><code>{{ run.executionThreadId }}</code></div><div><span>STARTED</span><strong>{{ run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : "—" }}</strong></div></div>
      <section v-if="executionTasks.length" class="execution-steps-panel" aria-labelledby="execution-steps-heading">
        <div class="execution-steps-heading">
          <div>
            <div class="eyebrow">EXECUTION STEPS</div>
            <h2 id="execution-steps-heading">Plan progress</h2>
            <p>{{ executionTaskCounts.completed }} of {{ executionTaskCounts.total }} tasks completed<span v-if="executionTaskCounts.blocked"> · {{ executionTaskCounts.blocked }} blocked</span></p>
          </div>
          <el-button text size="small" :aria-expanded="executionStepsExpanded" @click="executionStepsExpanded = !executionStepsExpanded">{{ executionStepsExpanded ? 'Collapse' : 'Expand' }}</el-button>
        </div>
        <div v-show="executionStepsExpanded" class="execution-progress-track" aria-hidden="true"><span :style="{ width: `${executionTaskCounts.total ? Math.round((executionTaskCounts.completed / executionTaskCounts.total) * 100) : 0}%` }" /></div>
        <div v-show="executionStepsExpanded" class="execution-task-list">
          <button v-for="task in executionTasks" :key="task.id" type="button" :class="['execution-task', `execution-task-${task.status.toLowerCase()}`, { selected: selectedTaskId === task.id }]" :aria-label="`${task.title}, ${executionTaskStatusLabel(task.status)}`" @click="focusExecutionTask(task)">
            <span class="execution-task-marker"><CircleCheck v-if="task.status === 'DONE'" :size="14" /><Warning v-else-if="task.status === 'BLOCKED'" :size="14" /><span v-else-if="task.status === 'IN_PROGRESS'" class="execution-task-pulse" /><span v-else class="execution-task-number">{{ executionTasks.indexOf(task) + 1 }}</span></span>
            <span class="execution-task-copy"><strong>{{ task.title }}</strong><small v-if="task.status === 'BLOCKED' && task.blockedReason">{{ task.blockedReason }}</small><small v-else-if="task.dependencies.length && task.status === 'PENDING'">Waiting for {{ task.dependencies.length }} prerequisite(s)</small></span>
            <el-tag size="small" effect="light" :type="executionTaskStatusType(task.status)">{{ executionTaskStatusLabel(task.status) }}</el-tag>
          </button>
        </div>
        <div v-if="verificationStatusSummary" class="execution-steps-evidence"><span class="execution-evidence-dot" :class="{ failed: verification?.status === 'FAILED' || verification?.status === 'BLOCKED' }" /> {{ verificationStatusSummary }}</div>
      </section>
      <section v-if="executorLoop" class="agent-loop-detail"><div><div class="eyebrow">EXECUTOR AGENT LOOP</div><h2>{{ loopStatusLabel }}</h2><p>Provider-controlled · {{ executorLoop.mode }} · {{ executorLoop.stepCount }} / {{ executorLoop.maxSteps }} loop steps</p><div v-if="executorSteps.length" class="loop-step-list"><span v-for="step in executorSteps.slice(-4)" :key="`${step.loopId}-${step.sequence}`" class="loop-step"><strong>#{{ step.sequence }}</strong> {{ step.stepType }}</span></div></div><div class="loop-detail-actions"><el-button v-if="executorLoop.state === 'RUNNING'" size="small" @click="controlExecutorLoop('pause')"><VideoPause :size="14" /> Pause loop</el-button><el-button v-if="executorLoop.state === 'PAUSED'" size="small" @click="controlExecutorLoop('resume')"><VideoPlay :size="14" /> Resume loop</el-button><el-button v-if="['RUNNING', 'PAUSED', 'RECOVERING', 'WAITING_FOR_INPUT'].includes(executorLoop.state)" size="small" type="danger" plain @click="controlExecutorLoop('cancel')">Cancel loop</el-button></div></section>
      <div v-if="run.status === 'BLOCKED' && executionBlockReason" class="run-blocked-notice" role="alert"><Warning :size="16" /><div><strong>Why execution stopped</strong><span>{{ executionBlockReason }}</span></div></div>
      <section class="execution-conversation-panel">
        <div class="journal-heading"><div><div class="eyebrow">EXECUTION CONVERSATION</div><h2>What the Executor is doing</h2></div><div class="execution-stream-status" role="status"><i :class="{ connected: runStreamConnected }" /> {{ executionStatusLabel }}</div></div>
        <div ref="executionTimeline" class="execution-conversation" @scroll="updateExecutionScrollState">
          <div v-if="!executionMessages.length" class="empty-state"><Document :size="28" /><h3>Waiting for executor activity</h3><p>The execution conversation will appear here when the Run starts.</p></div>
          <article v-for="item in executionMessages" :key="item.id" :data-sequence="item.sequence" :class="['execution-message', `execution-message-${item.kind}`, { failed: item.status === 'FAILED', waiting: item.status === 'WAITING', running: item.status === 'RUNNING' }]">
            <div class="execution-message-avatar">{{ item.role === 'user' ? 'LS' : item.kind === 'model' ? 'EX' : '·' }}</div>
            <div class="execution-message-body">
              <div class="execution-message-meta"><strong>{{ item.title }}</strong><span v-if="item.status !== 'INFO'" class="agent-chip">{{ item.status }}</span><span v-if="item.repetitionCount && item.repetitionCount > 1">×{{ item.repetitionCount }} updates</span><span>{{ new Date(item.occurredAt).toLocaleTimeString('zh-CN') }}</span></div>
              <p v-if="item.kind === 'model' || item.kind === 'guidance'" :aria-live="item.status === 'RUNNING' ? 'polite' : undefined">{{ item.content }}<span v-if="item.status === 'RUNNING'" class="processing-dots" aria-hidden="true"><i /><i /><i /></span></p>
              <p v-else class="execution-activity-detail">{{ item.detail }}</p>
            </div>
          </article>
        </div>
        <el-button v-if="showScrollToLatest" class="execution-scroll-latest" size="small" @click="scrollExecutionToLatest">Jump to latest</el-button>
      </section>
      <section class="run-actions">
        <div class="action-toolbar">
          <div><div class="eyebrow">RUN CONTROL</div><h2>Execution controls</h2><p>Controls append facts to the ExecutionThread; they do not change the confirmed PlanRevision.</p></div>
          <div class="action-buttons"><el-button v-if="canTerminateRun(run.status)" type="danger" plain :loading="actionBusy" @click="terminateRun">Terminate run</el-button><el-button v-if="canPauseRun(run.status, thread?.state ?? '')" :loading="actionBusy" @click="togglePause"><VideoPlay v-if="thread?.state === 'PAUSED'" :size="14" /><VideoPause v-else :size="14" /> {{ thread?.state === 'PAUSED' ? 'Resume' : 'Pause' }}</el-button><el-button v-if="run.status === 'IN_PROGRESS' || run.status === 'READY_FOR_VERIFY'" type="primary" :loading="actionBusy" @click="verifyRun"><Check :size="14" /> Run verification</el-button></div>
        </div>
        <div v-if="run.status === 'IN_PROGRESS' || run.status === 'READY_FOR_VERIFY'" class="guidance-row"><el-input v-model="guidance" size="small" aria-label="User guidance" placeholder="Add in-scope guidance to the execution thread…" @keyup.enter="sendGuidance" /><el-button size="small" :disabled="!guidance.trim()" :loading="actionBusy" @click="sendGuidance">Add guidance</el-button></div>
      </section>
      <section v-if="verification || run.status === 'MERGE_READY'" class="evidence-card"><div class="evidence-heading"><div><div class="eyebrow">VERIFICATION RUN</div><h2>Deterministic checks</h2></div><el-tag :type="verification?.status === 'PASSED' ? 'success' : 'danger'" effect="light">{{ verification?.status ?? 'Not recorded' }}</el-tag></div><div v-if="verification" class="verification-summary"><span>{{ verification.commandResults.length }} command(s)</span><span>Repair attempts {{ verification.repairAttempts }}</span><span>{{ new Date(verification.completedAt).toLocaleString('zh-CN') }}</span></div><div v-if="verification?.commandResults.length" class="command-results"><div v-for="command in verification.commandResults" :key="command.commandId" class="command-result"><code>{{ command.commandId }}</code><span :class="command.result.exitCode === 0 ? 'result-pass' : 'result-fail'">exit {{ command.result.exitCode }}</span></div></div><div v-if="run.status === 'MERGE_READY' && !mergeRequest" class="review-form"><el-input v-model="sourceCommit" size="small" aria-label="Reviewed source commit" placeholder="Reviewed source commit" /><el-button type="primary" size="small" :loading="actionBusy" @click="createReview">Create review</el-button></div></section>
      <section v-if="mergeRequest" class="evidence-card merge-card"><div class="evidence-heading"><div><div class="eyebrow">MERGE REQUEST · {{ mergeRequest.id }}</div><h2>Human merge confirmation</h2></div><el-tag :type="mergeRequest.status === 'MERGED' ? 'success' : 'warning'" effect="light">{{ mergeRequest.status }}</el-tag></div><div class="verification-summary"><span>Source <code>{{ mergeRequest.sourceCommit }}</code></span><span>Target <code>{{ mergeRequest.targetBranch }}</code></span><span v-if="mergeRequest.detectedTargetCommit">Detected <code>{{ mergeRequest.detectedTargetCommit }}</code></span></div><p v-if="mergeRequest.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="merge-detected-banner"><strong>Merge detected</strong> · 已检测到目标分支包含 source commit；请确认后将 Plan 更新为 MERGED。</p><div v-if="mergeRequest.status === 'OPEN'" class="review-form"><el-input v-model="targetCommit" size="small" aria-label="Target commit" placeholder="Actual target commit after manual merge" /><el-button type="primary" size="small" :loading="actionBusy" @click="confirmMerged">Confirm merged</el-button></div></section>
      <section class="diagnostics-teaser"><div><div class="eyebrow">EXECUTION DIAGNOSTICS</div><h2>Audit trail</h2><p>{{ thread?.journal.length ?? 0 }} journal entries · {{ toolCalls.length }} tool calls · raw payloads available on demand</p></div><el-button size="small" @click="diagnosticsOpen = true">Open diagnostics</el-button></section>
    </template>
    <el-drawer v-model="diagnosticsOpen" title="Execution diagnostics" size="min(760px, 92vw)">
      <div class="diagnostic-drawer-summary"><span>{{ thread?.journal.length ?? 0 }} journal entries</span><span>{{ toolCalls.length }} tool calls</span><span>{{ executorLoop?.stepCount ?? 0 }} loop steps</span></div>
      <section class="diagnostic-section"><div class="journal-heading"><div><div class="eyebrow">EXECUTION JOURNAL</div><h2>What happened</h2></div></div><div v-if="thread?.journal.length" class="journal-list"><div v-for="entry in thread.journal" :key="entry.sequence" class="journal-entry"><div class="journal-icon" :class="{ success: entry.type.includes('COMPLETED') || entry.type === 'COMMIT', warning: entry.type.includes('FAILED') }"><CircleCheck v-if="entry.type.includes('COMPLETED') || entry.type === 'COMMIT'" :size="15" /><Warning v-else-if="entry.type.includes('FAILED')" :size="15" /><Clock v-else :size="15" /></div><div><div class="journal-meta"><strong>{{ entry.type }}</strong><span>#{{ entry.sequence }}</span><span>{{ new Date(entry.occurredAt).toLocaleTimeString('zh-CN') }}</span></div><p>{{ JSON.stringify(entry.payload) }}</p></div></div></div><div v-else class="empty-state"><Document :size="28" /><h3>No journal entries</h3><p>The execution thread has not recorded activity yet.</p></div></section>
      <section v-if="toolCalls.length" class="diagnostic-section"><div class="journal-heading"><div><div class="eyebrow">TOOL CALLS</div><h2>Audited tool activity</h2></div><span>{{ toolCalls.length }} calls</span></div><div class="journal-list"><div v-for="tool in toolCalls" :key="tool.callId" class="journal-entry"><div class="journal-icon" :class="{ success: tool.status === 'SUCCEEDED', warning: tool.status === 'FAILED' || tool.status === 'DENIED' || tool.status === 'UNKNOWN' || tool.status === 'NEEDS_RECONCILIATION' }"><CircleCheck v-if="tool.status === 'SUCCEEDED'" :size="15" /><Warning v-else-if="tool.status === 'FAILED' || tool.status === 'DENIED' || tool.status === 'UNKNOWN' || tool.status === 'NEEDS_RECONCILIATION'" :size="15" /><Clock v-else :size="15" /></div><div><div class="journal-meta"><strong>{{ tool.tool }}</strong><span>{{ tool.status }}</span><span>{{ new Date(tool.startedAt).toLocaleTimeString('zh-CN') }}</span></div><p>{{ tool.result ? JSON.stringify(tool.result) : 'No result yet' }}</p></div></div></div></section>
    </el-drawer>
  </div>
</template>
