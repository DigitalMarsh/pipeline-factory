/**
 * 模块职责：**任务中心的分区定义** —— 一个已确认 Plan 属于「待执行 / 执行中 / 已完成 / 待处理」
 * 四档中的哪一档，以及各档的数量。
 *
 * 为什么集中在这里：这套判定此前只写在 PlanCenterPanel 的一个下拉筛选项里（`filtered` 计算属性
 * 内联），于是 Workbench 的 Plan 列表用的是**另一套**（按状态原样排序、不分区）。同一个 Plan 在
 * 两个页面上被归到不同的档，是"管理视角"最容易出问题的地方；分区只能有一份定义。
 *
 * 维护提示：
 *   1) 判定**同时看 Plan 状态与 dispatch 状态**：派发中的等待（WAITING_*）与 `NEEDS_REVIEW` 只在
 *      dispatch 上有，只看 `plan.status` 会把"排队等容量"错报成"待执行"。
 *   2) 四档**互斥且穷尽**：任何 Plan 必落入一档，`taskBucketFor` 的兜底是 `pending`。
 *      新增 Plan 状态时想清楚它属于哪一档——留空会让它悄悄落到"待执行"。
 *   3) 文案就是界面上那四个词（待执行 / 执行中 / 已完成 / 待处理），改这里等于改两个页面。
 */
import type { Plan } from "../types";

export type TaskBucketKey = "pending" | "running" | "completed" | "attention";

export type TaskBucket = {
  key: TaskBucketKey;
  label: string;
  /** 粗粒度进度标签，供 Plan 详情等地方描述"这个 Plan 走到哪一步了"。 */
  progressLabel: string;
};

export const TASK_BUCKETS: readonly TaskBucket[] = [
  { key: "pending", label: "待执行", progressLabel: "等待执行" },
  { key: "running", label: "执行中", progressLabel: "执行中" },
  { key: "completed", label: "已完成", progressLabel: "已完成" },
  { key: "attention", label: "待处理", progressLabel: "待人工处理" },
] as const;

/** 一个 Plan 落在哪一档；派发中的等待状态优先于 Plan 自身的 READY/DISPATCHED。 */
export function taskBucketFor(plan: Plan): TaskBucketKey {
  const dispatchStatus = plan.dispatch?.status ?? "";
  if (plan.status === "MERGED") return "completed";
  if (["IN_PROGRESS", "VERIFYING"].includes(plan.status) || ["RUNNING", "VERIFYING"].includes(dispatchStatus)) return "running";
  if (["MERGE_READY", "BLOCKED", "NEEDS_PLAN_CHANGE"].includes(plan.status) || ["NEEDS_REVIEW", "BLOCKED"].includes(dispatchStatus)) return "attention";
  return "pending";
}

/** 各档数量；四档之和等于传入的 Plan 总数（互斥且穷尽）。 */
export function countTaskBuckets(plans: Plan[]): Record<TaskBucketKey, number> {
  const counts: Record<TaskBucketKey, number> = { pending: 0, running: 0, completed: 0, attention: 0 };
  for (const plan of plans) counts[taskBucketFor(plan)] += 1;
  return counts;
}

/**
 * 按档筛选；`"all"` 返回全部（保持传入顺序）。
 * 泛型保留元素类型：Workbench 传的是 `WorkbenchPlan[]`，丢了它下游就拿不到 planId 等必填字段。
 */
export function filterTasksByBucket<T extends Plan>(plans: T[], bucket: TaskBucketKey | "all"): T[] {
  return bucket === "all" ? [...plans] : plans.filter((plan) => taskBucketFor(plan) === bucket);
}
