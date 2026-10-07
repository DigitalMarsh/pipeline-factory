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
import type {
  AgentLoopStep,
  ExecutionTask,
  ExecutionThread,
  MergeRequest,
  Plan,
  PlanTask,
  Run,
  RunJournalEvent,
  VerificationRun,
} from "../types";
import { streamStatusTagType } from "../utils/statusTag";
import ExecutionMessageRow from "../components/ExecutionMessageRow.vue";
import {
  executionMessageWeight,
  foldsIntoProcess,
  isRuntimeFactItem,
  projectExecutionJournal,
  type ExecutionJournalEntry,
  type ExecutionPlanSnapshot,
  type ExecutionStreamItem,
} from "../utils/executionStream";
import { durationBetween, formatDuration } from "../utils/duration";
import {
  executionModelSourceNote as executionModelSourceNoteFor,
  formatProviderContextUsage,
  resolveExecutionModelIdentity,
} from "../utils/executionTelemetry";
import { useModelBackends } from "../composables/useModelBackends";
import { executionTaskStatusLabel, executionTaskStatusType, executionTaskSummary, projectExecutionTasks } from "../utils/executionTasks";
import { canContinueRun, canTerminateRun } from "../utils/runControls";
import { describeRunLoadError } from "../utils/runLoadError";
import { createProjectRequestScope } from "../utils/projectRoutes";
import { formatAgentLoopState } from "../utils/agentLoopPresentation";
import { shouldSubmitComposer } from "../utils/composerKeyboard";

const route = useRoute();
const router = useRouter();
const props = withDefaults(defineProps<{ embedded?: boolean; projectId?: string; runId?: string }>(), { embedded: false });
const emit = defineEmits<{ (event: "close"): void; (event: "open-plan", plan: Plan): void }>();
type ExecutionConversationGroup = {
  id: string;
  kind: "plan" | "task" | "user" | "unattributed" | "pending";
  task?: ExecutionTask;
  tasks?: ExecutionTask[];
  items: ExecutionStreamItem[];
};
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
const selectedTaskId = ref<string | null>(null);
const telemetryNow = ref(Date.now());
let runEventSource: EventSource | null = null;
let runEventSequence = 0;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let planDetailRequestToken = 0;
// ExecutionThread journal 是持久化事实，conversation projection 只负责把事实转换为可读消息。
// sequence 同时作为 SSE 游标，重连时从最后一条已接受的事件继续回放。
const loopStatusLabel = computed(() => formatAgentLoopState(executorLoop.value?.state, "无活动 Loop"));
const streamState = computed<"live" | "reconnecting" | "saved">(() =>
  runStreamConnected.value ? "live" : ["IN_PROGRESS", "STARTING"].includes(run.value?.status ?? "") ? "reconnecting" : "saved",
);
const executionStatusLabel = computed(() => ({ live: "实时", reconnecting: "重连中", saved: "已保存" })[streamState.value]);
const executionBlockReason = computed(() => {
  for (const entry of [...(thread.value?.journal ?? [])].reverse()) {
    const reason = entry.payload.reason ?? entry.payload.error;
    if (typeof reason === "string" && reason.trim()) return reason;
  }
  return null;
});
const executionTasks = computed<ExecutionTask[]>(() =>
  projectExecutionTasks(planTasks.value, thread.value?.journal ?? [], run.value?.status ?? ""),
);
const executionTaskCounts = computed(() => executionTaskSummary(executionTasks.value));
/**
 * Run 级活动：没有归属于任何执行步骤的 activity 条目——Run 的创建、生命周期钩子、验证、
 * 门禁、续跑检查点、暂停 / 恢复。它们讲的是整个 Run，不属于任何一步，所以**不留在执行会话里**，
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
/**
 * ④「Provider 说的」运行事实：压缩边界、重试、配额、钩子、后台子任务、权限被拒、告警。
 * 它们**不进会话正文**（权重表里一律 `hidden`），由顶部「运行上下文」卡承载——
 * 常态收在展开区里，需要你动手的那几条浮到卡片上（见 `ExecutionHeaderStatus` 的 `runtimeAlert`）。
 */
const runtimeFactItems = computed<ExecutionStreamItem[]>(() => executionMessages.value.filter(isRuntimeFactItem));

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
  const userMessages = executionMessages.value.filter((item) => item.kind === "user" && !item.taskId);
  if (userMessages.length) groups.push({ id: "user", kind: "user", items: userMessages });
  // 剩下的才是真正的归因缺口：本该落进某个执行步骤、却没有归属的模型 / 工具条目。
  // 现代 Run 不产生这类条目，它们集中在 2026-09-25 之前的数据里。
  const unattributed = executionMessages.value.filter(
    (item) => item.kind !== "plan" && item.kind !== "user" && !isRunActivity(item) && (!item.taskId || !taskIds.has(item.taskId)),
  );
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
    if (group.kind === "task" && group.task && group.items.length === 0) {
      pending.push(group.task);
      continue;
    }
    flush();
    collapsed.push(group);
  }
  flush();
  return collapsed;
}

/**
 * **这一步现在还在跑吗。** 它在跑的时候一切照常显示——照 OpenClaw：
 * *live response text and the working indicator stay outside the log*。跑完之后过程才折起来，
 * 把视线还给这一步的结论。
 *
 * 判据取任务自己的状态（`IN_PROGRESS`），不是"有没有最近的消息"——后者会把刚起步的一步
 * 当成跑完，把它唯一那两条线索折掉。
 */
function stepRunning(group: ExecutionConversationGroup): boolean {
  if (group.task) return group.task.status === "IN_PROGRESS";
  // 没有任务归属的组（未归属事件）：Run 还活着就当"进行中"，宁可多显示一行也不藏。
  return thread.value?.state === "ACTIVE";
}

/**
 * **折进上方过程记录的那一批**。判据全在 `foldsIntoProcess` 里——视图只负责回答"这一步跑完没有"。
 */
function foldedItems(group: ExecutionConversationGroup): ExecutionStreamItem[] {
  const stepRunningHere = stepRunning(group);
  return group.items.filter((item) => foldsIntoProcess(item, { stepRunning: stepRunningHere }));
}

/**
 * 按**权重**渲染（表在 utils/executionStream.ts 的 `EXECUTION_MESSAGE_WEIGHTS`）。
 * 视图不自己判断"这条该不该显示"：权重是产品决定，集中在一张表里，改那里即可。
 * `hidden` 的条目连计数都不进——它们不是内容，只是 Provider 的机制回显与运行事实。
 */
function visibleItems(group: ExecutionConversationGroup): ExecutionStreamItem[] {
  // 判据是"除折叠与不渲染之外"，不是"属于某几种权重"——写成白名单时，
  // 新增一种权重（比如你自己说的话那条 `answer`）会让那一类消息**从会话里静默消失**。
  const folded = new Set(foldedItems(group).map((item) => item.id));
  return group.items.filter((item) => executionMessageWeight(item) !== "hidden" && !folded.has(item.id));
}

/**
 * 这一步的用时。**来自任务自己的生命周期事实**（见 `ExecutionTask.startedAt`），
 * 不是从消息时间戳估的——拿不到就返回 null，由模板让那一格**不出现**，
 * 而不是编一个数（OpenClaw 的原话：拿不到时长就写 `Worked`，不估）。
 */
function stepDuration(group: ExecutionConversationGroup): string | null {
  const task = group.task;
  if (!task?.startedAt || !task.completedAt) return null;
  const ms = durationBetween(task.startedAt, task.completedAt);
  return ms === null ? null : formatDuration(ms);
}

/** 折起来的那批里，有几条是**认不出来的活动**——这件事本身要说得出口，不能悄悄折掉。 */
function unclassifiedCount(group: ExecutionConversationGroup): number {
  return foldedItems(group).filter((item) => item.messageType === "UNCLASSIFIED").length;
}

/**
 * 这一步里**没被折进去的失败**有多少。它要写在折叠标题上——
 * OpenClaw 的原话是 `Worked for 2 minutes, 3 seconds · 2 failed`：
 * 失败**永远可见**，即使这一组是收起的。折起来等于把这轮唯一要你处理的事藏了。
 */
function failedCount(group: ExecutionConversationGroup): number {
  return visibleItems(group).filter((item) => item.status === "FAILED").length;
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
/**
 * 还能不能补充要求：判据是 **Run 的状态**，不是线程的状态。
 *
 * 原来判的是 `thread.state !== COMPLETED`，而执行一收尾线程就被置成 `COMPLETED`——于是恰好在
 * "执行完了、还没合并、想再让它补一轮"这一刻输入框是禁用的（报障现场）。线程状态回答的是
 * "上一轮 Loop 还在不在"，Run 状态才回答"这个 Run 还需不需要人说话"。
 */
const canSendExecutionMessage = computed(() => canContinueRun(run.value?.status ?? ""));
/** 还有一轮在跑吗——决定补充要求是"交给这一轮"还是"起新的一轮"。 */
const executorLoopRunning = computed(() =>
  (run.value?.agentLoops ?? []).some(
    (loop) => loop.role === "executor" && ["CREATED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED"].includes(loop.state),
  ),
);
/** 一轮还在跑时的投递方式；没在跑时它不参与，服务端按 `auto` 自己定。 */
const executionGuidanceMode = ref<"steer" | "queue">("queue");
/** 输入框为什么不可用——空串表示可用。 */
const executionComposerDisabledReason = computed(() => {
  if (canSendExecutionMessage.value) return "";
  const status = run.value?.status ?? "";
  if (status === "BLOCKED" || status === "NEEDS_PLAN_CHANGE") return "这个 Run 卡在计划上，请改计划（创建更新版本）而不是补充要求";
  if (status === "CANCELLED" || status === "STALE") return "这个 Run 已经结束";
  return status ? `Run 处于 ${status}，不接受补充要求` : "";
});

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
    const target =
      (task.evidenceSequence ? executionTimeline.value?.querySelector<HTMLElement>(`[data-sequence="${task.evidenceSequence}"]`) : null) ??
      Array.from(executionTimeline.value?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []).find(
        (element) => element.dataset.taskId === task.id,
      );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
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

/** 接收单条 Run SSE；重复 sequence 直接忽略，避免重连导致消息重复。 */
function appendRunJournalEvent(event: RunJournalEvent): void {
  const currentThread = thread.value;
  if (!currentThread || event.sequence <= runEventSequence) return;
  const shouldFollow = isAtExecutionLatest();
  const entry: ExecutionJournalEntry = { sequence: event.sequence, type: event.type, occurredAt: event.occurredAt, payload: event.payload };
  const nextThread: ExecutionThread = {
    ...currentThread,
    state: event.threadState ?? currentThread.state,
    journal: [...currentThread.journal, entry],
    ...(event.threadTelemetry === undefined ? {} : { telemetry: event.threadTelemetry }),
  };
  thread.value = nextThread;
  runEventSequence = event.sequence;
  if (event.runStatus && run.value) run.value = { ...run.value, status: event.runStatus };
  rebuildExecutionMessages();
  // `MERGE_READY` **不在这里**：它曾经是这个 Run 的终点，但补充要求可以让同一个 Run 从它回到
  // `IN_PROGRESS` 再跑一轮。在这里把事件流关掉，页面就再也收不到那之后的任何事件——用户看到的是
  // 「已完成 / 等待合并」一动不动，直到手动刷新（实测就是这个症状）。
  // 真正终结的只有取消与合并；`BLOCKED` 保留，因为按设计它不接受补充要求（该走「创建更新版本」）。
  if (event.runStatus && ["BLOCKED", "CANCELLED", "MERGED"].includes(event.runStatus)) closeRunEvents();
  if (shouldFollow) scrollExecutionToLatest();
  else showScrollToLatest.value = true;
}

function applyStreamTelemetry(event: { threadTelemetry?: ExecutionThread["telemetry"] }): void {
  if (!thread.value || event.threadTelemetry === undefined) return;
  thread.value = { ...thread.value, telemetry: event.threadTelemetry };
}

/**
 * 为**仍可能产生事实**的 Run 建立 SSE；真正的终态 Run 依赖已加载的持久化 journal。
 *
 * `MERGE_READY` **不在"终态"之列**：补充要求可以让同一个 Run 从它回到 `IN_PROGRESS` 再跑一轮，
 * 所以它仍然会产生新事实。把它当终态，页面就永远停在加载时那一份 journal 上——用户看到的是
 * 「已完成 / 等待合并」一动不动，直到手动刷新（实测症状）。真正终结的只有取消与合并；
 * `BLOCKED` 保留，因为按设计它不接受补充要求（该走「创建更新版本」）。
 */
function connectRunEvents(): void {
  if (!run.value || typeof EventSource === "undefined" || ["BLOCKED", "CANCELLED", "MERGED"].includes(run.value.status)) return;
  runEventSource?.close();
  runEventSource = new EventSource(api.runEventsUrl(run.value.id, runEventSequence));
  runEventSource.addEventListener("open", () => {
    runStreamConnected.value = true;
  });
  runEventSource.addEventListener("stream.ready", (raw) => {
    runStreamConnected.value = true;
    try {
      applyStreamTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] });
    } catch {
      /* Initial GET remains the source of truth. */
    }
  });
  runEventSource.addEventListener("telemetry.updated", (raw) => {
    try {
      applyStreamTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] });
    } catch {
      /* The next poll or reconnect will recover the latest snapshot. */
    }
  });
  runEventSource.addEventListener("journal.entry", (raw) => {
    try {
      appendRunJournalEvent(JSON.parse((raw as MessageEvent).data) as RunJournalEvent);
    } catch {
      /* The next reconnect will replay from the last accepted sequence. */
    }
  });
  runEventSource.addEventListener("error", () => {
    runStreamConnected.value = false;
  });
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
function notifyError(caught: unknown) {
  error.value = caught instanceof Error ? caught.message : "操作失败，请稍后重试";
}
async function controlExecutorLoop(action: "pause" | "resume" | "cancel") {
  if (!executorLoop.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    if (action === "pause") await api.pauseAgentLoop(executorLoop.value.id, "user_requested");
    if (action === "resume") await api.resumeAgentLoop(executorLoop.value.id);
    if (action === "cancel") await api.cancelAgentLoop(executorLoop.value.id, "user_requested");
    await load();
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
  }
}
async function togglePause() {
  if (!run.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const response = thread.value?.state === "PAUSED" ? await api.resumeRun(run.value.id) : await api.pauseRun(run.value.id);
    run.value = response.run;
    setExecutionThread(response.thread);
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
  }
}
/** 终止前要求二次确认；服务端会同步取消关联 AgentLoop 并执行 cleanup。 */
async function terminateRun() {
  if (!run.value || actionBusy.value || !canTerminateRun(run.value.status)) return;
  try {
    await ElMessageBox.confirm("Terminate this run? The confirmed Plan will remain in history.", "终止 Run", {
      confirmButtonText: "Terminate",
      cancelButtonText: "Keep running",
      type: "warning",
    });
  } catch {
    return;
  }
  actionBusy.value = true;
  try {
    await api.cancelRun(run.value.id, "user_requested");
    ElMessage.success("Run 已终止");
    if (embedded.value) await load();
    else await router.push(`/projects/${projectId.value}/plans`);
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
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
async function sendExecutionMessage() {
  const content = executionDraft.value.trim();
  if (!run.value || !canSendExecutionMessage.value || !content || actionBusy.value) return;
  actionBusy.value = true;
  sendingExecutionMessage.value = true;
  try {
    // 一轮还在跑时由用户选"引导 / 排队"；没在跑时两种等价，交给服务端按实际状态自己定（`auto`）。
    const result = await api.addRunGuidance(run.value.id, content, executorLoopRunning.value ? executionGuidanceMode.value : "auto");
    setExecutionThread(result.thread);
    if (result.run) run.value = { ...run.value, ...result.run };
    executionDraft.value = "";
    // 说清它到底发生了什么：排队的要求还没到模型手里，和"已发送"不是一回事。
    ElMessage.success(
      result.continued
        ? "已发送，执行线程重新开工"
        : result.guidance.status === "CONSUMED"
          ? "已发送到执行线程"
          : "已排队，等这一轮结束后自动开工",
    );
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
    sendingExecutionMessage.value = false;
  }
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
  try {
    verification.value = (await api.verifyRun(run.value.id)).verification;
    await load();
    ElMessage.success("验证完成");
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
  }
}
async function createReview() {
  if (!run.value || !sourceCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try {
    mergeRequest.value = (await api.createMergeRequest(run.value.id, sourceCommit.value.trim())).mergeRequest;
    await load();
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
  }
}
async function confirmMerged() {
  if (!mergeRequest.value || !targetCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try {
    mergeRequest.value = (await api.confirmMerged(mergeRequest.value.id, targetCommit.value.trim())).mergeRequest;
    await load();
    ElMessage.success("已确认合并到目标 Commit");
  } catch (caught) {
    notifyError(caught);
  } finally {
    actionBusy.value = false;
  }
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
watch([projectId, runId], () => {
  resetPlanDetail();
  closeRunEvents();
  void load().then(() => {
    if (run.value) connectRunEvents();
  });
});
onMounted(async () => {
  telemetryTimer = setInterval(() => {
    if (executionTelemetry.value?.completedAt === null || executionTelemetry.value?.durationMs === null) telemetryNow.value = Date.now();
  }, 1000);
  void loadModelBackends();
  await load();
  connectRunEvents();
  scrollExecutionToLatest();
});
onBeforeUnmount(() => {
  requestScope.invalidate();
  closeRunEvents();
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
              v-for="group in executionConversationGroups"
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
  </div>
</template>
