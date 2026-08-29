import type { ExplorerTurn } from "../types";

export function isExplorerTurnProcessing(turn: Pick<ExplorerTurn, "role" | "status">): boolean {
  return turn.role === "assistant" && turn.status === "RUNNING";
}
