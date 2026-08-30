/**
 * 测试职责：验证 policyPanel 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { closePolicyPanel, openPolicyPanel, explorerPolicySections } from "./policyPanel";

describe("Explorer policy panel", () => {
  it("opens and closes from the banner action", () => {
    expect(openPolicyPanel(false)).toBe(true);
    expect(closePolicyPanel(true)).toBe(false);
  });

  it("describes the read-only boundary", () => {
    expect(explorerPolicySections.map((section) => section.title)).toEqual([
      "Explorer access",
      "Disabled tools",
      "Execution boundary",
    ]);
    expect(explorerPolicySections[1]?.items).toContain("Write files");
    expect(explorerPolicySections[1]?.items).toContain("Run shell commands");
  });
});
