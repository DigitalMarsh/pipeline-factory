/**
 * 测试职责：验证 runControls 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { canContinueRun, canPauseRun, canTerminateRun, hasRunControlActions } from "./runControls";

describe("补充要求的可用性（canContinueRun）", () => {
  /**
   * 这一条是**报障的回归**：执行一收尾线程就被置成 `COMPLETED`，所以按线程状态判可用性会让输入框
   * 恰好在"执行完了、还没合并、想再让它补一轮"时禁用。判据因此改成 Run 的状态。
   */
  it("**执行完了但没合并时可用** —— 那正是最需要补充一次的时刻", () => {
    expect(canContinueRun("MERGE_READY")).toBe(true);
    // 进程重启后 Loop 被判死，它是同一类死胡同（只能取消、不能继续）。
    expect(canContinueRun("RECOVERING")).toBe(true);
    expect(canContinueRun("IN_PROGRESS")).toBe(true);
    expect(canContinueRun("READY_FOR_VERIFY")).toBe(true);
    expect(canContinueRun("VERIFYING")).toBe(true);
  });

  it("**卡在计划上的 Run 不给补** —— 那两种该走「创建更新版本」，补一句话会把真问题盖住", () => {
    expect(canContinueRun("BLOCKED")).toBe(false);
    expect(canContinueRun("NEEDS_PLAN_CHANGE")).toBe(false);
    expect(canContinueRun("CANCELLED")).toBe(false);
    expect(canContinueRun("STALE")).toBe(false);
    // Run 还没跑起来时该补的是 Plan，不是执行。
    expect(canContinueRun("QUEUED")).toBe(false);
    expect(canContinueRun("STARTING")).toBe(false);
    expect(canContinueRun("")).toBe(false);
  });
});

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

  it.each([
    ["IN_PROGRESS", "ACTIVE", true],
    ["IN_PROGRESS", "PAUSED", true],
    ["READY_FOR_VERIFY", "ACTIVE", true],
    ["MERGE_READY", "ACTIVE", false],
    ["MERGED", "ACTIVE", false],
    ["BLOCKED", "BLOCKED", false],
  ])("reports whether Run Control has an executable action (%s/%s)", (runStatus, threadState, expected) => {
    expect(hasRunControlActions(runStatus, threadState)).toBe(expected);
  });
});
