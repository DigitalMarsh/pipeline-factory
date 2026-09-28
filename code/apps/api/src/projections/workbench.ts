/**
 * 模块职责：Workbench（项目执行台）快照投影 `workbenchSnapshot`，以及事件归属判定器
 *   `createProjectEventScope`。
 *
 * 维护提示：
 *   1) **快照只回放事件尾部**：先按 `WORKBENCH_EVENT_TAIL_LIMIT` 从 Store 取窗口，再截
 *      `WORKBENCH_EVENT_LIMIT` 条。UI 的 Evidence 面板只看最近若干条，全量历史会把响应放大到
 *      数十 MB；更早的事件仍可通过 SSE 的 Last-Event-ID 或各资源详情接口按需获取。
 *      这不是"分页没做完"。
 *   2) `createProjectEventScope` 构造时一次性建立三张索引（aggregateId → projectId、
 *      mergeRequest → runId、loop → owner），之后每条事件只做 Map 查询。
 *      **不要在过滤循环里改成逐条查 store**：十万级事件会退化成数十万次单行查询。
 *   3) Loop 的 ownerType 有三类可以反查到 Project（`run` / `explorer-turn` /
 *      `project-execution-turn`）。新增第四类 owner 时，必须同时在上面的索引建立处补映射，
 *      否则该 Loop 的事件在 Workbench 里静默读不到。
 *
 * 依赖方向：单向依赖 `./plan-lifecycle.js` 的 `planProjection`；`ProjectService` 由调用方传入，
 *   本模块不持有组合根状态（这是它能被直接 import 而不是回调注入的原因）。
 */
import type { DomainEvent, PipelineStore, ProjectService } from "@pipeline-factory/domain";
import { planProjection } from "./plan-lifecycle.js";

/** Workbench 首次加载回放的事件尾部窗口与最终保留条数；实时增量仍由 SSE 提供。 */
export const WORKBENCH_EVENT_TAIL_LIMIT = 4_000;
const WORKBENCH_EVENT_LIMIT = 400;

export function workbenchSnapshot(store: PipelineStore, projects: ProjectService, projectId: string) {
  const project = projects.get(projectId);
  const projectRows = [{ ...project, summary: projects.summary(project.id) }];
  const plans = store.listPlans()
    .filter((plan) => plan.projectId === projectId)
    .filter((plan) => plan.status !== "DRAFT" && plan.status !== "DISCARDED")
    .map((plan) => ({
      planId: plan.id,
      title: plan.title,
      revision: plan.revision,
      status: plan.status,
      projectId: plan.projectId,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      sourceTurnId: plan.sourceTurnId,
      providerThreadId: plan.providerThreadId,
      providerTurnId: plan.providerTurnId,
      providerItemId: plan.providerItemId,
      createdAt: plan.createdAt,
      queuedAt: plan.queuedAt,
      dispatchedAt: plan.dispatchedAt ?? null,
      runId: plan.runId,
      lastEventAt: plan.lastEventAt,
      attentionReason: plan.attentionReason,
      contract: plan.contract,
      dispatch: store.getDispatchState(plan.id) ?? null,
      ...planProjection(store, plan),
    }));
  const runs = store.listRuns().filter((run) => run.projectId === projectId).map((run) => ({
    ...run,
    planTitle: store.getPlan(run.planId)?.title ?? run.planId,
    dispatch: store.getDispatchState(run.planId) ?? null,
  }));
  // 只回放事件尾部：UI 的 Evidence 面板仅展示最近若干条，全量历史会把响应放大到数十 MB。
  // 更早的事件仍可通过 SSE 的 Last-Event-ID 或各资源详情接口按需获取。
  const belongsToProject = createProjectEventScope(store, projectId);
  const events = store.listEvents({ afterSequence: 0, limit: WORKBENCH_EVENT_TAIL_LIMIT })
    .filter((event) => belongsToProject(event))
    .slice(-WORKBENCH_EVENT_LIMIT);
  return {
    activeProjectId: projectId,
    projects: projectRows,
    plans,
    runs,
    dispatchStates: store.listDispatchStates(projectId),
    events,
    cursor: store.getLastEventSequence(),
  };
}

/**
 * 事件归属判定器。构造时一次性建立 aggregateId → projectId 索引，
 * 之后对每条事件只做 Map 查询；否则十万级事件会退化成数十万次单行查询。
 */

export function createProjectEventScope(store: PipelineStore, projectId: string): (event: DomainEvent) => boolean {
  const aggregateProject = new Map<string, string>();
  const mergeRequestRun = new Map<string, string>();
  const loopOwners = new Map<string, { ownerType: string; ownerId: string }>();

  for (const project of store.listProjects()) {
    const executionThread = store.getProjectExecutionThread(project.id);
    if (!executionThread) continue;
    aggregateProject.set(executionThread.id, project.id);
    // Loop 的 ownerType=project-execution-turn 以消息 ID 反查 Project，这里一并建立索引。
    for (const message of store.listProjectExecutionMessages(executionThread.id)) aggregateProject.set(message.id, project.id);
  }
  for (const thread of store.listThreads()) {
    aggregateProject.set(thread.id, thread.projectId);
    // Loop 的 ownerType=explorer-turn 以 Turn ID 反查 Project。
    for (const turn of store.listTurns(thread.id)) aggregateProject.set(turn.id, thread.projectId);
  }
  for (const plan of store.listPlans()) aggregateProject.set(plan.id, plan.projectId);
  for (const run of store.listRuns()) aggregateProject.set(run.id, run.projectId);
  for (const request of store.listMergeRequests()) mergeRequestRun.set(request.id, request.runId);
  for (const loop of store.listAgentLoops()) loopOwners.set(loop.id, { ownerType: loop.ownerType, ownerId: loop.ownerId });

  const resolveProject = (aggregateId: string): string | null => {
    const direct = aggregateProject.get(aggregateId);
    if (direct) return direct;
    const runId = mergeRequestRun.get(aggregateId);
    if (runId) return aggregateProject.get(runId) ?? null;
    const loop = loopOwners.get(aggregateId);
    if (!loop) return null;
    // 三类 owner 都已经在上面的索引里映射到 Project：run / explorer-turn / project-execution-turn。
    if (loop.ownerType === "run" || loop.ownerType === "explorer-turn" || loop.ownerType === "project-execution-turn") return aggregateProject.get(loop.ownerId) ?? null;
    return null;
  };

  return (event) => event.payload.projectId === projectId || resolveProject(event.aggregateId) === projectId;
}
