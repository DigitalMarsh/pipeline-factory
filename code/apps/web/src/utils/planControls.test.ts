/**
 * 测试职责：验证 planControls 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { canDiscardPlan } from "./planControls";

describe("plan controls", () => {
  it("allows discard only for draft plans", () => {
    expect(canDiscardPlan("DRAFT")).toBe(true);
    expect(canDiscardPlan("DISCARDED")).toBe(false);
    expect(canDiscardPlan("READY")).toBe(false);
    expect(canDiscardPlan(null)).toBe(false);
  });
});
