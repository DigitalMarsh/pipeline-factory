/**
 * 模块职责：提供 Explorer Task 内容的严格归属判断。
 *
 * 没有 explorerPlanId 的记录不能在存在活动 Task 时被猜测挂到 Task 1。
 */
export function belongsToExplorerPlan(itemPlanId: string | null | undefined, activePlanId: string | null | undefined): boolean {
  if (!activePlanId) return true;
  return itemPlanId === activePlanId;
}
