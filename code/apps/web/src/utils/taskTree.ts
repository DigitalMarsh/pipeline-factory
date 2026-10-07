/**
 * 模块职责：把 ExplorerPlan 和其当前 Plan 投影为聊天区的「需求 → 方案」树。
 *
 * **三层命名（全仓界面统一用这一套，别再各叫各的）：**
 *   1) **需求** = `ExplorerPlan`（一次需求探索，编号显示为"需求N：…"）。本文件的 `TaskTreeItem.task`
 *      与 `taskDisplayTitle` 里的 "Task" 是这一层的**旧称**，标识符保留以免牵动调用点，
 *      但界面上与新增注释一律叫"需求"。
 *   2) **方案** = `Plan` / `PlanRevision`（需求探索出的可审阅、可确认、有版本的执行计划）。
 *   3) **任务** = 已确认并进入调度的方案（任务中心里的条目，`TaskBucketKey` 那四档说的是它）。
 *   4) **执行步骤** = 方案契约里的 `contract.tasks`（一次 Run 内部按序实现的步骤），
 *      UI 里不叫"任务"——它与第 3 层的"任务"不是一回事，混用会让人找不到东西。
 *
 * 维护提示：**关联事实仍然使用 explorerPlanId**（API 与领域命名不动）；改名只发生在界面文案。
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
  const legacyTitle = task.title.replace(new RegExp(`^(?:Plan|Task) ${task.ordinal}\\s*(?:[/：:]\\s*)?`), "").trim();
  const label = task.titleSource === "MANUAL" ? legacyTitle || task.title : task.latestUserMessageSummary || legacyTitle || "待探索";
  return `需求${task.ordinal}：${label}`;
}

export function taskRuntimeLabel(task: ExplorerPlan): string {
  return (
    (
      {
        QUEUED: "排队中",
        RUNNING: "运行中",
        WAITING_FOR_INPUT: "等待输入",
        PAUSED: "已暂停",
        COMPLETED: "已完成",
        FAILED: "失败",
        CANCELLED: "已取消",
      } as Record<string, string>
    )[task.runtimeStatus ?? ""] ?? "待探索"
  );
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
      const plan =
        [...uniquePlans.values()].find(
          (candidate) =>
            candidate.explorerPlanId === task.id || (task.candidatePlanId !== null && planIdentity(candidate) === task.candidatePlanId),
        ) ?? null;
      return {
        task,
        plan,
        planKey: plan ? `plan-${planIdentity(plan)}` : null,
        planTarget: plan ? getPlanTimelineTarget(plan, activities, [...uniquePlans.values()]) : null,
      };
    });
}
