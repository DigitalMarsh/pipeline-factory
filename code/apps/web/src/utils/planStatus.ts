/**
 * 模块职责：Plan 状态的**单份**英文展示文案。
 *
 * 维护提示：
 *   1) 这是全仓唯一一份 Plan 状态文案表。此前它有三份近似副本，且三份**已经两两分歧**（可核查）：
 *        - `views/ExplorerView.vue`（已并入本文件）：13 项，含 `DISCARDED` / `STARTING`。
 *        - `planTimeline.ts` 的私有 `statusLabel`：11 项，**缺** `DISCARDED` / `STARTING`，
 *          于是同一个 `DISCARDED` 在左侧时间线显示成 `DISCARDED`、在计划卡片上显示成 `Discarded`。
 *        - `planLifecycle.ts` 的 `PLAN_LIFECYCLE_STEPS` / `_EXCEPTIONS`：`MERGED` 标成
 *          **"Completed"**（另外两份都是 "Merged"），另有另外两份都没有的 `NEEDS_CONFIGURATION`。
 *      后两处**本步没有动**——合并且会改变界面上看得见的文案，属可见行为变更，要单独一个提交并
 *      先补锁定测试（见 P8.3）。在它们收敛之前，新增状态请改这里。
 *   2) 入参故意收 `string` 而不是 `PlanStatus`：`apps/web/src/types.ts` 的 `PlanStatus` 手抄自
 *      domain，**已知缺 `DESIGNED` / `PLANNED` 两个成员**（见 P8 的类型漂移守卫）。在漂移修好
 *      之前收窄成那个联合类型，会把两个合法状态挡在编译期之外。
 *   3) 未知状态**回落为原字符串**，不要回落为空串——后端新增状态时要能在页面上一眼看出来。
 */
export function planStatusLabel(status: string): string {
  return ({
    DRAFT: "Candidate",
    DISCARDED: "Discarded",
    READY: "Confirmed",
    ENQUEUED: "Enqueued",
    DISPATCHED: "Dispatched",
    QUEUED: "Queued",
    STARTING: "Starting",
    IN_PROGRESS: "Running",
    VERIFYING: "Verifying",
    MERGE_READY: "Ready for review",
    MERGED: "Merged",
    NEEDS_PLAN_CHANGE: "Plan change required",
    BLOCKED: "Blocked",
  } as Record<string, string>)[status] ?? status;
}
