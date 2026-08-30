/**
 * 测试职责：验证 optimisticTurn 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
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
