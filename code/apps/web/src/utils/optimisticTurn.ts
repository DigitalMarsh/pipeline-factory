import type { ExplorerTurn } from "../types";

export type OptimisticUserTurnInput = Pick<ExplorerTurn, "id" | "threadId" | "content" | "createdAt" | "sequence">;
export type ExplorerTurnPair = { user: ExplorerTurn; assistant: ExplorerTurn };

export function createOptimisticUserTurn(input: OptimisticUserTurnInput): ExplorerTurn {
  return { ...input, role: "user" };
}

export function settleOptimisticTurn(turns: ExplorerTurn[], optimisticUserId: string, serverTurn: ExplorerTurnPair): ExplorerTurn[] {
  const replaced = turns.map((turn) => turn.id === optimisticUserId ? serverTurn.user : turn);
  return replaced.some((turn) => turn.id === serverTurn.user.id) ? [...replaced, serverTurn.assistant] : [...replaced, serverTurn.user, serverTurn.assistant];
}
