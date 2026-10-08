<!--
  模块职责：展示 Execution Run、Executor 消息流、控制操作和执行日志。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
  这个视图现在只留四件事——**加载一个 Run、把状态摆到页头、把会话渲染出来、内嵌与独立页的形态差异**。
  其余四簇各自成文件（它们各有完整生命周期或踩过坑的判据，混在这里正是"改一次要读一千行"的成因）：
  `useExecutionConversation`（分组与折叠）、`useRunStream`（SSE 与续传游标）、
  `useRunControl`（暂停 / 终止 / 验证 / 合并）、`useRunComposer`（补充要求输入框）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown, ArrowLeft, ArrowUp, Document, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import ExecutionHeaderStatus from "../components/ExecutionHeaderStatus.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import ProviderUsageFooter from "../components/ProviderUsageFooter.vue";
import ExecutionMessageRow from "../components/ExecutionMessageRow.vue";
import { api } from "../api";
import type { AgentLoopStep, ExecutionTask, ExecutionThread, MergeRequest, Plan, PlanTask, Run, VerificationRun } from "../types";
import { streamStatusTagType } from "../utils/statusTag";
import { projectExecutionJournal, type ExecutionPlanSnapshot, type ExecutionStreamItem } from "../utils/executionStream";
import {
  executionModelSourceNote as executionModelSourceNoteFor,
  formatProviderContextUsage,
  resolveExecutionModelIdentity,
} from "../utils/executionTelemetry";
import { useModelBackends } from "../composables/useModelBackends";
import { executionTaskStatusLabel, executionTaskStatusType, executionTaskSummary, projectExecutionTasks } from "../utils/executionTasks";
import { describeRunLoadError } from "../utils/runLoadError";
import { createProjectRequestScope } from "../utils/projectRoutes";
import { formatAgentLoopState } from "../utils/agentLoopPresentation";
import { useExecutionConversation } from "../composables/useExecutionConversation";
import { useRunStream } from "../composables/useRunStream";
import { useRunControl } from "../composables/useRunControl";
import { useRunComposer } from "../composables/useRunComposer";

const route = useRoute();
const router = useRouter();
const props = withDefaults(defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>(), { embedded: false });
const emit = defineEmits<{ (event: "close"): void; (event: "open-plan", plan: Plan): void }>();
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
const executorSteps = ref<AgentLoopStep[]>([]);
const planTasks = ref<PlanTask[]>([]);
const executionMessages = ref<ExecutionStreamItem[]>([]);
const executionTimeline = ref<HTMLElement | null>(null);
const showScrollToLatest = ref(false);
const planDetailOpen = ref(false);
const planDetail = ref<Plan | null>(null);
const planDetailRevisions = ref<number[]>([]);
const planDetailError = ref<string | null>(null);
const executionPlan = ref<ExecutionPlanSnapshot | null>(null);
const selectedTaskId = ref<string | null>(null);
const telemetryNow = ref(Date.now());
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let planDetailRequestToken = 0;

/**
 * **取最新的一条执行 Loop，而不是第一条。** 一个 Run 现在可以有多条执行 Loop（补充要求会为同一个 Run
 * 起新一轮），`.find(...)` 会永远返回第一轮那条——于是补充要求开始之后，页头的「Agent 循环」还停在
 * 上一轮的"已完成 1/40 步"上，看起来什么都没发生。
 */
const executorLoop = computed(() => {
  const loops = (run.value?.agentLoops ?? []).filter((loop) => loop.role === "executor");
  return loops.reduce<(typeof loops)[number] | null>(
    (latest, loop) => (!latest || (loop.startedAt ?? "") >= (latest.startedAt ?? "") ? loop : latest),
    null,
  );
});
const executionTasks = computed<ExecutionTask[]>(() =>
  projectExecutionTasks(planTasks.value, thread.value?.journal ?? [], run.value?.status ?? ""),
);
const executionTaskCounts = computed(() => executionTaskSummary(executionTasks.value));
/**
 * 为什么停下：取执行日志里**最后一条**带原因的事件。它只服务于 `BLOCKED` 那一条提示条，
 * 但"为什么停下"这句得由事实说话，不能靠 Run 状态猜。
 */
const executionBlockReason = computed(() => {
  for (const entry of [...(thread.value?.journal ?? [])].reverse()) {
    const reason = entry.payload.reason ?? entry.payload.error;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return null;
});

// ExecutionThread journal 是持久化事实，conversation projection 只负责把事实转换为可读消息。
// sequence 同时作为 SSE 游标，重连时从最后一条已接受的事件继续回放（游标归 useRunStream）。
function rebuildExecutionMessages(): void {
  const currentThread = thread.value;
  executionMessages.value = projectExecutionJournal(
    currentThread?.journal ?? [],
    currentThread?.state ?? run.value?.status ?? "ACTIVE",
    executionPlan.value ?? undefined,
  );
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

function notifyError(caught: unknown) {
  error.value = caught instanceof Error ? caught.message : "操作失败，请稍后重试";
}

/* ── 四个抽出去的簇 ──────────────────────────────────────────────────────────
   声明的先后就是依赖方向：会话分组与事件流都要读 `executionTasks` / `thread`，
   输入框要用控制簇的 `actionBusy`（同一个 Run 上的操作互斥）。
   它们各自的判据与踩过的坑写在各文件头部。 */
const {
  groups,
  runActivityItems,
  runtimeFactItems,
  foldedItems,
  visibleItems,
  failedCount,
  unclassifiedCount,
  stepDuration,
  continuationHeading,
  taskGroupEmptyNote,
} = useExecutionConversation({ thread, messages: executionMessages, tasks: executionTasks });

const stream = useRunStream({
  run,
  thread,
  isAtLatest: isAtExecutionLatest,
  onJournalApplied: (_event, { follow }) => {
    rebuildExecutionMessages();
    // 用户原本贴着底部 → 跟着走；否则亮出「跳到最新」，而不是把人拽下去。
    if (follow) scrollExecutionToLatest();
    else showScrollToLatest.value = true;
  },
});

const {
  actionBusy,
  terminateOpen,
  terminateError,
  sourceCommit,
  targetCommit,
  handleRunAction,
  handleLoopAction,
  createReview,
  confirmMerged,
  confirmTerminateRun,
  updateSourceCommit,
  updateTargetCommit,
} = useRunControl({
  run,
  thread,
  executorLoop,
  verification,
  mergeRequest,
  setThread: setExecutionThread,
  reload: load,
  onError: notifyError,
  onTerminated: async () => {
    if (embedded.value) await load();
    else await router.push(`/projects/${projectId.value}/plans`);
  },
});

const {
  executionDraft,
  sendingExecutionMessage,
  executionGuidanceMode,
  canSendExecutionMessage,
  executorLoopRunning,
  executionComposerDisabledReason,
  sendExecutionMessage,
  handleExecutionComposerKeydown,
} = useRunComposer({ run, actionBusy, setThread: setExecutionThread, onError: notifyError });
/* ── 抽出去的簇到此为止 ─────────────────────────────────────────────────── */

/** 用服务端 journal 重建执行对话，并把 SSE 游标推到已加载的那一批之后（重连从这里继续）。 */
function setExecutionThread(next: ExecutionThread | null): void {
  thread.value = next;
  const journal = next?.journal ?? [];
  stream.resumeFrom(Math.max(...journal.map((entry) => entry.sequence), 0));
  rebuildExecutionMessages();
}

const loopStatusLabel = computed(() => formatAgentLoopState(executorLoop.value?.state, "无活动 Loop"));
const streamState = computed<"live" | "reconnecting" | "saved">(() =>
  stream.connected.value ? "live" : ["IN_PROGRESS", "STARTING"].includes(run.value?.status ?? "") ? "reconnecting" : "saved",
);
const executionStatusLabel = computed(() => ({ live: "实时", reconnecting: "重连中", saved: "已保存" })[streamState.value]);

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
    {
      key: "verify",
      label: "验证",
      detail:
        verificationStatus === "PASSED"
          ? "已通过"
          : verificationStatus === "FAILED" || verificationStatus === "BLOCKED"
            ? "未通过"
            : verificationStatus === "SKIPPED"
              ? "已跳过"
              : "未开始",
    },
    {
      key: "merge",
      label: "合并",
      detail:
        mergeStatus === "MERGED"
          ? "已合并"
          : mergeStatus === "OPEN"
            ? "等待人工合并"
            : status === "MERGE_READY"
              ? "可创建 Merge request"
              : "未开始",
    },
  ];
  // 当前阶段由 Run 状态决定；BLOCKED / CANCELLED 停在它当时所在的那一步，不往前推。
  const current =
    status === "MERGE_READY" || mergeStatus
      ? "merge"
      : verificationStatus || status === "VERIFYING" || status === "READY_FOR_VERIFY"
        ? "verify"
        : "execute";
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
const executionModelIdentity = computed(() =>
  resolveExecutionModelIdentity(executionTelemetry.value, executionExecutorConfig.value, modelCatalog.value),
);
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
function isExecutionItemExpanded(id: string): boolean {
  return expandedExecutionItems.value.has(id);
}
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
function isTaskGroupCollapsed(groupId: string): boolean {
  return collapsedTaskGroups.value.has(groupId);
}
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

function focusExecutionTask(task: ExecutionTask): void {
  selectedTaskId.value = task.id;
  // 从状态卡跳到一个被收起的步骤时，先把它展开——否则"跳过去"看起来什么都没发生。
  expandTaskGroup(`task-${task.id}`);
  void nextTick(() => {
    const target =
      (task.evidenceSequence ? executionTimeline.value?.querySelector<HTMLElement>(`[data-sequence="${task.evidenceSequence}"]`) : null) ??
      Array.from(executionTimeline.value?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []).find(
        (element) => element.dataset.taskId === task.id,
      );
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
    const resolvedContract =
      revisionResponse.revision.resolvedContract ?? detailResponse.revision?.resolvedContract ?? detailResponse.plan.resolvedContract;
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
  try {
    try {
      const report = await api.reconcileProjectMerges(requestProjectId);
      const diagnostic = report.items.find((item) => item.runId === requestRunId && item.reason);
      if (diagnostic?.reason) ElMessage.warning(`Merge 状态检测：${diagnostic.reason}`);
    } catch (caught) {
      ElMessage.warning(`Merge 状态检测失败，已展示最近保存的状态：${caught instanceof Error ? caught.message : "暂不可用"}`);
    }
    const response = await api.getRun(requestRunId);
    if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
    run.value = response.run;
    setExecutionThread(response.executionThread);
    executorConfig.value = response.executorConfig;
    // 项目**当前**配置只服务于一条提示（"配置改了但这份 Run 还用旧的"）；取不到不影响 Run 本身。
    try {
      const snapshot = await api.project(requestProjectId);
      if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`))
        projectExecutorConfig.value = snapshot.project.settings.models.executor ?? null;
    } catch {
      /* 提示缺失不影响主流程 */
    }
    verification.value = response.verification;
    mergeRequest.value = response.mergeRequest;
    try {
      const revisionResponse = await api.getPlanRevision(response.run.planId, response.run.planRevision);
      if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
      executionPlan.value = executionPlanSnapshot(response.run, revisionResponse.revision);
      planTasks.value = executionPlan.value.tasks;
      rebuildExecutionMessages();
    } catch (caught) {
      error.value = describeRunLoadError(caught, "plan-revision");
    }
    const loopId = response.run.agentLoops?.[0]?.id;
    executorSteps.value = [];
    if (loopId) {
      try {
        const stepsResponse = await api.agentLoopSteps(loopId);
        if (!requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) return;
        executorSteps.value = stepsResponse.items;
      } catch (caught) {
        error.value = describeRunLoadError(caught, "agent-loop");
      }
    }
    sourceCommit.value = response.mergeRequest?.sourceCommit ?? response.run.baseCommit;
    // Reconciliation is the source of truth for the confirmation input. Reset it
    // on every load so switching runs or refreshing cannot retain another run's SHA.
    targetCommit.value = response.mergeRequest?.detectedTargetCommit ?? response.run.baseCommit;
  } catch (caught) {
    if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) error.value = describeRunLoadError(caught, "run");
  } finally {
    if (requestScope.isCurrent(requestToken, `${requestProjectId}:${requestRunId}`)) loading.value = false;
  }
}

function closeView(): void {
  if (embedded.value) {
    emit("close");
    return;
  }
  void router.push({
    path: `/projects/${projectId.value}/explorer`,
    query: { explorerId: route.query.explorerId, explorerPlanId: route.query.explorerPlanId, contextPanel: "plan-center" },
  });
}

watch([projectId, runId], () => {
  resetPlanDetail();
  stream.close();
  void load().then(() => {
    if (run.value) stream.connect();
  });
});
onMounted(async () => {
  telemetryTimer = setInterval(() => {
    if (executionTelemetry.value?.completedAt === null || executionTelemetry.value?.durationMs === null) telemetryNow.value = Date.now();
  }, 1000);
  void loadModelBackends();
  await load();
  stream.connect();
  scrollExecutionToLatest();
});
onBeforeUnmount(() => {
  requestScope.invalidate();
  stream.close();
  if (telemetryTimer) clearInterval(telemetryTimer);
});
</script>

<template>
  <div v-loading="loading" :class="['detail-page', 'run-detail-page', { 'detail-page-embedded': embedded }]">
    <div v-if="!embedded" class="detail-top">
      <el-button text @click="closeView"><ArrowLeft :size="15" /> 返回</el-button>
    </div>
    <div v-if="error" class="demo-notice"><Warning :size="14" /> {{ error }}</div>
    <template v-if="run">
      <div class="detail-heading">
        <div class="detail-heading-title">
          <h1>执行运行</h1>
        </div>
        <div class="detail-heading-plan">
          <p class="execution-plan-link-row">
            <span>方案</span
            ><button
              type="button"
              class="execution-plan-link"
              :aria-label="`查看方案 ${run.planId} 第 ${run.planRevision} 版详情`"
              @click="openPlanDetail"
            >
              <code>{{ run.planId }}</code
              ><span>· 第 {{ run.planRevision }} 版</span>
            </button>
          </p>
        </div>
        <ExecutionHeaderStatus
          :run="run"
          :thread-state="thread?.state ?? ''"
          :telemetry="executionTelemetry"
          :telemetry-now="telemetryNow"
          :tasks="executionTasks"
          :task-counts="executionTaskCounts"
          :run-activity="runActivityItems"
          :runtime-facts="runtimeFactItems"
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
      <div v-if="run.status === 'BLOCKED' && executionBlockReason" class="run-blocked-notice" role="alert">
        <Warning :size="16" />
        <div>
          <strong>为什么停下</strong><span>{{ executionBlockReason }}</span>
        </div>
      </div>
      <section class="execution-conversation-panel">
        <div class="journal-heading">
          <div>
            <div class="eyebrow">执行会话</div>
            <h2>Executor 在做什么</h2>
          </div>
          <el-tag size="small" effect="light" :type="streamStatusTagType(streamState)" role="status">{{ executionStatusLabel }}</el-tag>
        </div>
        <ol class="execution-phase-strip" aria-label="执行阶段">
          <li
            v-for="(phase, index) in executionPhaseSteps"
            :key="phase.key"
            :class="['execution-phase', { current: phase.current, done: phase.done }]"
          >
            <span class="execution-phase-mark">{{ phase.done ? "✓" : index + 1 }}</span>
            <strong>{{ phase.label }}</strong>
            <small>{{ phase.detail }}</small>
          </li>
        </ol>
        <div class="execution-conversation-stage">
          <div ref="executionTimeline" class="execution-conversation" @scroll="updateExecutionScrollState">
            <div v-if="!executionMessages.length" class="empty-state">
              <Document :size="28" />
              <h3>等待 Executor 的活动</h3>
              <p>Run 启动后，执行会话会出现在这里。</p>
            </div>
            <section
              v-for="group in groups"
              :key="group.id"
              :class="[
                'execution-conversation-group',
                `execution-conversation-group-${group.kind}`,
                { selected: selectedTaskId === group.task?.id, collapsed: isTaskGroupCollapsed(group.id) },
              ]"
              :data-task-id="group.task?.id"
            >
              <button
                v-if="group.task"
                type="button"
                class="execution-task-stream-heading"
                :aria-expanded="!isTaskGroupCollapsed(group.id)"
                :aria-controls="`execution-task-stream-${group.id}`"
                @click="toggleTaskGroup(group.id)"
              >
                <span class="execution-task-stream-step">计划任务</span>
                <strong>{{ group.task.title }}</strong>
                <el-tag size="small" effect="light" :type="executionTaskStatusType(group.task.status)">{{
                  executionTaskStatusLabel(group.task.status)
                }}</el-tag>
                <span class="execution-task-stream-count">{{ visibleItems(group).length }} 条</span>
                <span v-if="foldedItems(group).length" class="execution-task-stream-quiet">{{ foldedItems(group).length }} 条过程记录</span>
                <ArrowUp v-if="!isTaskGroupCollapsed(group.id)" :size="14" /><ArrowDown v-else :size="14" />
                <small v-if="group.task.blockedReason">{{ group.task.blockedReason }}</small>
              </button>
              <button
                v-else-if="group.kind === 'unattributed'"
                type="button"
                class="execution-task-stream-heading execution-unattributed-heading"
                :aria-expanded="!isTaskGroupCollapsed(group.id)"
                :aria-controls="`execution-task-stream-${group.id}`"
                @click="toggleTaskGroup(group.id)"
              >
                <span class="execution-task-stream-step">未归属</span><strong>未归属事件</strong
                ><span class="execution-task-stream-count">{{ visibleItems(group).length }} 条</span
                ><ArrowUp v-if="!isTaskGroupCollapsed(group.id)" :size="14" /><ArrowDown v-else :size="14" /><small
                  >这些事件没有记录所属的执行步骤，只出现在早期 Run 的数据里。</small
                >
              </button>
              <button
                v-else-if="group.kind === 'continuation'"
                type="button"
                class="execution-task-stream-heading execution-continuation-heading"
                :aria-expanded="!isTaskGroupCollapsed(group.id)"
                :aria-controls="`execution-task-stream-${group.id}`"
                @click="toggleTaskGroup(group.id)"
              >
                <span class="execution-task-stream-step">补充要求</span><strong>{{ continuationHeading(group) }}</strong
                ><span class="execution-task-stream-count">{{ visibleItems(group).length }} 条</span
                ><ArrowUp v-if="!isTaskGroupCollapsed(group.id)" :size="14" /><ArrowDown v-else :size="14" /><small
                  >这一轮由你补充的要求起，<strong>不属于任何计划任务</strong>。</small
                >
              </button>
              <div v-else-if="group.kind === 'pending'" class="execution-pending-steps">
                <span class="execution-task-stream-step">待处理</span>
                <strong>{{ (group.tasks ?? []).length }} 个执行步骤尚未开始</strong>
                <small>{{ (group.tasks ?? []).map((task) => task.title).join(" · ") }}</small>
              </div>
              <div
                v-if="group.kind !== 'pending' && !isTaskGroupCollapsed(group.id)"
                :id="`execution-task-stream-${group.id}`"
                class="execution-task-stream-items"
              >
                <!-- **过程记录折在上面**（照 OpenClaw 的 `Worked for …`）：先交代这一步花了多久、折了多少条，
                 再让结论自己说话。展开后是**真实的行**，不是一张只写了标题的清单。
                 失败项与"未识别"不折进来——那是这一步里唯一需要你动手的东西。 -->
                <details v-if="foldedItems(group).length" class="execution-folded-log">
                  <summary>
                    <span>{{ foldedItems(group).length }} 条过程记录</span>
                    <small v-if="stepDuration(group)">用时 {{ stepDuration(group) }}</small>
                    <small v-if="failedCount(group)">{{ failedCount(group) }} 个失败留在外面</small>
                    <small v-if="unclassifiedCount(group)">{{ unclassifiedCount(group) }} 条未识别</small>
                  </summary>
                  <div class="execution-folded-list">
                    <ExecutionMessageRow
                      v-for="item in foldedItems(group)"
                      :key="item.id"
                      :item="item"
                      :expanded="isExecutionItemExpanded(item.id)"
                      @toggle-details="toggleExecutionItem"
                      @view-plan="openPlanDetail"
                    />
                  </div>
                </details>
                <p v-if="group.task && !visibleItems(group).length && !foldedItems(group).length" class="execution-task-stream-empty">
                  {{ taskGroupEmptyNote(group.task) }}
                </p>
                <ExecutionMessageRow
                  v-for="item in visibleItems(group)"
                  :key="item.id"
                  :item="item"
                  :expanded="isExecutionItemExpanded(item.id)"
                  @toggle-details="toggleExecutionItem"
                  @view-plan="openPlanDetail"
                />
              </div>
            </section>
          </div>
          <el-button v-if="showScrollToLatest" class="execution-scroll-latest" size="small" @click="scrollExecutionToLatest"
            >跳到最新</el-button
          >
        </div>
        <div class="composer execution-composer">
          <div class="composer-input">
            <textarea
              v-model="executionDraft"
              aria-label="执行会话消息"
              :placeholder="
                canSendExecutionMessage
                  ? executorLoopRunning
                    ? '补充要求，交给正在跑的这一轮…'
                    : '补充要求，执行线程会重新开工…'
                  : executionComposerDisabledReason
              "
              :disabled="actionBusy || !canSendExecutionMessage"
              @keydown="handleExecutionComposerKeydown"
            />
            <!-- 一轮还在跑时才有得选：排队 = 等它结束再起一轮；引导 = 下一个步骤边界插进这一轮。
                 没在跑时两种等价，不由用户选。 -->
            <label v-if="canSendExecutionMessage && executorLoopRunning" class="composer-guidance-mode"
              ><span>投递</span
              ><select v-model="executionGuidanceMode" :disabled="actionBusy" aria-label="补充要求的投递方式">
                <option value="queue">排队 · 这一轮结束后再开工</option>
                <option value="steer">引导 · 下一轮生效</option>
              </select></label
            >
            <span v-else class="composer-mode">Run 模式</span>
          </div>
          <div class="composer-footer">
            <ProviderUsageFooter
              :model="executionModelIdentity.model"
              :backend="executionModelIdentity.backend"
              :context="executionContextUsage"
              context-note="仅结束时由 provider 上报"
              :source-note="executionModelSourceNote"
            />
            <span v-if="sendingExecutionMessage" class="composer-status" role="status" aria-live="polite">消息已发送 · 等待 Executor…</span>
            <el-button
              class="composer-send"
              type="primary"
              circle
              :loading="sendingExecutionMessage"
              :disabled="!executionDraft.trim() || !canSendExecutionMessage || actionBusy"
              aria-label="发送消息"
              :title="actionBusy ? '正在发送消息' : '发送消息'"
              @click="sendExecutionMessage"
              ><ArrowUp :size="18"
            /></el-button>
          </div>
        </div>
      </section>
    </template>
    <PlanDetailDrawer
      v-model="planDetailOpen"
      :plan="planDetail"
      :error="planDetailError"
      :revisions="planDetailRevisions"
      :read-only="true"
      @select-revision="selectPlanRevision"
    />
    <ConfirmDialog
      v-model="terminateOpen"
      eyebrow="运行控制"
      heading="终止 Run"
      message="终止后这次执行就停在这里，已经确认的 Plan 会留在历史里。"
      :details="['正在跑的 Agent 循环会一起取消', 'cleanup 钩子会执行', '已结束运行的本地 worktree 不会自动清理']"
      confirm-label="终止 Run"
      cancel-label="继续运行"
      tone="danger"
      :busy="actionBusy"
      :error="terminateError"
      @confirm="confirmTerminateRun"
    />
  </div>
</template>
