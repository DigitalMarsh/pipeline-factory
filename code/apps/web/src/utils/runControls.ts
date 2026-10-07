/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export function canPauseRun(runStatus: string, threadState: string): boolean {
  return runStatus === "IN_PROGRESS" && (threadState === "ACTIVE" || threadState === "PAUSED");
}

export function canTerminateRun(runStatus: string): boolean {
  return ["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"].includes(runStatus);
}

/** Returns whether the Run Control surface has at least one executable action. */
export function hasRunControlActions(runStatus: string, threadState: string): boolean {
  return (
    canTerminateRun(runStatus) || canPauseRun(runStatus, threadState) || runStatus === "IN_PROGRESS" || runStatus === "READY_FOR_VERIFY"
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
 * - `RECOVERING`：进程重启后 Loop 被判死，同样是"只能取消、不能继续"的死胡同；
 * - `BLOCKED` / `NEEDS_PLAN_CHANGE` 不在里面：那两种该走「创建更新版本」，补一句话会把真问题盖住；
 * - `CANCELLED` / `STALE` / `QUEUED` / `STARTING` 也不在：Run 已经结束或还没开始。
 */
export function canContinueRun(runStatus: string): boolean {
  return ["IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "MERGE_READY", "RECOVERING"].includes(runStatus);
}
