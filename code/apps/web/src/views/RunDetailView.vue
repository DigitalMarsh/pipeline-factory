<!--
  模块职责：展示 Execution Run、Executor 消息流、控制操作和执行日志。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowLeft, ArrowUp, Document, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import ExecutionHeaderStatus from "../components/ExecutionHeaderStatus.vue";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import ProviderUsageFooter from "../components/ProviderUsageFooter.vue";
import { api } from "../api";
import MarkdownMessage from "../components/MarkdownMessage.vue";
import type { AgentLoopStep, ExecutionTask, ExecutionThread, MergeRequest, Plan, PlanTask, Run, RunJournalEvent, VerificationRun } from "../types";
import { executionDisplayMode, projectExecutionJournal, type ExecutionJournalEntry, type ExecutionPlanSnapshot, type ExecutionStreamItem } from "../utils/executionStream";
import { executionMessageDetails, executionMessageDiagnosticsTitle } from "../utils/executionMessageDetails";
import { executionModelSourceNote as executionModelSourceNoteFor, formatProviderContextUsage, resolveExecutionModelIdentity } from "../utils/executionTelemetry";
import { useModelBackends } from "../composables/useModelBackends";
import { executionTaskStatusLabel, executionTaskSummary, projectExecutionTasks } from "../utils/executionTasks";
import { canTerminateRun } from "../utils/runControls";
import { describeRunLoadError } from "../utils/runLoadError";
import { createProjectRequestScope } from "../utils/projectRoutes";
import { formatAgentLoopState } from "../utils/agentLoopPresentation";
import { shouldSubmitComposer } from "../utils/composerKeyboard";

const route = useRoute();
const router = useRouter();
const props = withDefaults(defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>(), { embedded: false });
const emit = defineEmits<{ (event: "close"): void; (event: "open-plan", plan: Plan): void }>();
type ExecutionConversationGroup = { id: string; kind: "plan" | "task" | "guidance" | "unattributed" | "pending"; task?: ExecutionTask; tasks?: ExecutionTask[]; items: ExecutionStreamItem[] };
const embedded = computed(() => props.embedded);
const projectId = computed(() => props.projectId ?? String(route.params.projectId ?? ""));
const runId = computed(() => props.runId ?? String(route.params.runId ?? ""));
const requestScope = createProjectRequestScope();
const run = ref<Run | null>(null);
const thread = ref<ExecutionThread | null>(null);
/** 只用于把后端 id 翻成可读标签（AGENT 那一格）；取不到就显示 id 本身。 */
const { catalog: modelCatalog, load: loadModelBackends } = useModelBackends();
const verification = ref<VerificationRun | null>(null);
const mergeRequest = ref<MergeRequest | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionBusy = ref(false);
const executionDraft = ref("");
const sendingExecutionMessage = ref(false);
const sourceCommit = ref("");
const targetCommit = ref("");
const executorLoop = computed(() => run.value?.agentLoops?.find((loop) => loop.role === "executor") ?? null);
const executorSteps = ref<AgentLoopStep[]>([]);
const planTasks = ref<PlanTask[]>([]);
const executionMessages = ref<ExecutionStreamItem[]>([]);
const executionTimeline = ref<HTMLElement | null>(null);
const showScrollToLatest = ref(false);
const runStreamConnected = ref(false);
const planDetailOpen = ref(false);
const planDetail = ref<Plan | null>(null);
const planDetailRevisions = ref<number[]>([]);
const planDetailError = ref<string | null>(null);
const executionPlan = ref<ExecutionPlanSnapshot | null>(null);
const planMessageExpanded = ref(false);
const selectedTaskId = ref<string | null>(null);
const telemetryNow = ref(Date.now());
let runEventSource: EventSource | null = null;
let runEventSequence = 0;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let planDetailRequestToken = 0;
// ExecutionThread journal 是持久化事实，conversation projection 只负责把事实转换为可读消息。
// sequence 同时作为 SSE 游标，重连时从最后一条已接受的事件继续回放。
const loopStatusLabel = computed(() => formatAgentLoopState(executorLoop.value?.state, "No loop"));
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
/**
 * Run 级活动：没有归属于任何执行步骤的 activity 条目——Run 的创建、生命周期钩子、验证、
 * 门禁、上下文压缩、暂停 / 恢复。它们讲的是整个 Run，不属于任何一步，所以**不留在执行会话里**，
 * 改由顶部 RUN CONTEXT 卡片承载（见 ExecutionHeaderStatus 的「Run 级活动」一节）。
 *
 * 判据只用 kind + taskId：`activity` 且无 taskId。曾经这里按"事件类型是否为 RUN_CREATED /
 * HOOK_* / VERIFICATION"列举，但那样每加一种 Run 级事件都要回来补一次，且同样无归属的
 * `Executor started` / `Execution gate` 会被漏在会话里名不副实。
 */
function isRunActivity(item: ExecutionStreamItem): boolean {
  return item.kind === "activity" && !item.taskId;
}

const runActivityItems = computed<ExecutionStreamItem[]>(() => executionMessages.value.filter(isRunActivity));

const executionConversationGroups = computed<ExecutionConversationGroup[]>(() => {
  const groups: ExecutionConversationGroup[] = [];
  const planMessages = executionMessages.value.filter((item) => item.kind === "plan");
  if (planMessages.length) groups.push({ id: "plan", kind: "plan", items: planMessages });
  const taskIds = new Set(executionTasks.value.map((task) => task.id));
  for (const task of executionTasks.value) {
    groups.push({ id: `task-${task.id}`, kind: "task", task, items: executionMessages.value.filter((item) => item.taskId === task.id) });
  }
  // 你在执行线程里发的消息。它不属于任何执行步骤，但也不该和 Run 级活动混在一组——
  // 它此前就挂在「未关联执行步骤」标题下，等于把用户自己说的话标成了"没有归属的执行步骤"。
  const guidance = executionMessages.value.filter((item) => item.kind === "guidance" && !item.taskId);
  if (guidance.length) groups.push({ id: "guidance", kind: "guidance", items: guidance });
  // 剩下的才是真正的归因缺口：本该落进某个执行步骤、却没有归属的模型 / 工具条目。
  // 现代 Run 不产生这类条目，它们集中在 2026-09-25 之前的数据里。
  const unattributed = executionMessages.value.filter((item) => item.kind !== "plan" && item.kind !== "guidance" && !isRunActivity(item) && (!item.taskId || !taskIds.has(item.taskId)));
  if (unattributed.length) groups.push({ id: "unattributed", kind: "unattributed", items: unattributed });
  return collapsePendingTaskGroups(groups);
});

/**
 * 把**连续的**空执行步骤折成一行。
 * 5 张各占一张卡、每张只写"尚无结构化进度事件表明此任务已开始"是纯噪音；但"哪几步还没轮到"
 * 这个信息要保留，所以折成一行、把标题列出来，而不是整段丢掉。只在**连续**时合并：
 * 中间夹着有内容的步骤时分开显示，"跳过第 2 步先做第 3 步"这种事实才看得出来。
 */
function collapsePendingTaskGroups(groups: ExecutionConversationGroup[]): ExecutionConversationGroup[] {
  const collapsed: ExecutionConversationGroup[] = [];
  let pending: ExecutionTask[] = [];
  const flush = () => {
    const first = pending[0];
    if (first) collapsed.push({ id: `pending-${first.id}`, kind: "pending", items: [], tasks: pending });
    pending = [];
  };
  for (const group of groups) {
    if (group.kind === "task" && group.task && group.items.length === 0) { pending.push(group.task); continue; }
    flush();
    collapsed.push(group);
  }
  flush();
  return collapsed;
}

/**
 * 按**呈现方式**渲染（表在 utils/executionStream.ts 的 `EXECUTION_DISPLAY_MODES`）。
 * 视图不自己判断"这条该不该显示"：呈现方式是产品决定，集中在一张表里，改那里即可。
 * `hidden` 的条目连计数都不进——它们不是内容，只是 Provider 的机制回显。
 */
function visibleItems(group: ExecutionConversationGroup): ExecutionStreamItem[] {
  return group.items.filter((item) => {
    const mode = executionDisplayMode(item);
    return mode === "card" || mode === "line";
  });
}
function foldedItems(group: ExecutionConversationGroup): ExecutionStreamItem[] {
  return group.items.filter((item) => executionDisplayMode(item) === "folded");
}

/**
 * 这个 Run 现在走到哪一步了。四阶段是**执行过程的骨架**：准备（另见顶部 RUN CONTEXT）、
 * 执行、验证、合并。它回答的是"现在在干什么、下一步是什么"——这正是之前页面最缺的一句话。
 */
const executionPhaseSteps = computed(() => {
  const counts = executionTaskCounts.value;
  const status = run.value?.status ?? "";
  const mergeStatus = mergeRequest.value?.status;
  const verificationStatus = verification.value?.status;
  const steps = [
    { key: "execute", label: "执行", detail: counts.total > 0 ? `${counts.completed}/${counts.total} 步骤` : "等待派发" },
    { key: "verify", label: "验证", detail: verificationStatus === "PASSED" ? "已通过" : verificationStatus === "FAILED" || verificationStatus === "BLOCKED" ? "未通过" : verificationStatus === "SKIPPED" ? "已跳过" : "未开始" },
    { key: "merge", label: "合并", detail: mergeStatus === "MERGED" ? "已合并" : mergeStatus === "OPEN" ? "等待人工合并" : status === "MERGE_READY" ? "可创建 Merge request" : "未开始" },
  ];
  // 当前阶段由 Run 状态决定；BLOCKED / CANCELLED 停在它当时所在的那一步，不往前推。
  const current = status === "MERGE_READY" || mergeStatus ? "merge" : verificationStatus || status === "VERIFYING" || status === "READY_FOR_VERIFY" ? "verify" : "execute";
  const currentIndex = current === "merge" ? 2 : current === "verify" ? 1 : 0;
  return steps.map((step, index) => ({ ...step, current: index === currentIndex, done: index < currentIndex }));
});
const executionTelemetry = computed(() => thread.value?.telemetry ?? null);
/**
 * 这次 Run 该用哪个 executor（Revision 快照优先，API 的 `executorConfig`）。
 * 遥测要**这一轮跑完**才落库，所以"现在用的是什么模型"在执行中只能由它回答。
 */
const executorConfig = ref<{ model: string | null; backend: string | null } | null>(null);
/**
 * 后端可能只给到一半：项目没覆盖 `backend` 时快照里就是 null，而此时**生效的是该角色的全局后端**
 * （同一个值 `GET /model-backends` 的 roles 里就有）。不回退这一步，运行中的 AGENT 一栏会空着。
 */
const executionExecutorConfig = computed(() => {
  const configured = executorConfig.value;
  const roleBackend = modelCatalog.value?.roles.executor ?? null;
  if (!configured && !roleBackend) return null;
  return { model: configured?.model ?? null, backend: configured?.backend ?? roleBackend };
});
const executionModelIdentity = computed(() => resolveExecutionModelIdentity(executionTelemetry.value, executionExecutorConfig.value, modelCatalog.value));
/**
 * 项目**当前**的执行配置。与这份 Run 用的那份不一致时说明"配置改了但这份 Run 还用着旧的"——
 * 已确认的 Plan 及其 Run 用的是确认时冻结的配置（见 utils/executionTelemetry.ts 的说明）。
 */
const projectExecutorConfig = ref<{ model: string | null; backend?: string | null } | null>(null);
const executionModelSourceNote = computed(() => executionModelSourceNoteFor(executionModelIdentity.value, projectExecutorConfig.value));
const executionContextUsage = computed(() => formatProviderContextUsage(executionTelemetry.value?.usage?.inputTokens));
/**
 * 展开的是**诊断细节**（Turn #、调用 id、provider 会话），不是正文：正文永远可见。
 * 见 utils/executionMessageDetails.ts 的模块头——那行"什么该收"的规则在那边有单测。
 */
const expandedExecutionItems = ref<Set<string>>(new Set());
function isExecutionItemExpanded(id: string): boolean { return expandedExecutionItems.value.has(id); }
function toggleExecutionItem(id: string): void {
  const next = new Set(expandedExecutionItems.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedExecutionItems.value = next;
}
/**
 * 按执行步骤（task）折叠整组消息：从 task 视角逐个看时，把别的组收起来就不乱。
 * 收起的是**这一组的消息**，步骤头本身始终在——它就是"这里还有一个 task"的那一行。
 */
const collapsedTaskGroups = ref<Set<string>>(new Set());
function isTaskGroupCollapsed(groupId: string): boolean { return collapsedTaskGroups.value.has(groupId); }
function toggleTaskGroup(groupId: string): void {
  const next = new Set(collapsedTaskGroups.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  collapsedTaskGroups.value = next;
}
function expandTaskGroup(groupId: string): void {
  if (!collapsedTaskGroups.value.has(groupId)) return;
  const next = new Set(collapsedTaskGroups.value);
  next.delete(groupId);
  collapsedTaskGroups.value = next;
}
const canSendExecutionMessage = computed(() => Boolean(thread.value && !["CANCELLED", "COMPLETED"].includes(thread.value.state)));

function rebuildExecutionMessages(): void {
  const currentThread = thread.value;
  executionMessages.value = projectExecutionJournal(currentThread?.journal ?? [], currentThread?.state ?? run.value?.status ?? "ACTIVE", executionPlan.value ?? undefined);
}

function executionPlanSnapshot(runValue: Run, revision: { resolvedContract?: Plan["resolvedContract"] }): ExecutionPlanSnapshot {
  const resolved = revision.resolvedContract;
  return {
    planId: runValue.planId,
    revision: runValue.planRevision,
    occurredAt: runValue.createdAt,
    goal: resolved?.objective.goal ?? "Execution plan received.",
    acceptanceCriteria: resolved?.objective.acceptanceCriteria ?? [],
    includePaths: resolved?.scope.includePaths ?? [],
    excludePaths: resolved?.scope.excludePaths ?? [],
    tasks: resolved?.tasks ?? [],
    verificationCommandIds: resolved?.verification.commandIds ?? [],
  };
}

/** 用服务端 journal 重建执行对话，并更新 SSE 回放游标。 */
function setExecutionThread(next: ExecutionThread | null): void {
  thread.value = next;
  const journal = next?.journal ?? [];
  runEventSequence = Math.max(runEventSequence, ...journal.map((entry) => entry.sequence), 0);
  rebuildExecutionMessages();
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
  // 从状态卡跳到一个被收起的步骤时，先把它展开——否则"跳过去"看起来什么都没发生。
  expandTaskGroup(`task-${task.id}`);
  void nextTick(() => {
    const target = (task.evidenceSequence ? executionTimeline.value?.querySelector<HTMLElement>(`[data-sequence="${task.evidenceSequence}"]`) : null)
      ?? Array.from(executionTimeline.value?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []).find((element) => element.dataset.taskId === task.id);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function executionMessageStatusLabel(status: ExecutionStreamItem["status"]): string {
  return ({ RUNNING: "进行中", COMPLETED: "已完成", WAITING: "等待中", FAILED: "失败 / 阻塞", INFO: "信息", UNKNOWN: "状态未知" } as const)[status];
}

function taskGroupEmptyNote(task: ExecutionTask): string {
  if (task.status === "UNKNOWN") return "此任务的执行状态和关联会话未记录。";
  if (task.status === "PENDING") return "尚无结构化进度事件表明此任务已开始。";
  if (task.status === "BLOCKED") return task.blockedReason ?? "阻塞原因未记录。";
  return "此任务暂未关联到已记录的执行消息。";
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
  planDetailOpen.value = !embedded.value;
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
    const revisions = historyResponse.items.map((item) => item.revision);
    planDetailRevisions.value = Array.from(new Set([...revisions, currentRun.planRevision])).sort((left, right) => left - right);
    planDetail.value = {
      ...detailResponse.plan,
      revision: revisionResponse.revision.revision,
      ...(resolvedContract ? { resolvedContract } : {}),
      dispatch: detailResponse.dispatch,
      mergeRequest: detailResponse.mergeRequest ?? mergeRequest.value,
      runId: currentRun.id,
    };
    if (embedded.value && planDetail.value) emit("open-plan", planDetail.value);
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
  rebuildExecutionMessages();
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
  executionDraft.value = "";
  sendingExecutionMessage.value = false;
  executionPlan.value = null;
  executionMessages.value = [];
  planTasks.value = [];
  selectedTaskId.value = null;
  planMessageExpanded.value = false;
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
    executorConfig.value = response.executorConfig;
    // 项目**当前**配置只服务于一条提示（"配置改了但这份 Run 还用旧的"）；取不到不影响 Run 本身。
    try {
      const snapshot = await api.project(requestProjectId);
      if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) projectExecutorConfig.value = snapshot.project.settings.models.executor ?? null;
    } catch { /* 提示缺失不影响主流程 */ }
    verification.value = response.verification;
    mergeRequest.value = response.mergeRequest;
    try {
      const revisionResponse = await api.getPlanRevision(response.run.planId, response.run.planRevision);
      if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
      executionPlan.value = executionPlanSnapshot(response.run, revisionResponse.revision);
      planTasks.value = executionPlan.value.tasks;
      rebuildExecutionMessages();
    } catch (caught) { error.value = describeRunLoadError(caught, "plan-revision"); }
    const loopId = response.run.agentLoops?.[0]?.id;
    executorSteps.value = [];
    if (loopId) {
      try {
        const stepsResponse = await api.agentLoopSteps(loopId);
        if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
        executorSteps.value = stepsResponse.items;
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
async function sendExecutionMessage() {
  const content = executionDraft.value.trim();
  if (!run.value || !canSendExecutionMessage.value || !content || actionBusy.value) return;
  actionBusy.value = true;
  sendingExecutionMessage.value = true;
  try { setExecutionThread((await api.addRunGuidance(run.value.id, content)).thread); executionDraft.value = ""; ElMessage.success("已发送到执行线程"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; sendingExecutionMessage.value = false; }
}
function handleExecutionComposerKeydown(event: KeyboardEvent): void {
  if (!shouldSubmitComposer(event)) return;
  event.preventDefault();
  void sendExecutionMessage();
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
  onMounted(async () => { telemetryTimer = setInterval(() => { if (executionTelemetry.value?.completedAt === null || executionTelemetry.value?.durationMs === null) telemetryNow.value = Date.now(); }, 1000); void loadModelBackends(); await load(); connectRunEvents(); scrollExecutionToLatest(); });
  onBeforeUnmount(() => { requestScope.invalidate(); closeRunEvents(); if (telemetryTimer) clearInterval(telemetryTimer); });
</script>

<template>
  <div :class="['detail-page', 'run-detail-page', { 'detail-page-embedded': embedded }]" v-loading="loading">
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
          :run-activity="runActivityItems"
          :selected-task-id="selectedTaskId"
          :executor-loop="executorLoop"
          :executor-steps="executorSteps"
          :loop-status-label="loopStatusLabel"
          :verification="verification"
          :merge-request="mergeRequest"
          :action-busy="actionBusy"
          :source-commit="sourceCommit"
          :target-commit="targetCommit"
          @focus-task="focusExecutionTask"
          @run-action="handleRunAction"
          @loop-action="handleLoopAction"
          @create-review="createReview"
          @confirm-merged="confirmMerged"
          @open-plan="openPlanDetail"
          @update:source-commit="updateSourceCommit"
          @update:target-commit="updateTargetCommit"
        />
      </div>
      <div v-if="run.status === 'BLOCKED' && executionBlockReason" class="run-blocked-notice" role="alert"><Warning :size="16" /><div><strong>Why execution stopped</strong><span>{{ executionBlockReason }}</span></div></div>
      <section class="execution-conversation-panel">
        <div class="journal-heading"><div><div class="eyebrow">EXECUTION CONVERSATION</div><h2>What the Executor is doing</h2></div><div class="execution-stream-status" role="status"><i :class="{ connected: runStreamConnected }" /> {{ executionStatusLabel }}</div></div>
        <ol class="execution-phase-strip" aria-label="执行阶段">
          <li v-for="(phase, index) in executionPhaseSteps" :key="phase.key" :class="['execution-phase', { current: phase.current, done: phase.done }]">
            <span class="execution-phase-mark">{{ phase.done ? "✓" : index + 1 }}</span>
            <strong>{{ phase.label }}</strong>
            <small>{{ phase.detail }}</small>
          </li>
        </ol>
        <div class="execution-conversation-stage">
          <div ref="executionTimeline" class="execution-conversation" @scroll="updateExecutionScrollState">
          <div v-if="!executionMessages.length" class="empty-state"><Document :size="28" /><h3>Waiting for executor activity</h3><p>The execution conversation will appear here when the Run starts.</p></div>
          <section v-for="group in executionConversationGroups" :key="group.id" :class="['execution-conversation-group', `execution-conversation-group-${group.kind}`, { selected: selectedTaskId === group.task?.id, collapsed: isTaskGroupCollapsed(group.id) }]" :data-task-id="group.task?.id">
            <button v-if="group.task" type="button" class="execution-task-stream-heading" :aria-expanded="!isTaskGroupCollapsed(group.id)" :aria-controls="`execution-task-stream-${group.id}`" @click="toggleTaskGroup(group.id)">
              <span class="execution-task-stream-step">PLAN TASK</span>
              <strong>{{ group.task.title }}</strong>
              <span :class="['execution-task-stream-status', `tone-${group.task.status.toLowerCase()}`]">{{ executionTaskStatusLabel(group.task.status) }}</span>
              <span class="execution-task-stream-count">{{ visibleItems(group).length }} 条</span>
              <span v-if="foldedItems(group).length" class="execution-task-stream-quiet">{{ foldedItems(group).length }} 条过程记录</span>
              <ArrowUp v-if="!isTaskGroupCollapsed(group.id)" :size="14" /><ArrowDown v-else :size="14" />
              <small v-if="group.task.blockedReason">{{ group.task.blockedReason }}</small>
            </button>
            <button v-else-if="group.kind === 'unattributed'" type="button" class="execution-task-stream-heading execution-unattributed-heading" :aria-expanded="!isTaskGroupCollapsed(group.id)" :aria-controls="`execution-task-stream-${group.id}`" @click="toggleTaskGroup(group.id)">
              <span class="execution-task-stream-step">UNATTRIBUTED</span><strong>未归属事件</strong><span class="execution-task-stream-count">{{ visibleItems(group).length }} 条</span><ArrowUp v-if="!isTaskGroupCollapsed(group.id)" :size="14" /><ArrowDown v-else :size="14" /><small>这些事件没有记录所属的执行步骤，只出现在早期 Run 的数据里。</small>
            </button>
            <div v-else-if="group.kind === 'pending'" class="execution-pending-steps">
              <span class="execution-task-stream-step">PENDING</span>
              <strong>{{ (group.tasks ?? []).length }} 个执行步骤尚未开始</strong>
              <small>{{ (group.tasks ?? []).map((task) => task.title).join(" · ") }}</small>
            </div>
            <div v-if="group.kind !== 'pending' && !isTaskGroupCollapsed(group.id)" :id="`execution-task-stream-${group.id}`" class="execution-task-stream-items">
            <p v-if="group.task && !visibleItems(group).length && !foldedItems(group).length" class="execution-task-stream-empty">{{ taskGroupEmptyNote(group.task) }}</p>
            <article v-for="item in visibleItems(group)" :key="item.id" :data-sequence="item.sequence" :data-task-id="item.taskId" :data-model-step="item.modelStep" :title="executionMessageDiagnosticsTitle(item)" :class="['execution-message', `execution-message-${item.kind}`, { failed: item.status === 'FAILED', waiting: item.status === 'WAITING', running: item.status === 'RUNNING', unknown: item.status === 'UNKNOWN', mine: item.role === 'user' }]">
              <div class="execution-message-avatar">{{ item.role === 'user' ? 'LS' : item.kind === 'plan' ? 'PL' : item.kind === 'model' ? 'EX' : item.kind === 'tool' ? 'TL' : '·' }}</div>
              <div class="execution-message-body">
                <div class="execution-message-meta"><strong>{{ item.title }}</strong><span v-if="item.status !== 'INFO'" class="agent-chip">{{ executionMessageStatusLabel(item.status) }}</span><span class="execution-message-time">{{ new Date(item.occurredAt).toLocaleTimeString('zh-CN') }}</span><button v-if="executionMessageDetails(item).length" type="button" class="execution-message-toggle" :aria-expanded="isExecutionItemExpanded(item.id)" @click="toggleExecutionItem(item.id)">{{ isExecutionItemExpanded(item.id) ? '收起详情' : '详情' }}</button></div>
                <div v-if="isExecutionItemExpanded(item.id)" class="execution-message-details"><span v-for="detail in executionMessageDetails(item)" :key="detail">{{ detail }}</span></div>
                <template v-if="item.kind === 'plan' && item.plan">
                  <div class="execution-plan-message">
                    <div class="execution-plan-message-summary"><MarkdownMessage :source="item.plan.goal" /></div>
                    <button :id="`execution-plan-toggle-${item.id}`" class="execution-plan-toggle" type="button" :aria-expanded="planMessageExpanded" :aria-controls="`execution-plan-details-${item.id}`" @click="planMessageExpanded = !planMessageExpanded">{{ planMessageExpanded ? '收起 Plan 摘要' : '展开 Plan 摘要' }}</button>
                    <div v-if="planMessageExpanded" :id="`execution-plan-details-${item.id}`" class="execution-plan-message-details">
                      <div class="execution-plan-message-stats"><span><strong>{{ item.plan.tasks.length }}</strong> tasks</span><span><strong>{{ item.plan.acceptanceCriteria.length }}</strong> acceptance criteria</span><span><strong>{{ item.plan.verificationCommandIds.length }}</strong> verification commands</span></div>
                      <div v-if="item.plan.tasks.length" class="execution-plan-message-section"><span class="execution-plan-message-label">TASKS</span><ul><li v-for="task in item.plan.tasks" :key="task.id ?? task.title">{{ task.title }}</li></ul></div>
                      <div class="execution-plan-message-scope"><div><span class="execution-plan-message-label">INCLUDE</span><code v-for="path in item.plan.includePaths" :key="`include-${path}`">{{ path }}</code><small v-if="!item.plan.includePaths.length">No include paths</small></div><div><span class="execution-plan-message-label">EXCLUDE</span><code v-for="path in item.plan.excludePaths" :key="`exclude-${path}`">{{ path }}</code><small v-if="!item.plan.excludePaths.length">No exclude paths</small></div></div>
                    </div>
                    <div class="execution-plan-message-actions"><el-button text size="small" @click="openPlanDetail">View full plan</el-button></div>
                  </div>
                </template>
                <template v-else-if="item.kind === 'model' || item.kind === 'guidance'">
                  <MarkdownMessage :source="item.content" :streaming="item.status === 'RUNNING'" />
                  <small v-if="item.detail || item.unrecordedFields?.length" class="execution-message-note">{{ item.detail || item.unrecordedFields?.join(' · ') }}</small>
                </template>
                <template v-else>
                  <p class="execution-activity-detail">{{ item.detail }}</p>
                  <small v-if="item.unrecordedFields?.length" class="execution-message-note">{{ item.unrecordedFields.join(' · ') }}</small>
                </template>
              </div>
            </article>
            <!-- 呈现方式为 `folded` 的过程记录（推理、门禁、机制提示）：默认不占视线，需要时仍可回溯。 -->
            <details v-if="foldedItems(group).length" class="execution-folded-log">
              <summary>{{ foldedItems(group).length }} 条过程记录</summary>
              <ul class="execution-folded-list">
                <li v-for="item in foldedItems(group)" :key="item.id" :data-sequence="item.sequence"><span class="execution-noise-time">{{ new Date(item.occurredAt).toLocaleTimeString("zh-CN") }}</span><span class="execution-noise-title">{{ item.title }}</span><small v-if="item.detail">{{ item.detail }}</small></li>
              </ul>
            </details>
            </div>
          </section>
          </div>
          <el-button v-if="showScrollToLatest" class="execution-scroll-latest" size="small" @click="scrollExecutionToLatest">Jump to latest</el-button>
        </div>
        <div class="composer execution-composer">
          <div class="composer-input">
            <textarea v-model="executionDraft" aria-label="Execution thread message" placeholder="与执行线程沟通，或提出修改…" :disabled="actionBusy || !canSendExecutionMessage" @keydown="handleExecutionComposerKeydown" />
            <span class="composer-mode">Run Mode</span>
          </div>
          <div class="composer-footer">
            <ProviderUsageFooter :model="executionModelIdentity.model" :backend="executionModelIdentity.backend" :context="executionContextUsage" context-note="仅结束时由 provider 上报" :source-note="executionModelSourceNote" />
            <span v-if="sendingExecutionMessage" class="composer-status" role="status" aria-live="polite">Message sent · waiting for Executor…</span>
            <el-button class="composer-send" type="primary" circle :loading="sendingExecutionMessage" :disabled="!executionDraft.trim() || !canSendExecutionMessage || actionBusy" aria-label="Send message" :title="actionBusy ? '正在发送消息' : 'Send message'" @click="sendExecutionMessage"><ArrowUp :size="18" /></el-button>
          </div>
        </div>
      </section>
    </template>
    <PlanDetailDrawer v-model="planDetailOpen" :plan="planDetail" :error="planDetailError" :revisions="planDetailRevisions" :read-only="true" @select-revision="selectPlanRevision" />
  </div>
</template>
