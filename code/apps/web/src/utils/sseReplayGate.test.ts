/**
 * 测试职责：验证 sseReplayGate 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { createSseReplayGate } from "./sseReplayGate";

describe("createSseReplayGate", () => {
  it("ignores replayed events until the server declares the stream ready", () => {
    const gate = createSseReplayGate();

    expect(gate.accept("turn.text.delta")).toBe(false);
    expect(gate.accept("turn.completed")).toBe(false);
    expect(gate.accept("stream.ready")).toBe(false);
    expect(gate.ready).toBe(true);
    expect(gate.accept("turn.text.delta")).toBe(true);
  });

  it("can be marked ready when a provider does not emit a replay marker", () => {
    const gate = createSseReplayGate();

    gate.markReady();

    expect(gate.accept("turn.completed")).toBe(true);
  });
});
