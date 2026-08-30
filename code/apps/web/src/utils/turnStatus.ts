/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerTurn } from "../types";

/** 只把 assistant RUNNING 视为正在处理，用户消息和等待输入状态由页面分别呈现。 */
export function isExplorerTurnProcessing(turn: Pick<ExplorerTurn, "role" | "status">): boolean {
  return turn.role === "assistant" && turn.status === "RUNNING";
}
