/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerTurn } from "../types";

export type OptimisticUserTurnInput = Pick<ExplorerTurn, "id" | "threadId" | "content" | "createdAt" | "sequence">;
export type ExplorerTurnPair = { user: ExplorerTurn; assistant: ExplorerTurn };

/** 在异步 API 返回前创建临时用户消息，提升发送反馈且不伪造 assistant 内容。 */
export function createOptimisticUserTurn(input: OptimisticUserTurnInput): ExplorerTurn {
  return { ...input, role: "user" };
}

/** 用服务端事实替换临时用户消息，并只追加一次 assistant 占位，避免重试重复显示。 */
export function settleOptimisticTurn(turns: ExplorerTurn[], optimisticUserId: string, serverTurn: ExplorerTurnPair): ExplorerTurn[] {
  const replaced = turns.map((turn) => turn.id === optimisticUserId ? serverTurn.user : turn);
  return replaced.some((turn) => turn.id === serverTurn.user.id) ? [...replaced, serverTurn.assistant] : [...replaced, serverTurn.user, serverTurn.assistant];
}
