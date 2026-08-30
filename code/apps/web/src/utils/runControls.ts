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
