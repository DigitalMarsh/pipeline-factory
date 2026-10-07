/**
 * 模块职责：Plan Explorer 的**需求投影**——需求分组 / 候选 / 已确认 / 已入队 / 已派发，
 * 以及当前需求的**工作区与活动**（turns 写入点、activity、agentLoop、输入请求回收）。
 *
 * 为什么这一整块能成为一步：视图里所有"投影刷新"的入口最后都落到这两个函数上
 * （`refreshPlanProjection` 与 `refreshActivity`），它们是**投影状态与会话状态的唯一交汇点**。
 * `scheduleProjectionRefresh` 把流式增量期间的重复刷新合并到固定间隔，两者一起在这里。
 *
 * 维护提示：
 * 1. **`explorerEventSequence`（SSE 续传游标）归本文件。** 它的写侧只有两处，
 *    都是投影加载（workspace / activity 响应带的 `lastEventSequence`）与复位；
 *    读侧全部在 `useExplorerSse`。**写侧唯一，所以不需要等 SSE 抽取**——连接 composable
 *    以 ref 读它即可，不要再搬或复制。
 * 2. **`loadActivePlanWorkspace` 会写会话状态。** 它写 `turns` / `activity` / `agentLoop` /
 *    `explorerPaused` / `inputDialogOpen` 并调 `setInputRequests`——这些是**入参 ref**
 *    （见 `PlanProjectionDeps`），不是本文件的私有状态。不要为了"少几个入参"把它们
 *    也搬进来：会话状态的复位（线程级 vs 项目级）有它自己的归属，见 `useExplorerSession`。
 * 3. **投影世代（`beginPlanProjection` / `isCurrentPlanProjection`）是"发起时捕获、返回后比对"
 *    的那套惯用法**，与项目切换令牌守卫（`useExplorerSession`）同形但独立：
 *    它防的是"两次投影刷新乱序返回"，而令牌防的是"项目已切换"。**两者都要留。**
 *    视图里 `selectExplorerPlan` 也在用它，所以以两个具名函数暴露，不暴露可写计数器。
 * 4. `applyPlanProjection` / `loadActivePlanWorkspace` / `planFromRevisionDraft` 在视图侧
 *    **仍有调用方**（`loadExplorerDetails` / `openPlanDetail`），所以它们是公开面的一部分，
 *    不是内部实现细节。
 */
import { computed, ref, type Ref } from "vue";
import { api } from "../api";
import type {
  AgentLoop,
  ExplorerActivityItem,
  ExplorerInputRequest,
  ExplorerPlan,
  ExplorerThread,
  ExplorerTurn,
  Plan,
  PlanRevisionDraft,
} from "../types";
import { normalizePlanProjection, planFromRevisionDraft as revisionDraftToPlan } from "../utils/planProjection";
import { optional } from "../utils/optional";
import { planIdentity } from "../utils/planTimeline";

/**
 * 流式增量期间把 activity / plan 投影的重新拉取合并到固定间隔；文本本身仍按事件即时合并到
 * turn，因此观感不受影响，但不会每个增量都触发 6 次请求。
 *
 * **导出**：`useExplorerSse` 的 Agent Loop 刷新合并也使用同一个节拍语义，
 * 不要在两个 composable 各保留一个 400 的字面量。
 */
export const PROJECTION_REFRESH_INTERVAL_MS = 400;

export type PlanProjectionDeps = {
  projectId: Ref<string>;
  thread: Ref<ExplorerThread | null>;
  /** 会话状态：投影加载会写这几份（见维护提示 2）。 */
  turns: Ref<ExplorerTurn[]>;
  activity: Ref<ExplorerActivityItem[]>;
  agentLoop: Ref<AgentLoop | null>;
  explorerPaused: Ref<boolean>;
  inputDialogOpen: Ref<boolean>;
  pendingInput: Ref<ExplorerInputRequest | null>;
  setInputRequests: (items: ExplorerInputRequest[]) => void;
  /** 会话状态的项目切换守卫，逐字沿用其两个访问器（见 `useExplorerSession`）。 */
  projectScopeToken: () => number;
  isCurrentProjectScope: (requestProjectId: string, requestToken?: number) => boolean;
  /** 路由上请求的需求 id；只在 `refreshPlanProjection` 的三级回退里读一次，用 getter 而非 ref。 */
  routeExplorerPlanId: () => string | null;
};

export function usePlanProjection(deps: PlanProjectionDeps) {
  const explorerPlans = ref<ExplorerPlan[]>([]);
  const threadPlans = ref<Plan[]>([]);
  const activeExplorerPlanId = ref<string | null>(null);
  const candidate = ref<Plan | null>(null);
  const revisionDraft = ref<PlanRevisionDraft | null>(null);
  const confirmedPlans = ref<Plan[]>([]);
  const enqueued = ref<Plan[]>([]);
  const dispatched = ref<Plan[]>([]);
  const explorerEventSequence = ref<number | null>(null);

  let planProjectionVersion = 0;
  let projectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  const activeExplorerPlan = computed(() => {
    const requested = activeExplorerPlanId.value ?? deps.thread.value?.activeExplorerPlanId ?? explorerPlans.value[0]?.id;
    return explorerPlans.value.find((plan) => plan.id === requested) ?? explorerPlans.value[0] ?? null;
  });

  const allPlans = computed<Plan[]>(() => {
    const unique = new Map<string, Plan>();
    for (const plan of [candidate.value, ...confirmedPlans.value, ...enqueued.value, ...dispatched.value])
      if (plan) unique.set(planIdentity(plan), plan);
    return [...unique.values()];
  });

  /** 开始新的投影世代：让所有在途的投影刷新作废，并返回新世代号。 */
  function beginPlanProjection(): number {
    planProjectionVersion += 1;
    return planProjectionVersion;
  }

  function isCurrentPlanProjection(version = planProjectionVersion): boolean {
    return version === planProjectionVersion;
  }

  function planFromRevisionDraft(item: PlanRevisionDraft): Plan {
    return revisionDraftToPlan(item, activeExplorerPlanId.value);
  }

  function applyPlanProjection(
    projection: ReturnType<typeof normalizePlanProjection>,
    confirmed: Plan[],
    activeRevisionDraft: PlanRevisionDraft | null = null,
  ): void {
    deps.thread.value = projection.thread;
    revisionDraft.value = activeRevisionDraft;
    candidate.value = activeRevisionDraft ? planFromRevisionDraft(activeRevisionDraft) : projection.candidate;
    confirmedPlans.value = confirmed.filter((plan) => plan.status === "READY");
    enqueued.value = projection.dispatched.filter((plan) => plan.status === "ENQUEUED");
    dispatched.value = projection.dispatched.filter((plan) => plan.dispatchedAt !== null && plan.dispatchedAt !== undefined);
  }

  async function loadActivePlanWorkspace(
    explorerId: string,
    explorerPlanId: string | null,
    requestProjectId: string,
    requestToken: number,
  ): Promise<boolean> {
    if (!explorerPlanId) return true;
    const workspace = await api.explorerPlanWorkspace(requestProjectId, explorerId, explorerPlanId);
    if (!deps.isCurrentProjectScope(requestProjectId, requestToken) || deps.thread.value?.id !== explorerId) return false;
    deps.turns.value = workspace.turns;
    deps.activity.value = workspace.activity;
    deps.setInputRequests(workspace.inputRequests);
    candidate.value = workspace.candidate;
    revisionDraft.value = workspace.revisionDraft;
    deps.agentLoop.value = [...workspace.loops].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0] ?? null;
    deps.explorerPaused.value = deps.agentLoop.value?.state === "PAUSED";
    explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, workspace.lastEventSequence ?? 0);
    deps.inputDialogOpen.value = Boolean(deps.pendingInput.value?.isBlocking);
    return true;
  }

  async function refreshPlanProjection(): Promise<void> {
    const explorerId = deps.thread.value?.id;
    if (!explorerId) return;
    const requestProjectId = deps.projectId.value;
    const requestToken = deps.projectScopeToken();
    const requestVersion = beginPlanProjection();
    try {
      const [explorerResponse, planGroupsResponse, plansResponse, confirmedResponse, threadPlansResponse] = await Promise.all([
        api.explorer(requestProjectId, explorerId),
        api.explorerPlanGroups(requestProjectId, explorerId),
        api.explorerPlans(requestProjectId, explorerId),
        optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId)),
        api.explorerThreadPlans(requestProjectId, explorerId),
      ]);
      if (
        !deps.isCurrentProjectScope(requestProjectId, requestToken) ||
        !isCurrentPlanProjection(requestVersion) ||
        deps.thread.value?.id !== explorerId
      )
        return;
      explorerPlans.value = planGroupsResponse.items;
      threadPlans.value = threadPlansResponse.items;
      const routePlanId = deps.routeExplorerPlanId();
      activeExplorerPlanId.value = explorerPlans.value.some((plan) => plan.id === activeExplorerPlanId.value)
        ? activeExplorerPlanId.value
        : explorerPlans.value.some((plan) => plan.id === routePlanId)
          ? routePlanId
          : explorerPlans.value.some((plan) => plan.id === explorerResponse.explorer.activeExplorerPlanId)
            ? (explorerResponse.explorer.activeExplorerPlanId ?? null)
            : (explorerPlans.value[0]?.id ?? null);
      const projection = normalizePlanProjection(explorerResponse.explorer, null, plansResponse.items);
      applyPlanProjection(projection, confirmedResponse?.items ?? [], null);
      await loadActivePlanWorkspace(explorerId, activeExplorerPlanId.value, requestProjectId, requestToken);
    } catch {
      // 事件流追赶期间保留上一次投影，避免切换或重连时页面短暂清空。
    }
  }

  async function refreshActivity() {
    if (!deps.thread.value) return;
    const explorerPlanId = activeExplorerPlan.value?.id;
    if (!explorerPlanId) return;
    const requestProjectId = deps.projectId.value;
    const requestThreadId = deps.thread.value.id;
    const requestToken = deps.projectScopeToken();
    try {
      const response = await api.explorerActivity(requestProjectId, requestThreadId, explorerPlanId);
      if (
        !deps.isCurrentProjectScope(requestProjectId, requestToken) ||
        deps.thread.value?.id !== requestThreadId ||
        activeExplorerPlan.value?.id !== explorerPlanId
      )
        return;
      deps.activity.value = response.items;
      explorerEventSequence.value = Math.max(explorerEventSequence.value ?? 0, response.lastEventSequence ?? 0);
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
      if (!deps.thread.value) return;
      void refreshActivity();
      void refreshPlanProjection();
    }, PROJECTION_REFRESH_INTERVAL_MS);
  }

  function cancelProjectionRefresh() {
    if (projectionRefreshTimer === null) return;
    clearTimeout(projectionRefreshTimer);
    projectionRefreshTimer = null;
  }

  /**
   * 线程级复位的投影部分。`planCenterCount` / `agentLoop` / `inputDialogOpen` 等
   * **不在本函数范围内**——它们分属视图与其它 composable，由视图的 `resetThreadState` 各自复位。
   */
  function resetPlanProjection(): void {
    explorerPlans.value = [];
    threadPlans.value = [];
    activeExplorerPlanId.value = null;
    candidate.value = null;
    revisionDraft.value = null;
    confirmedPlans.value = [];
    enqueued.value = [];
    dispatched.value = [];
    explorerEventSequence.value = null;
    // 复位也必须让在途的投影刷新作废，否则旧响应会填回刚清空的投影。
    beginPlanProjection();
  }

  return {
    explorerPlans,
    threadPlans,
    activeExplorerPlanId,
    candidate,
    revisionDraft,
    confirmedPlans,
    enqueued,
    dispatched,
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
  };
}
