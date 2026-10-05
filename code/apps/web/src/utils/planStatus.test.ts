import { describe, expect, it } from "vitest";
import { planStatusLabel } from "./planStatus";

describe("Plan 状态文案", () => {
  it("PlanStatus 的 11 个取值各有中文文案，不回落成原字符串", () => {
    expect(planStatusLabel("DRAFT")).toBe("草稿");
    expect(planStatusLabel("DISCARDED")).toBe("已丢弃");
    expect(planStatusLabel("READY")).toBe("已确认");
    expect(planStatusLabel("ENQUEUED")).toBe("已入队");
    expect(planStatusLabel("DISPATCHED")).toBe("已派发");
    expect(planStatusLabel("IN_PROGRESS")).toBe("执行中");
    expect(planStatusLabel("VERIFYING")).toBe("验证中");
    expect(planStatusLabel("MERGE_READY")).toBe("待合并");
    expect(planStatusLabel("MERGED")).toBe("已合并");
    expect(planStatusLabel("BLOCKED")).toBe("已阻塞");
    expect(planStatusLabel("NEEDS_PLAN_CHANGE")).toBe("需要改计划");
  });

  it("未知状态回落成原字符串，不回落成空串", () => {
    expect(planStatusLabel("SOME_FUTURE_STATUS")).toBe("SOME_FUTURE_STATUS");
  });
});
