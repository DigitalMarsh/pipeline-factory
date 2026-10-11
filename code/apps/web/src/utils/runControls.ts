/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export function canPauseRun(runStatus: string, threadState: string): boolean {
  return runStatus === "IN_PROGRESS" && (threadState === "ACTIVE" || threadState === "PAUSED");
}

/**
 * 能不能终止这个 Run。
 *
 * `BLOCKED` **在列**——它是后补的：服务端的 `cancellableStatuses` 一直含它（`routes/runs.ts`），
 * 只有这份客户端名单漏了。后果很具体：卡住的 Run 在界面上**一个操作都没有**，而它的 worktree
 * 会一直留在磁盘上（实测本机就有一条 `BLOCKED` 的残留目录、约几 MB）。两处名单不同步这种事，
 * 加一种状态时最容易漏的就是这条。
 *
 * **`MERGE_READY` 不在列**，但它有另一个入口「放弃这次运行」（`canAbandonRun`）：那是两句不同的话
 * ——终止是"这次执行停在这里"，放弃是"这份跑完的成果不要了"。
 */
export function canTerminateRun(runStatus: string): boolean {
  return ["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING", "BLOCKED"].includes(runStatus);
}

/**
 * **「放弃这次运行」：这个 Run 跑完了、在等合并，而你不打算合并它了。**
 *
 * 它与「终止」是同一套机制（取消 Agent Loop、收 worktree、跑 cleanup 钩子、Run → `CANCELLED`、
 * Plan → `BLOCKED`），差别只在**什么时候给**：`MERGE_READY` 被 `/cancel` 刻意挡在外面，因为
 * "取消一个待合并的运行"听起来像在丢成果。但"不打算合并了"是个真实状态，而它的 worktree 会一直
 * 占着磁盘（实测本机 13 条这样的 Run 占约 166 MB）。所以单开一个入口，把代价写在确认框里，
 * 而不是把 `MERGE_READY` 混进「终止」——那两种情况下用户要理解的后果不一样。
 */
export function canAbandonRun(runStatus: string): boolean {
  return runStatus === "MERGE_READY";
}

/** Returns whether the Run Control surface has at least one executable action. */
export function hasRunControlActions(runStatus: string, threadState: string): boolean {
  return (
    canTerminateRun(runStatus) ||
    canAbandonRun(runStatus) ||
    canPauseRun(runStatus, threadState) ||
    runStatus === "IN_PROGRESS" ||
    runStatus === "READY_FOR_VERIFY"
  );
}

/**
 * 还能不能往这个 Run 的执行线程里**补充要求**。
 *
 * 与领域侧的 `ACCEPTS_GUIDANCE_RUN_STATUSES` 同源，**两边必须一起改**——判据留在这里只是为了让
 * "按钮可不可用"能单测；最终说了算的仍然是服务端（客户端看到的 Run 状态可能已经过期）。
 *
 * 为什么用 Run 状态而不是线程状态：这条链原来的判据是"线程不是 COMPLETED / CANCELLED"，而执行一收尾
 * 线程就被置成 `COMPLETED`——于是**恰恰在最需要补充一次的时候**（执行完了、还没合并）输入框是禁用的。
 * 线程状态回答的是"上一轮 Loop 还在不在"，Run 状态才回答"这个 Run 还需不需要人说话"。
 *
 * - `MERGE_READY`：执行完了但没合并——报障现场，反过来最该能补；
 * - `RECOVERING`：进程重启后 Loop 被判死，而 `/resume` 对这条**根本走不通**（`scheduler.resume`
 *   要求 Run 是 `IN_PROGRESS` 且线程 `PAUSED`，这里是 `RECOVERING` + `ACTIVE`，只会回 409）——
 *   投一条补充要求是它**唯一还能往前走的路**，所以它非在集合里不可；
 * - `BLOCKED` 不在里面：那一种该走「创建更新版本」，补一句话会把真问题盖住；
 * - `CANCELLED` / `STALE` / `QUEUED` / `STARTING` 也不在：Run 已经结束或还没开始。
 */
export function canContinueRun(runStatus: string): boolean {
  return ["IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "MERGE_READY", "RECOVERING"].includes(runStatus);
}

/**
 * **这个 Run 还会不会再产生新事实。** 真正终结的只有取消与合并，外加设计上不接受补充要求的 `BLOCKED`
 * （那一种该走「创建更新版本」）。
 *
 * `MERGE_READY` **不在里面**：补充要求可以让同一个 Run 从它回到 `IN_PROGRESS` 再跑一轮。把它当终态，
 * 页面就再也收不到那之后的任何事件——用户看到的是「已完成 / 等待合并」一动不动，直到手动刷新
 * （实测就是这个症状）。
 *
 * 判据同时管两处，所以必须只有一份：**建连**（终态就别开流）与**收流**（跑到终态就关掉），
 * 两者都在 `composables/useRunStream.ts`。
 */
export const RUN_STREAM_TERMINAL_STATUSES: readonly string[] = ["BLOCKED", "CANCELLED", "MERGED"];

/**
 * Run Control 上的动作。定义在这里而不是各自声明：状态卡（`ExecutionHeaderStatus` 的
 * `run-action` / `loop-action`）与处理它们的 `composables/useRunControl.ts` 必须是**同一套取值**——
 * 此前两处各写一份字面量联合，加一种动作时漏改一处是静默的（TS 会把两边都当合法）。
 */
export type RunControlAction = "terminate" | "abandon" | "pause" | "resume" | "verify";
export type LoopControlAction = "pause" | "resume" | "cancel";
