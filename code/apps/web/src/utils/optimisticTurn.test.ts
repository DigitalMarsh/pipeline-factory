import { describe, expect, it } from "vitest";
import type { ExplorerTurn } from "../types";
import { createOptimisticUserTurn, settleOptimisticTurn } from "./optimisticTurn";

describe("optimistic explorer turns", () => {
  it("creates the user message before the model response settles", () => {
    const turn = createOptimisticUserTurn({
      id: "local-user-1",
      threadId: "thread-1",
      content: "hello",
      createdAt: "2026-08-28T00:00:00.000Z",
      sequence: 3,
    });

    expect(turn).toMatchObject({
      id: "local-user-1",
      threadId: "thread-1",
      role: "user",
      content: "hello",
      sequence: 3,
    });
  });

  it("replaces the local user message and appends the server assistant message", () => {
    const localTurn: ExplorerTurn = {
      id: "local-user-1",
      threadId: "thread-1",
      role: "user",
      content: "hello",
      createdAt: "2026-08-28T00:00:00.000Z",
      sequence: 3,
    };
    const serverTurn = {
      user: { ...localTurn, id: "turn-user-1" },
      assistant: {
        id: "turn-assistant-1",
        threadId: "thread-1",
        role: "assistant" as const,
        content: "hi",
        createdAt: "2026-08-28T00:00:01.000Z",
        sequence: 4,
      },
    };

    expect(settleOptimisticTurn([localTurn], localTurn.id, serverTurn)).toEqual([serverTurn.user, serverTurn.assistant]);
  });
});
