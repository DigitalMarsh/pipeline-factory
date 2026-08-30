/**
 * 测试职责：验证 composerKeyboard 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composerKeyboard";

describe("shouldSubmitComposer", () => {
  it("only submits Enter when Cmd or Ctrl is pressed", () => {
    expect(shouldSubmitComposer({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldSubmitComposer({ key: "Escape", metaKey: true, ctrlKey: true })).toBe(false);
  });
});
