/**
 * 测试职责：验证 planFilters 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { planStatusForStat } from "./planFilters";

describe("plan status stat filters", () => {
  it.each([
    ["all", "all"],
    ["queued", "QUEUED"],
    ["running", "IN_PROGRESS"],
    ["verifying", "VERIFYING"],
    ["review", "MERGE_READY"],
    ["merged", "MERGED"],
    ["blocked", "BLOCKED"],
  ])("maps %s to the registry status %s", (statKey, expected) => {
    expect(planStatusForStat(statKey)).toBe(expected);
  });
});
