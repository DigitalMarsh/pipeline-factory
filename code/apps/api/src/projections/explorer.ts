/**
 * 模块职责：ExplorerThread 的两个投影辅助 —— 按 Project 作用域解析线程
 *   `findProjectThread`，与需求状态事件的转发前脱敏 `sanitizeExplorerRequirementStatusEvent`。
 *
 * 维护提示：
 *   1) `findProjectThread` 是**跨项目访问的防线**，不是"少传一个参数的便利函数"：
 *      threadId 缺省时取 `parentThreadId === null` 的主线程；传了 threadId 也必须在**同一个
 *      projectId** 内命中。去掉 projectId 校验会让别的项目能用相同 Thread ID 读到本项目的线程。
 *   2) `sanitizeExplorerRequirementStatusEvent` 是 SSE 转发的**白名单**：事件类型、四个字段的
 *      类型、status 枚举、以及"ExplorerPlan 必须属于该 Thread 且属于该 Project"四条同时成立
 *      才返回转发载荷，否则返回 null。放宽任意一条都会把不属于当前订阅者的事件漏出去。
 *   3) 它是 `packages/domain` 之外的少量"业务判定留在 api 侧"的例子：判定要吃 `store.getExplorerPlan`
 *      的实时行，放到 domain 会逼出一个只为它存在的 Store 方法。**这不是遗漏**。
 */
import type { DomainEvent, ExplorerThread, PipelineStore } from "@pipeline-factory/domain";

export function sanitizeExplorerRequirementStatusEvent(
  store: Pick<PipelineStore, "getExplorerPlan">,
  thread: Pick<ExplorerThread, "id" | "projectId">,
  event: DomainEvent,
): { sequence: number; payload: { explorerPlanId: string; turnId: string | null; status: string; occurredAt: string } } | null {
  if (event.type !== "explorer.requirement.status.changed") return null;
  const explorerPlanId = event.payload.explorerPlanId;
  const turnId = event.payload.turnId;
  const status = event.payload.status;
  const occurredAt = event.payload.occurredAt;
  const allowedStatuses = new Set(["QUEUED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"]);
  if (
    typeof explorerPlanId !== "string" ||
    (typeof turnId !== "string" && turnId !== null) ||
    typeof status !== "string" ||
    !allowedStatuses.has(status) ||
    typeof occurredAt !== "string"
  )
    return null;
  const plan = store.getExplorerPlan(explorerPlanId);
  if (!plan || plan.explorerThreadId !== thread.id || plan.projectId !== thread.projectId) return null;
  return { sequence: event.sequence, payload: { explorerPlanId, turnId, status, occurredAt } };
}

/** 在指定 Project 内解析 Thread；不允许用相同 Thread ID 跨 Project 访问数据。 */
export function findProjectThread(store: PipelineStore, projectId: string, threadId?: string) {
  return store
    .listThreads()
    .find((thread) => thread.projectId === projectId && (threadId ? thread.id === threadId : thread.parentThreadId === null));
}
