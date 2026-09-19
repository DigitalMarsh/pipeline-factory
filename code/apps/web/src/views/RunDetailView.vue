<!--
  模块职责：展示 Execution Run、Executor 消息流、控制操作和执行日志。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowLeft, CircleCheck, Clock, Document, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import ExecutionHeaderStatus from "../components/ExecutionHeaderStatus.vue";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import { api } from "../api";
import MarkdownMessage from "../components/MarkdownMessage.vue";
import type { AgentLoopStep, ExecutionTask, ExecutionThread, MergeRequest, Plan, PlanTask, Run, RunJournalEvent, ToolCall, VerificationRun } from "../types";
import { projectExecutionJournal, type ExecutionJournalEntry, type ExecutionStreamItem } from "../utils/executionStream";
import { formatExecutionDuration, formatTokenSummary, telemetryModel, telemetryReasoning, usageDetailRows } from "../utils/executionTelemetry";
import { executionTaskSummary, projectExecutionTasks } from "../utils/executionTasks";
import { canTerminateRun } from "../utils/runControls";
import { describeRunLoadError } from "../utils/runLoadError";
import { createProjectRequestScope } from "../utils/projectRoutes";

const route = useRoute();
const router = useRouter();
const props = withDefaults(defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>(), { embedded: false });
const emit = defineEmits<{ (event: "close"): void }>();
const embedded = computed(() => props.embedded);
const projectId = computed(() => props.projectId ?? String(route.params.projectId ?? ""));
const runId = computed(() => props.runId ?? String(route.params.runId ?? ""));
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
const diagnosticsOpen = ref(false);
const planDetailOpen = ref(false);
const planDetail = ref<Plan | null>(null);
const planDetailRevisions = ref<number[]>([]);
const planDetailError = ref<string | null>(null);
const selectedTaskId = ref<string | null>(null);
const telemetryNow = ref(Date.now());
let runEventSource: EventSource | null = null;
let runEventSequence = 0;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let planDetailRequestToken = 0;
// ExecutionThread journal 是持久化事实，conversation projection 只负责把事实转换为可读消息。
// sequence 同时作为 SSE 游标，重连时从最后一条已接受的事件继续回放。
const loopStatusLabel = computed(() => ({ CREATED: "Created", RUNNING: "Running", WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", RECOVERING: "Recovery required", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", NEEDS_RECONCILIATION: "Needs reconciliation" } as Record<string, string>)[executorLoop.value?.state ?? ""] ?? "No loop");
const executionStatusLabel = computed(() => runStreamConnected.value ? "Live" : ["IN_PROGRESS", "STARTING"].includes(run.value?.status ?? "") ? "Reconnecting" : "Saved");
const executionBlockReason = computed(() => {
  for (const entry of [...(thread.value?.journal ?? [])].reverse()) {
    const reason = entry.payload.reason ?? entry.payload.error;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return null;
});
const executionTasks = computed<ExecutionTask[]>(() => projectExecutionTasks(planTasks.value, thread.value?.journal ?? [], run.value?.status ?? ""));
const executionTaskCounts = computed(() => executionTaskSummary(executionTasks.value));
const executionTelemetry = computed(() => thread.value?.telemetry ?? null);
const executionDuration = computed(() => formatExecutionDuration(executionTelemetry.value, telemetryNow.value));
const executionTokenSummary = computed(() => formatTokenSummary(executionTelemetry.value?.usage));
const executionTelemetryModel = computed(() => telemetryModel(executionTelemetry.value));
const executionTelemetryReasoning = computed(() => telemetryReasoning(executionTelemetry.value));
const executionUsageRows = computed(() => usageDetailRows(executionTelemetry.value?.usage));

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

function resetPlanDetail(): void {
  planDetailRequestToken += 1;
  planDetailOpen.value = false;
  planDetail.value = null;
  planDetailRevisions.value = [];
  planDetailError.value = null;
}

async function openPlanDetail(): Promise<void> {
  const currentRun = run.value;
  if (!currentRun) return;
  const requestToken = ++planDetailRequestToken;
  planDetailOpen.value = true;
  planDetail.value = null;
  planDetailRevisions.value = [];
  planDetailError.value = null;
  try {
    const [detailResponse, historyResponse, revisionResponse] = await Promise.all([
      api.getPlan(currentRun.planId),
      api.planRevisions(currentRun.planId),
      api.getPlanRevision(currentRun.planId, currentRun.planRevision),
    ]);
    if (requestToken !== planDetailRequestToken) return;
    const resolvedContract = revisionResponse.revision.resolvedContract ?? detailResponse.revision?.resolvedContract ?? detailResponse.plan.resolvedContract;
    const contract = revisionResponse.revision.contract ?? detailResponse.plan.contract;
    const revisions = historyResponse.items.map((item) => item.revision);
    planDetailRevisions.value = Array.from(new Set([...revisions, currentRun.planRevision])).sort((left, right) => left - right);
    planDetail.value = {
      ...detailResponse.plan,
      revision: revisionResponse.revision.revision,
      ...(contract ? { contract } : {}),
      ...(resolvedContract ? { resolvedContract } : {}),
      dispatch: detailResponse.dispatch,
      mergeRequest: detailResponse.mergeRequest ?? mergeRequest.value,
      runId: currentRun.id,
    };
  } catch (caught) {
    if (requestToken !== planDetailRequestToken) return;
    planDetailError.value = caught instanceof Error ? `无法加载完整 Plan：${caught.message}` : "无法加载完整 Plan";
  }
}

async function selectPlanRevision(revisionNumber: number): Promise<void> {
  const currentPlan = planDetail.value;
  const planId = currentPlan?.id ?? currentPlan?.planId;
  if (!currentPlan || !planId || currentPlan.revision === revisionNumber) return;
  try {
    const response = await api.getPlanRevision(planId, revisionNumber);
    if (!planDetailOpen.value || planDetail.value !== currentPlan) return;
    planDetail.value = {
      ...currentPlan,
      revision: response.revision.revision,
      ...(response.revision.contract ? { contract: response.revision.contract } : {}),
      ...(response.revision.resolvedContract ? { resolvedContract: response.revision.resolvedContract } : {}),
    };
    planDetailError.value = null;
  } catch (caught) {
    planDetailError.value = caught instanceof Error ? `无法加载 V${revisionNumber}：${caught.message}` : `无法加载 V${revisionNumber}`;
  }
}

/** 接收单条 Run SSE；重复 sequence 直接忽略，避免重连导致消息重复。 */
function appendRunJournalEvent(event: RunJournalEvent): void {
  const currentThread = thread.value;
  if (!currentThread || event.sequence <= runEventSequence) return;
  const shouldFollow = isAtExecutionLatest();
  const entry: ExecutionJournalEntry = { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt, payload: event.payload };
  const nextThread: ExecutionThread = { ...currentThread, state: event.threadState ?? currentThread.state, journal: [...currentThread.journal, entry], ...(event.threadTelemetry === undefined ? {} : { telemetry: event.threadTelemetry }) };
  thread.value = nextThread;
  runEventSequence = event.sequence;
  if (event.runStatus && run.value) run.value = { ...run.value, status: event.runStatus };
  executionMessages.value = projectExecutionJournal(nextThread.journal, nextThread.state);
  if (event.runStatus && ["BLOCKED", "CANCELLED", "MERGE_READY", "MERGED"].includes(event.runStatus)) closeRunEvents();
  if (shouldFollow) scrollExecutionToLatest();
  else showScrollToLatest.value = true;
}

function applyStreamTelemetry(event: { threadTelemetry?: ExecutionThread["telemetry"] }): void {
  if (!thread.value || event.threadTelemetry === undefined) return;
  thread.value = { ...thread.value, telemetry: event.threadTelemetry };
}

/** 仅为仍可能产生事实的 Run 建立 SSE；终态 Run 依赖已加载的持久化 journal。 */
function connectRunEvents(): void {
  if (!run.value || typeof EventSource === "undefined" || ["BLOCKED", "CANCELLED", "MERGE_READY", "MERGED"].includes(run.value.status)) return;
  runEventSource?.close();
  runEventSource = new EventSource(api.runEventsUrl(run.value.id, runEventSequence));
  runEventSource.addEventListener("open", () => { runStreamConnected.value = true; });
  runEventSource.addEventListener("stream.ready", (raw) => { runStreamConnected.value = true; try { applyStreamTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] }); } catch { /* Initial GET remains the source of truth. */ } });
  runEventSource.addEventListener("telemetry.updated", (raw) => { try { applyStreamTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] }); } catch { /* The next poll or reconnect will recover the latest snapshot. */ } });
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
  const requestRunId = runId.value;
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
    if (embedded.value) await load();
    else await router.push(`/projects/${projectId.value}/plans`);
  } catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
function closeView(): void {
  if (embedded.value) {
    emit("close");
    return;
  }
  void router.push({ path: `/projects/${projectId.value}/explorer`, query: { explorerId: route.query.explorerId, explorerPlanId: route.query.explorerPlanId, contextPanel: "plan-center" } });
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
type RunControlAction = "terminate" | "pause" | "resume" | "verify";
type LoopControlAction = "pause" | "resume" | "cancel";
async function handleRunAction(action: RunControlAction): Promise<void> {
  if (action === "terminate") await terminateRun();
  if (action === "pause" || action === "resume") await togglePause();
  if (action === "verify") await verifyRun();
}
async function handleLoopAction(action: LoopControlAction): Promise<void> {
  await controlExecutorLoop(action);
}
function updateSourceCommit(value: string): void {
  sourceCommit.value = value;
}
function updateTargetCommit(value: string): void {
  targetCommit.value = value;
}
watch([projectId, runId], () => { resetPlanDetail(); closeRunEvents(); void load().then(() => { if (run.value) connectRunEvents(); }); });
  onMounted(async () => { telemetryTimer = setInterval(() => { if (executionTelemetry.value?.completedAt === null || executionTelemetry.value?.durationMs === null) telemetryNow.value = Date.now(); }, 1000); await load(); connectRunEvents(); scrollExecutionToLatest(); });
  onBeforeUnmount(() => { requestScope.invalidate(); closeRunEvents(); if (telemetryTimer) clearInterval(telemetryTimer); });
</script>

<template>
  <div :class="['detail-page', { 'detail-page-embedded': embedded }]" v-loading="loading">
    <div v-if="!embedded" class="detail-top"><el-button text @click="closeView"><ArrowLeft :size="15" /> Back</el-button></div>
    <div v-if="error" class="demo-notice"><Warning :size="14" /> {{ error }}</div>
    <template v-if="run">
      <div class="detail-heading">
        <div class="detail-heading-title">
          <h1>Execution run</h1>
        </div>
        <div class="detail-heading-plan">
          <p class="execution-plan-link-row"><span>Plan</span><button type="button" class="execution-plan-link" :aria-label="`查看 Plan ${run.planId} Revision ${run.planRevision} 详情`" @click="openPlanDetail"><code>{{ run.planId }}</code><span>· Revision {{ run.planRevision }}</span></button></p>
        </div>
        <ExecutionHeaderStatus
          :run="run"
          :thread-state="thread?.state ?? ''"
          :telemetry="executionTelemetry"
          :telemetry-now="telemetryNow"
          :tasks="executionTasks"
          :task-counts="executionTaskCounts"
          :selected-task-id="selectedTaskId"
          :executor-loop="executorLoop"
          :executor-steps="executorSteps"
          :loop-status-label="loopStatusLabel"
          :verification="verification"
          :merge-request="mergeRequest"
          :action-busy="actionBusy"
          :source-commit="sourceCommit"
          :target-commit="targetCommit"
          :diagnostics-count="{ journal: thread?.journal.length ?? 0, tools: toolCalls.length, steps: executorSteps.length }"
          @focus-task="focusExecutionTask"
          @run-action="handleRunAction"
          @loop-action="handleLoopAction"
          @create-review="createReview"
          @confirm-merged="confirmMerged"
          @open-plan="openPlanDetail"
          @open-diagnostics="diagnosticsOpen = true"
          @update:source-commit="updateSourceCommit"
          @update:target-commit="updateTargetCommit"
        />
      </div>
      <div v-if="run.status === 'BLOCKED' && executionBlockReason" class="run-blocked-notice" role="alert"><Warning :size="16" /><div><strong>Why execution stopped</strong><span>{{ executionBlockReason }}</span></div></div>
      <section class="execution-conversation-panel">
        <div class="journal-heading"><div><div class="eyebrow">EXECUTION CONVERSATION</div><h2>What the Executor is doing</h2></div><div class="execution-stream-status" role="status"><i :class="{ connected: runStreamConnected }" /> {{ executionStatusLabel }}</div></div>
        <div ref="executionTimeline" class="execution-conversation" @scroll="updateExecutionScrollState">
          <div v-if="!executionMessages.length" class="empty-state"><Document :size="28" /><h3>Waiting for executor activity</h3><p>The execution conversation will appear here when the Run starts.</p></div>
          <article v-for="item in executionMessages" :key="item.id" :data-sequence="item.sequence" :class="['execution-message', `execution-message-${item.kind}`, { failed: item.status === 'FAILED', waiting: item.status === 'WAITING', running: item.status === 'RUNNING' }]">
            <div class="execution-message-avatar">{{ item.role === 'user' ? 'LS' : item.kind === 'model' ? 'EX' : '·' }}</div>
            <div class="execution-message-body">
              <div class="execution-message-meta"><strong>{{ item.title }}</strong><span v-if="item.status !== 'INFO'" class="agent-chip">{{ item.status }}</span><span v-if="item.repetitionCount && item.repetitionCount > 1">×{{ item.repetitionCount }} updates</span><span>{{ new Date(item.occurredAt).toLocaleTimeString('zh-CN') }}</span></div>
              <MarkdownMessage v-if="item.kind === 'model' || item.kind === 'guidance'" :source="item.content" :streaming="item.status === 'RUNNING'" />
              <p v-else class="execution-activity-detail">{{ item.detail }}</p>
            </div>
          </article>
        </div>
        <el-button v-if="showScrollToLatest" class="execution-scroll-latest" size="small" @click="scrollExecutionToLatest">Jump to latest</el-button>
        <div v-if="run.status === 'IN_PROGRESS' || run.status === 'READY_FOR_VERIFY'" class="guidance-row execution-guidance-row"><el-input v-model="guidance" size="small" aria-label="User guidance" placeholder="Add in-scope guidance to the execution thread…" @keyup.enter="sendGuidance" /><el-button size="small" :disabled="!guidance.trim()" :loading="actionBusy" @click="sendGuidance">Add guidance</el-button></div>
      </section>
    </template>
    <el-drawer v-model="diagnosticsOpen" title="Execution diagnostics" size="min(760px, 92vw)">
      <div class="diagnostic-drawer-summary"><span>{{ thread?.journal.length ?? 0 }} journal entries</span><span>{{ toolCalls.length }} tool calls</span><span>{{ executorLoop?.stepCount ?? 0 }} loop steps</span></div>
      <section class="diagnostic-section telemetry-diagnostic-section"><div class="journal-heading"><div><div class="eyebrow">EXECUTION TELEMETRY</div><h2>Provider usage detail</h2></div><span>{{ executionTelemetry?.usageSource === 'provider' ? 'Provider exact' : '未记录' }}</span></div><p class="telemetry-diagnostic-note">来源：{{ executionTelemetry?.usageSource === 'provider' ? 'Provider 返回的精确 usage，未做本地估算。' : 'Provider 未返回精确 usage；历史 Run 不补算 token。' }}</p><div class="telemetry-detail-grid"><div v-for="row in executionUsageRows" :key="row.label"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div></div><div class="telemetry-diagnostic-meta"><span>模型 <code>{{ executionTelemetryModel }}</code></span><span>推理等级 <code>{{ executionTelemetryReasoning }}</code></span><span>耗时 <code>{{ executionDuration }}</code></span></div></section>
      <section class="diagnostic-section"><div class="journal-heading"><div><div class="eyebrow">EXECUTION JOURNAL</div><h2>What happened</h2></div></div><div v-if="thread?.journal.length" class="journal-list"><div v-for="entry in thread.journal" :key="entry.sequence" class="journal-entry"><div class="journal-icon" :class="{ success: entry.type.includes('COMPLETED') || entry.type === 'COMMIT', warning: entry.type.includes('FAILED') }"><CircleCheck v-if="entry.type.includes('COMPLETED') || entry.type === 'COMMIT'" :size="15" /><Warning v-else-if="entry.type.includes('FAILED')" :size="15" /><Clock v-else :size="15" /></div><div><div class="journal-meta"><strong>{{ entry.type }}</strong><span>#{{ entry.sequence }}</span><span>{{ new Date(entry.occurredAt).toLocaleTimeString('zh-CN') }}</span></div><p>{{ JSON.stringify(entry.payload) }}</p></div></div></div><div v-else class="empty-state"><Document :size="28" /><h3>No journal entries</h3><p>The execution thread has not recorded activity yet.</p></div></section>
      <section v-if="toolCalls.length" class="diagnostic-section"><div class="journal-heading"><div><div class="eyebrow">TOOL CALLS</div><h2>Audited tool activity</h2></div><span>{{ toolCalls.length }} calls</span></div><div class="journal-list"><div v-for="tool in toolCalls" :key="tool.callId" class="journal-entry"><div class="journal-icon" :class="{ success: tool.status === 'SUCCEEDED', warning: tool.status === 'FAILED' || tool.status === 'DENIED' || tool.status === 'UNKNOWN' || tool.status === 'NEEDS_RECONCILIATION' }"><CircleCheck v-if="tool.status === 'SUCCEEDED'" :size="15" /><Warning v-else-if="tool.status === 'FAILED' || tool.status === 'DENIED' || tool.status === 'UNKNOWN' || tool.status === 'NEEDS_RECONCILIATION'" :size="15" /><Clock v-else :size="15" /></div><div><div class="journal-meta"><strong>{{ tool.tool }}</strong><span>{{ tool.status }}</span><span>{{ new Date(tool.startedAt).toLocaleTimeString('zh-CN') }}</span></div><p>{{ tool.result ? JSON.stringify(tool.result) : 'No result yet' }}</p></div></div></div></section>
    </el-drawer>
    <PlanDetailDrawer v-model="planDetailOpen" :plan="planDetail" :error="planDetailError" :revisions="planDetailRevisions" :read-only="true" @select-revision="selectPlanRevision" />
  </div>
</template>
