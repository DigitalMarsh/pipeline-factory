/**
 * 测试职责：验证 runControls 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { canAbandonRun, canContinueRun, canPauseRun, canReclaimWorkspace, canTerminateRun, hasRunControlActions } from "./runControls";

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
    expect(canContinueRun("CANCELLED")).toBe(false);
    expect(canContinueRun("STALE")).toBe(false);
    // Run 还没跑起来时该补的是 Plan，不是执行。
    expect(canContinueRun("QUEUED")).toBe(false);
    expect(canContinueRun("STARTING")).toBe(false);
    expect(canContinueRun("")).toBe(false);
  });
});

describe("run controls", () => {
  /**
   * 「回收工作区」只在**已经停下**的两种状态上给：`MERGE_READY`（跑完了在等合并）与 `BLOCKED`
   * （卡住了）。跑着的状态不给——它的工作区正在用。`CANCELLED` 也不给：`finish` 对它直接早返回，
   * 按下去是个空动作。
   */
  it("只对已停下的状态提供「回收工作区」", () => {
    for (const status of ["MERGE_READY", "BLOCKED"]) expect(canReclaimWorkspace(status)).toBe(true);
    for (const status of ["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING", "CANCELLED", "STALE"])
      expect(canReclaimWorkspace(status)).toBe(false);
  });

  it.each([
    ["IN_PROGRESS", "ACTIVE", true],
    ["IN_PROGRESS", "PAUSED", true],
    ["MERGE_READY", "ACTIVE", false],
    ["BLOCKED", "ACTIVE", false],
    ["CANCELLED", "CANCELLED", false],
  ])("allows pause only for an active execution run (%s/%s)", (runStatus, threadState, expected) => {
    expect(canPauseRun(runStatus, threadState)).toBe(expected);
  });

  // `BLOCKED` 是后补的：服务端一直允许取消它，只有这份客户端名单漏了——于是卡住的 Run
  // 在界面上一个操作都没有，worktree 只能一直留在磁盘上。
  it.each(["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING", "BLOCKED"])(
    "allows termination for %s",
    (runStatus) => {
      expect(canTerminateRun(runStatus)).toBe(true);
    },
  );

  it.each(["MERGE_READY", "CANCELLED", "STALE"])("does not allow termination for %s", (runStatus) => {
    expect(canTerminateRun(runStatus)).toBe(false);
  });

  /**
   * 「放弃这次运行」**只在 `MERGE_READY`**：那是"跑完了在等合并、而我不打算合并了"。它跟「终止」
   * 是同一套服务端机制，但用户要理解的后果不同（终止：这次执行停在这里；放弃：这份成果不要了），
   * 所以是两个入口、两句文案。放进 `canTerminateRun` 会让 `MERGE_READY` 也长出「终止 Run」，
   * 那句话在待合并的运行上是不准的。
   */
  it("只对 MERGE_READY 提供「放弃这次运行」", () => {
    expect(canAbandonRun("MERGE_READY")).toBe(true);
    for (const status of ["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING", "BLOCKED", "CANCELLED", "STALE"])
      expect(canAbandonRun(status)).toBe(false);
  });

  it.each([
    ["IN_PROGRESS", "ACTIVE", true],
    ["IN_PROGRESS", "PAUSED", true],
    ["READY_FOR_VERIFY", "ACTIVE", true],
    // `MERGE_READY` 现在是 true：它有「放弃这次运行」这一个动作（见 canAbandonRun）。
    ["MERGE_READY", "ACTIVE", true],
    ["MERGED", "ACTIVE", false],
    // `BLOCKED` 现在有可执行动作了（终止），见 canTerminateRun。
    ["BLOCKED", "BLOCKED", true],
  ])("reports whether Run Control has an executable action (%s/%s)", (runStatus, threadState, expected) => {
    expect(hasRunControlActions(runStatus, threadState)).toBe(expected);
  });
});
