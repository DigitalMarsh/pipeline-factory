/**
 * 测试职责：验证 turnStatus 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { isExplorerTurnProcessing } from "./turnStatus";

describe("explorer turn processing state", () => {
  it("marks only a running assistant turn as processing", () => {
    expect(isExplorerTurnProcessing({ role: "assistant", status: "RUNNING" })).toBe(true);
    expect(isExplorerTurnProcessing({ role: "user", status: "RUNNING" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "COMPLETED" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "WAITING_FOR_INPUT" })).toBe(false);
  });
});
