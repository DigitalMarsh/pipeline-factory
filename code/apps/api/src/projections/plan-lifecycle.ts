/**
 * 模块职责：Plan 生命周期时间线的投影 —— 由 Plan 状态、Run、DispatchState 与 DomainEvent 现算出
 *   `PlanLifecycleEntry[]`（`buildPlanLifecycle`），以及挂在它上面的两个读模型
 *   `planProjection` / `decoratePlanRows`。
 *
 * 为什么在 `apps/api/src/projections/` 而不是 domain：这些函数无 IO、无 HTTP，逻辑上属于 domain，
 *   但搬进 domain 会同时触发"api → domain 公共 API 扩张"与"index.ts 又长一截"两个风险叠加，
 *   而 web 暂时不复用它们。**先物理隔离在 api 侧**（方案 P5 的决策）；等 P8 的 contracts 落地后，
 *   确认需要被 web 复用再下沉。
 *
 * 维护提示 —— 下面两条隐式契约的唯一记录点就在本文件里，改动前务必读完：
 *   1) `PLAN_LIFECYCLE_EVENT_TYPES` 上方的"在下面的循环里新增分支时，必须把对应事件类型加进来，
 *      否则该事件读不到"。
 *   2) `planEventAggregateIds` 上方的"新增在别的聚合上写 payload.planId 的事件类型时，必须同步
 *      扩展这里，否则该事件会在 Plan 时间线中丢失"。
 *   两条都属于"漏改不报错、只是事件静默消失"的类型，所以注释必须留在代码边上而不是挪到文件头。
 *
 * 另有两处看着像冗余、实则是行为契约的分支，不要顺手删：
 *   - `normalizedLifecycleStatus` 把历史值 `QUEUED` 归一成 `ENQUEUED`（老数据里两种写法并存）。
 *   - `buildPlanLifecycle` 末尾的"未确认却已推进 → 整条时间线塌缩成 DRAFT + BLOCKED"兜底：
 *     它消费 `plan.attentionReason`，是 UI 上"卡住原因"的来源。
 *
 * 依赖方向：本文件不依赖同目录其他投影。`workbench.ts` 单向依赖本文件的 `planProjection`。
 */
import type { CandidatePlan, ChangeProposal, MergeRequest, PipelineStore, PlanLifecycleEntry, PlanLifecycleStatus, Run } from "@pipeline-factory/domain";

const PLAN_LIFECYCLE_ORDER: Array<PlanLifecycleStatus> = ["DRAFT", "READY", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED"];

const PLAN_LIFECYCLE_NORMALIZED = new Set<PlanLifecycleStatus>(PLAN_LIFECYCLE_ORDER);
const PLAN_LIFECYCLE_PROGRESS_STATUSES = new Set<PlanLifecycleStatus>(["READY", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED", "BLOCKED", "NEEDS_PLAN_CHANGE", "NEEDS_CONFIGURATION"]);
const UNCONFIRMED_LIFECYCLE_REASON = "Plan lifecycle is invalid: it reached a later state without a confirmation record.";

function normalizedLifecycleStatus(value: unknown): PlanLifecycleStatus | null {
  if (value === "QUEUED") return "ENQUEUED";
  if (typeof value !== "string") return null;
  if (PLAN_LIFECYCLE_NORMALIZED.has(value as PlanLifecycleStatus)) return value as PlanLifecycleStatus;
  if (["BLOCKED", "NEEDS_PLAN_CHANGE", "NEEDS_CONFIGURATION"].includes(value)) return value as PlanLifecycleStatus;
  return null;
}

/**
 * buildPlanLifecycle 只消费这些事件类型；Store 据此在 SQL 层直接跳过其余行
 * （单个 ExplorerThread 聚合动辄两万余条 explorer.* 事件，对本时间线毫无贡献）。
 * 维护提示：在下面的循环里新增分支时，必须把对应事件类型加进来，否则该事件读不到。
 */
const PLAN_LIFECYCLE_EVENT_TYPES = [
  "plan.candidate.created", "plan.status.changed", "plan.confirmed", "plan.revision.confirmed",
  "plan.configuration.revised", "plan.enqueued", "plan.dispatched", "verification.completed",
  "change.proposal.created", "merge.confirmed", "plan.dispatch.state.changed",
] as const;

/**
 * 一次请求内共享的 Plan → Run → MergeRequest/ChangeProposal 索引。
 *
 * 为什么需要它：`planEventAggregateIds` 需要知道"这个 Plan 有哪些 Run、每个 Run 有哪些
 *   MergeRequest 与 ChangeProposal"，而它原先**每个 Plan 都调一次** `listMergeRequests()` 与
 *   `listRuns()`（两个都是全表 `SELECT *`），内层再对每个匹配 Run 调 `listChangeProposals`。
 *   而 `decoratePlanRows` 会对查询返回的**每一行**调一次 `planProjection` ——
 *   Plan Center 的 limit 上限是 100，于是单次列表请求等于 200 次全表读 + 上百次点查。
 *   改成"按请求建一次、沿调用链下传"后，这几张表每次都只读一遍。
 *
 * 维护提示：这是**一次请求的生命周期**内的快照，不要跨请求缓存——请求之间 Plan/Run 会变，
 *   缓存会让新 Run 的 MergeRequest 归不到所属 Plan 上。
 */
export type PlanLifecycleIndex = {
  runsByPlan: Map<string, Run[]>;
  mergeRequestsByRun: Map<string, MergeRequest[]>;
  proposalsByRun: Map<string, ChangeProposal[]>;
};

export function buildPlanLifecycleIndex(store: PipelineStore): PlanLifecycleIndex {
  const runsByPlan = new Map<string, Run[]>();
  for (const run of store.listRuns()) {
    const existing = runsByPlan.get(run.planId);
    if (existing) existing.push(run);
    else runsByPlan.set(run.planId, [run]);
  }
  const mergeRequestsByRun = new Map<string, MergeRequest[]>();
  for (const request of store.listMergeRequests()) {
    const existing = mergeRequestsByRun.get(request.runId);
    if (existing) existing.push(request);
    else mergeRequestsByRun.set(request.runId, [request]);
  }
  const proposalsByRun = new Map<string, ChangeProposal[]>();
  for (const proposal of store.listChangeProposals()) {
    const existing = proposalsByRun.get(proposal.runId);
    if (existing) existing.push(proposal);
    else proposalsByRun.set(proposal.runId, [proposal]);
  }
  return { runsByPlan, mergeRequestsByRun, proposalsByRun };
}

/**
 * 与某个 Plan 相关的事件可能落在多个聚合上：Plan 自身、它的 Run、Run 的 MergeRequest
 * 与 ChangeProposal，以及产生它的 ExplorerThread。这里把聚合 ID 收集齐，
 * 交给 Store 走 aggregate_id 索引，避免为了筛出几十条事件而把整张事件表读进内存。
 *
 * 维护提示：新增"在别的聚合上写 payload.planId"的事件类型时，必须同步扩展这里，
 * 否则该事件会在 Plan 时间线中丢失（buildPlanLifecycle 的谓词只在这批候选集内筛选）。
 */
function planEventAggregateIds(plan: CandidatePlan, index: PlanLifecycleIndex): string[] {
  const ids = new Set<string>([plan.id]);
  if (plan.sourceExplorerThreadId) ids.add(plan.sourceExplorerThreadId);
  for (const run of index.runsByPlan.get(plan.id) ?? []) {
    ids.add(run.id);
    for (const proposal of index.proposalsByRun.get(run.id) ?? []) ids.add(proposal.id);
    for (const request of index.mergeRequestsByRun.get(run.id) ?? []) ids.add(request.id);
  }
  return [...ids];
}

function buildPlanLifecycle(store: PipelineStore, plan: CandidatePlan, revision: number, index: PlanLifecycleIndex): PlanLifecycleEntry[] {
  const run = plan.runId ? store.getRun(plan.runId) : undefined;
  const dispatch = store.getDispatchState(plan.id);
  const currentStatus = dispatch?.waitReason === "NEEDS_CONFIGURATION" ? "NEEDS_CONFIGURATION" : normalizedLifecycleStatus(plan.status);
  const entries = new Map<PlanLifecycleStatus, PlanLifecycleEntry>();
  const eventPlanId = (payload: Record<string, unknown>) => typeof payload.planId === "string" ? payload.planId : null;
  const eventRevision = (payload: Record<string, unknown>) => typeof payload.revision === "number" ? payload.revision : null;
  const relevant = store.listEvents({ afterSequence: 0, aggregateIds: planEventAggregateIds(plan, index), types: PLAN_LIFECYCLE_EVENT_TYPES })
    .filter((event) => event.aggregateId === plan.id || event.aggregateId === run?.id || eventPlanId(event.payload) === plan.id);
  const add = (status: PlanLifecycleStatus, occurredAt: string | null, options: { reason?: string | null; runId?: string | null; eventRevision?: number | null } = {}) => {
    if (options.eventRevision !== null && options.eventRevision !== undefined && options.eventRevision !== revision) return;
    const existing = entries.get(status);
    if (existing && existing.occurredAt && occurredAt && existing.occurredAt <= occurredAt) return;
    entries.set(status, { status, occurredAt, revision, current: status === currentStatus, ...(options.reason !== undefined ? { reason: options.reason } : {}), ...(options.runId !== undefined ? { runId: options.runId } : {}), ...(run ? { executionThreadId: run.executionThreadId } : {}) });
  };

  add("DRAFT", plan.createdAt);
  if (plan.confirmedAt) add("READY", plan.confirmedAt);
  if (plan.queuedAt) add("ENQUEUED", plan.queuedAt);
  if (plan.dispatchedAt) add("DISPATCHED", plan.dispatchedAt);
  if (run?.startedAt) add("IN_PROGRESS", run.startedAt, { runId: run.id });

  for (const event of relevant) {
    const payload = event.payload;
    const eventRev = eventRevision(payload);
    const matchingEventRevision = eventRev ?? (revision === 1 ? null : -1);
    if (event.type === "plan.candidate.created") add("DRAFT", event.occurredAt, { eventRevision: matchingEventRevision });
    if (event.type === "plan.status.changed") {
      const status = normalizedLifecycleStatus(payload.toStatus);
      if (status) add(status, event.occurredAt, { reason: typeof payload.reason === "string" ? payload.reason : null, runId: typeof payload.runId === "string" ? payload.runId : null, eventRevision: eventRev });
    }
    if (event.type === "plan.confirmed" || event.type === "plan.revision.confirmed" || event.type === "plan.configuration.revised") add("READY", event.occurredAt, { eventRevision: matchingEventRevision });
    if (event.type === "plan.enqueued") add("ENQUEUED", typeof payload.queuedAt === "string" ? payload.queuedAt : event.occurredAt, { eventRevision: matchingEventRevision });
    if (event.type === "plan.dispatched") add("DISPATCHED", typeof payload.dispatchedAt === "string" ? payload.dispatchedAt : event.occurredAt, { eventRevision: matchingEventRevision });
    if (event.type === "verification.completed") {
      const verificationStatus = payload.status;
      add(verificationStatus === "PASSED" || verificationStatus === "SKIPPED" ? "MERGE_READY" : "BLOCKED", typeof payload.completedAt === "string" ? payload.completedAt : event.occurredAt, { reason: verificationStatus === "PASSED" || verificationStatus === "SKIPPED" ? null : "Verification failed", runId: run?.id ?? null, eventRevision: matchingEventRevision });
    }
    if (event.type === "change.proposal.created") add("NEEDS_PLAN_CHANGE", event.occurredAt, { reason: typeof payload.reason === "string" ? payload.reason : null, runId: typeof payload.runId === "string" ? payload.runId : null, eventRevision: matchingEventRevision });
    if (event.type === "merge.confirmed") add("MERGED", event.occurredAt, { runId: run?.id ?? null, eventRevision: matchingEventRevision });
    if (event.type === "plan.dispatch.state.changed" && payload.waitReason === "NEEDS_CONFIGURATION") add("NEEDS_CONFIGURATION", typeof payload.updatedAt === "string" ? payload.updatedAt : event.occurredAt, { reason: typeof payload.lastError === "string" ? payload.lastError : "Needs configuration", runId: typeof payload.runId === "string" ? payload.runId : null, eventRevision: eventRev });
  }

  if (dispatch?.waitReason === "NEEDS_CONFIGURATION") add("NEEDS_CONFIGURATION", dispatch.updatedAt ?? null, { reason: dispatch.lastError ?? "Needs configuration", runId: dispatch.runId });
  let lifecycleCurrentStatus = currentStatus;
  const hasConfirmation = entries.has("READY");
  const progressedWithoutConfirmation = !hasConfirmation && (
    [...entries.keys()].some((status) => status !== "DRAFT")
    || (currentStatus !== null && PLAN_LIFECYCLE_PROGRESS_STATUSES.has(currentStatus))
  );
  if (progressedWithoutConfirmation) {
    const draft = entries.get("DRAFT") ?? { status: "DRAFT" as const, occurredAt: plan.createdAt, revision, current: false };
    const existingBlocked = entries.get("BLOCKED");
    entries.clear();
    entries.set("DRAFT", { ...draft, current: false });
    entries.set("BLOCKED", {
      ...(existingBlocked ?? { status: "BLOCKED" as const, occurredAt: null, revision, current: true }),
      current: true,
      reason: existingBlocked?.reason ?? plan.attentionReason ?? UNCONFIRMED_LIFECYCLE_REASON,
      ...(existingBlocked?.runId === undefined && plan.runId ? { runId: plan.runId } : {}),
      ...(existingBlocked?.executionThreadId === undefined && run ? { executionThreadId: run.executionThreadId } : {}),
    });
    lifecycleCurrentStatus = "BLOCKED";
  }
  return [...entries.values()]
    .sort((a, b) => {
      const aOrder = PLAN_LIFECYCLE_ORDER.indexOf(a.status);
      const bOrder = PLAN_LIFECYCLE_ORDER.indexOf(b.status);
      return (aOrder < 0 ? PLAN_LIFECYCLE_ORDER.length : aOrder) - (bOrder < 0 ? PLAN_LIFECYCLE_ORDER.length : bOrder);
    })
    .map((entry) => ({ ...entry, current: entry.status === lifecycleCurrentStatus, ...(entry.runId === undefined && run ? { runId: run.id } : {}) }));
}

function planExecutionThread(store: PipelineStore, plan: CandidatePlan) {
  const run = plan.runId ? store.getRun(plan.runId) : undefined;
  if (!run) return null;
  const thread = store.getExecutionThread(run.executionThreadId);
  return { id: run.executionThreadId, runId: run.id, state: thread?.state ?? run.status };
}

/**
 * 单个 Plan 的读模型。`index` 可省略（单 Plan 调用时自建一次与原先的全表读等价）；
 * **列表路径必须显式传**同一个 index，否则就退化成每个 Plan 建一次索引。
 */
export function planProjection(store: PipelineStore, plan: CandidatePlan, index: PlanLifecycleIndex = buildPlanLifecycleIndex(store)) {
  return { confirmedAt: plan.confirmedAt ?? null, lifecycle: buildPlanLifecycle(store, plan, plan.revision, index), executionThread: planExecutionThread(store, plan) };
}

/** 将 PlanRevision 的快照版本与当前 Project 对比，供 Plan Center 显示 CURRENT/CHANGED/LEGACY。 */
export function decoratePlanRows(store: PipelineStore, rows: Array<{ planId: string; revision: number; projectId: string }>, index: PlanLifecycleIndex = buildPlanLifecycleIndex(store)) {
  return rows.map((row) => {
    const revision = store.getRevision(row.planId, row.revision);
    const plan = store.getPlan(row.planId);
    const snapshot = revision?.projectConfigSnapshot;
    const project = store.getProject(row.projectId);
    return {
      ...row,
      ...(plan ? planProjection(store, plan, index) : { confirmedAt: null, lifecycle: [], executionThread: null }),
      projectConfigVersion: revision?.projectConfigVersion ?? null,
      projectConfigHash: revision?.projectConfigHash ?? null,
      projectConfigStatus: !snapshot ? "LEGACY" : project && snapshot.configVersion === project.configVersion && snapshot.configHash === project.configHash ? "CURRENT" : "CHANGED",
      dispatch: store.getDispatchState(row.planId) ?? null,
      mergeRequest: plan?.runId ? store.findMergeRequestByRun(plan.runId) ?? null : null,
      ...(plan?.generatedSpec ? { generatedSpec: plan.generatedSpec } : {}),
      ...(plan?.resolvedContract ? { resolvedContract: plan.resolvedContract } : {}),
    };
  });
}
