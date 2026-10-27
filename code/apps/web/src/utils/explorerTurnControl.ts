/**
 * 模块职责：探索对话的「停止」指向哪一条回合——正在占着当前需求的助手回合。
 *
 * 维护提示：
 * 1. 判据与服务端 `cancelTurn` 的接受范围对齐：RUNNING / PAUSED / WAITING_FOR_INPUT 的回合有 job，
 *    QUEUED 的回合在排队表里，两者都能取消；COMPLETED / FAILED / CANCELLED 已经结束，再发只会拿到
 *    "Active Explorer turn not found"。
 * 2. **正在跑的那一轮优先于排队的那一条**：停止按钮的语义是"别探索了"，先把占着需求的回合停掉；
 *    只取消一条排队回合会让人以为停止了、实际正文还在长。只有真的没有在跑的回合时，
 *    才退回到最新入队的那一条。
 */
import type { ExplorerTurn } from "../types";

const ACTIVE_STATUSES: ReadonlyArray<NonNullable<ExplorerTurn["status"]>> = ["RUNNING", "PAUSED", "WAITING_FOR_INPUT"];

export function stoppableExplorerTurn(turns: ExplorerTurn[]): ExplorerTurn | null {
  let queued: ExplorerTurn | null = null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role !== "assistant" || !turn.status) continue;
    if (ACTIVE_STATUSES.includes(turn.status)) return turn;
    if (turn.status === "QUEUED" && !queued) queued = turn;
  }
  return queued;
}
