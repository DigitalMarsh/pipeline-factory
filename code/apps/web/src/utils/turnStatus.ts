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

/**
 * 一个 Turn 在界面上要显示的内容文本（P7-4 从 `ExplorerView.vue` 下沉）。
 * 有正文就用正文，没有正文时按状态给一句人话：进行中 / 等待输入 / 失败原因 / 未返回。
 * `CANCELLED` / `PAUSED` / `QUEUED` / 无状态都落到最后一句，与下沉前的行为一致。
 */
export function turnContent(turn: Pick<ExplorerTurn, "content" | "status" | "error">): string {
  if (turn.content.trim()) return turn.content;
  if (turn.status === "RUNNING") return "Plan Explorer 正在处理…";
  if (turn.status === "WAITING_FOR_INPUT") return "Plan Explorer 正在等待你的选择…";
  return turn.status === "FAILED" ? `模型调用失败：${turn.error ?? "未知错误"}` : "模型未返回内容";
}
