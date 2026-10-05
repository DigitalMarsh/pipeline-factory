/**
 * 模块职责：Plan 状态的**单份**展示文案（中文）。
 *
 * 维护提示：
 *   1) 这是全仓唯一一份 Plan 状态文案表。它此前有三份近似副本，且三份**已经两两分歧**：
 *        - `views/ExplorerView.vue` 的一份（已删）：同一个 `DISCARDED` 在左侧时间线显示 `DISCARDED`、
 *          在计划卡片上显示 `Discarded`。
 *        - `planTimeline.ts` 的私有 `statusLabel`（已收敛到本文件）。
 *        - `planLifecycle.ts` 的 `PLAN_LIFECYCLE_STEPS` / `_EXCEPTIONS`（已改成引用本文件）。
 *      但同一件事还有**第二张表**在漂：`utils/statusVisual.ts` 里那行 `DRAFT: "Draft"` /
 *      `READY: "Ready"` / `MERGE_READY: "Needs review"`——于是同一个 Plan 状态在 Plan 抽屉里叫
 *      `Candidate`、在工作台上叫 `Draft`。那张表现在只保留**派发/等待**那几个 PlanStatus 之外的状态，
 *      Plan 状态的文案一律从本文件取（`statusVisual.test.ts` 钉住这条）。
 *   2) 入参故意收 `string` 而不是 `PlanStatus`：这些文案的调用点拿到的常常是普通字符串
 *      （journal 载荷、查询投影），收窄成联合类型会逼着调用点去断言。
 *   3) 未知状态**回落为原字符串**，不要回落为空串——后端新增状态时要能在页面上一眼看出来。
 *   4) **表里只放 `PlanStatus` 的取值**：`DESIGNED` / `PLANNED` / `QUEUED` 三个幽灵状态已从类型里删掉
 *      （全仓无写入点，8 个库零行），`STARTING` 是 `RunStatus` 不是 Plan 状态，也一并删掉——
 *      留在这里只会让人以为它们是 Plan 能到达的状态。
 */
export function planStatusLabel(status: string): string {
  return ({
    DRAFT: "草稿",
    DISCARDED: "已丢弃",
    READY: "已确认",
    ENQUEUED: "已入队",
    DISPATCHED: "已派发",
    IN_PROGRESS: "执行中",
    VERIFYING: "验证中",
    MERGE_READY: "待合并",
    MERGED: "已合并",
    BLOCKED: "已阻塞",
    NEEDS_PLAN_CHANGE: "需要改计划",
  } as Record<string, string>)[status] ?? status;
}
