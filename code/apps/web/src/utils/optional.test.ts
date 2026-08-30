/**
 * 测试职责：验证 optional 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { optional } from "./optional";

describe("optional async loading", () => {
  it("returns the resolved value", async () => {
    await expect(optional(async () => "value")).resolves.toBe("value");
  });

  it("turns a missing optional resource into null", async () => {
    await expect(optional(async () => { throw new Error("not found"); })).resolves.toBeNull();
  });
});
