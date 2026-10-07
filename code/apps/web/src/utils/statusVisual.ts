/**
 * 模块职责：状态的**语义色**（Element Plus 的 `tone`），以及 PlanStatus 之外那几个
 * 派发 / 等待 / 运行状态的文案。页面不再各自定义颜色。
 *
 * 维护提示：
 *   1) **Plan 状态的文案不在这里**，一律从 `planStatus.ts` 取——这里此前另有一份
 *      （`DRAFT: "Draft"` / `READY: "Ready"` / `MERGE_READY: "Needs review"`），
 *      与那份已经漂成了两套词，同一个 Plan 在抽屉里叫 `Candidate`、在工作台上叫 `Draft`。
 *      本文件只留 PlanStatus **之外**的状态（派发等待原因、运行态），它们没有别处可依赖。
 *   2) 未知状态回落成"首字母大写的人话"（`SOME_FUTURE_STATUS` → `Some future status`），
 *      不回落为空串：新增状态时要能在页面上一眼看出来。
 */
import { planStatusLabel } from "./planStatus";

export type StatusVisual = { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" };

/** 不是 PlanStatus 的那几个：派发等待原因、派发中间态、运行态。 */
const DISPATCH_STATUS_VISUALS: Record<string, StatusVisual> = {
  WAITING: { label: "等待中", tone: "warning" },
  WAITING_DEPENDENCY: { label: "等待中 · 前置未就绪", tone: "warning" },
  WAITING_CONFLICT: { label: "等待中 · 资源冲突", tone: "warning" },
  WAITING_PROJECT_CAPACITY: { label: "等待中 · 项目并发已满", tone: "warning" },
  WAITING_GLOBAL_CAPACITY: { label: "等待中 · 全局并发已满", tone: "warning" },
  NEEDS_CONFIGURATION: { label: "需要配置", tone: "danger" },
  DISPATCHING: { label: "派发中", tone: "info" },
  NEEDS_REVIEW: { label: "待复核", tone: "warning" },
  RUNNING: { label: "执行中", tone: "info" },
  COMPLETED: { label: "已完成", tone: "success" },
  CANCELLED: { label: "已取消", tone: "neutral" },
};

/** Plan 状态各自的语气色：文案在 `planStatus.ts`，这里只管它配哪种颜色。 */
const PLAN_STATUS_TONES: Record<string, StatusVisual["tone"]> = {
  DRAFT: "neutral",
  DISCARDED: "neutral",
  READY: "info",
  ENQUEUED: "warning",
  DISPATCHED: "info",
  QUEUED: "warning",
  STARTING: "info",
  IN_PROGRESS: "info",
  VERIFYING: "info",
  MERGE_READY: "warning",
  MERGED: "success",
  BLOCKED: "danger",
  NEEDS_PLAN_CHANGE: "danger",
};

export function statusVisualFor(status: string): StatusVisual {
  const dispatch = DISPATCH_STATUS_VISUALS[status];
  if (dispatch) return dispatch;
  // 认不出来的状态 `planStatusLabel` 原样返回——那说明两张表都不认识它，按老规矩人性化一下。
  const label = planStatusLabel(status);
  if (label === status) {
    return {
      label: status
        .replaceAll("_", " ")
        .toLowerCase()
        .replace(/^./, (character) => character.toUpperCase()),
      tone: "neutral",
    };
  }
  return { label, tone: PLAN_STATUS_TONES[status] ?? "neutral" };
}
