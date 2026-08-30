/**
 * 测试职责：验证 runControls 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { canPauseRun, canTerminateRun } from "./runControls";

describe("run controls", () => {
  it.each([
    ["IN_PROGRESS", "ACTIVE", true],
    ["IN_PROGRESS", "PAUSED", true],
    ["MERGE_READY", "ACTIVE", false],
    ["BLOCKED", "ACTIVE", false],
    ["CANCELLED", "CANCELLED", false],
  ])("allows pause only for an active execution run (%s/%s)", (runStatus, threadState, expected) => {
    expect(canPauseRun(runStatus, threadState)).toBe(expected);
  });

  it.each(["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"])("allows termination for %s", (runStatus) => {
    expect(canTerminateRun(runStatus)).toBe(true);
  });

  it.each(["MERGE_READY", "BLOCKED", "CANCELLED"])("does not allow termination for %s", (runStatus) => {
    expect(canTerminateRun(runStatus)).toBe(false);
  });
});
