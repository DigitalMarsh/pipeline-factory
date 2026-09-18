/**
 * 模块职责：把 ExplorerPlan 和其当前 Plan 投影为聊天区的 Task → Plan 树。
 * 维护提示：Task 只是 UI 术语，关联事实仍然使用 explorerPlanId。
 */
import type { ExplorerActivityItem, ExplorerPlan, Plan } from "../types";
import { getPlanTimelineTarget, planIdentity } from "./planTimeline";

export type TaskTreeItem = {
  task: ExplorerPlan;
  plan: Plan | null;
  planKey: string | null;
  planTarget: string | null;
};

export function taskDisplayTitle(task: ExplorerPlan): string {
  const placeholder = new RegExp(`^Plan ${task.ordinal}(?=$|\\s|/)`);
  return placeholder.test(task.title) ? task.title.replace(placeholder, `Task ${task.ordinal}`) : task.title;
}

export function taskRuntimeLabel(task: ExplorerPlan): string {
  return ({
    QUEUED: "排队中",
    RUNNING: "运行中",
    WAITING_FOR_INPUT: "等待输入",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
  } as Record<string, string>)[task.runtimeStatus ?? ""] ?? "待探索";
}

/**
 * 每个 Task 只挂一个当前 Plan。候选/生命周期投影可能重复出现同一 Plan，先按
 * planIdentity 去重，再按 explorerPlanId 或 Task 已持久化的 candidatePlanId 归属；没有明确归属的 Plan 不会被猜测挂载。
 */
export function buildTaskTree(tasks: ExplorerPlan[], plans: Plan[], activities: ExplorerActivityItem[]): TaskTreeItem[] {
  const candidatePlanIds = new Set(tasks.map((task) => task.candidatePlanId).filter((planId): planId is string => Boolean(planId)));
  const uniquePlans = new Map<string, Plan>();
  for (const plan of plans) {
    const identity = planIdentity(plan);
    if (plan.explorerPlanId || candidatePlanIds.has(identity)) uniquePlans.set(identity, plan);
  }

  return [...tasks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((task) => {
      const plan = [...uniquePlans.values()].find((candidate) => candidate.explorerPlanId === task.id || (task.candidatePlanId !== null && planIdentity(candidate) === task.candidatePlanId)) ?? null;
      return {
        task,
        plan,
        planKey: plan ? `plan-${planIdentity(plan)}` : null,
        planTarget: plan ? getPlanTimelineTarget(plan, activities, [...uniquePlans.values()]) : null,
      };
    });
}
