import { describe, expect, it } from "vitest";
import { planStatusLabel } from "./planStatus";

describe("Plan 状态文案", () => {
  it("覆盖视图会用到的全部 13 个状态", () => {
    expect(planStatusLabel("DRAFT")).toBe("Candidate");
    expect(planStatusLabel("DISCARDED")).toBe("Discarded");
    expect(planStatusLabel("READY")).toBe("Confirmed");
    expect(planStatusLabel("ENQUEUED")).toBe("Enqueued");
    expect(planStatusLabel("DISPATCHED")).toBe("Dispatched");
    expect(planStatusLabel("QUEUED")).toBe("Queued");
    expect(planStatusLabel("STARTING")).toBe("Starting");
    expect(planStatusLabel("IN_PROGRESS")).toBe("Running");
    expect(planStatusLabel("VERIFYING")).toBe("Verifying");
    expect(planStatusLabel("MERGE_READY")).toBe("Ready for review");
    expect(planStatusLabel("MERGED")).toBe("Merged");
    expect(planStatusLabel("NEEDS_PLAN_CHANGE")).toBe("Plan change required");
    expect(planStatusLabel("BLOCKED")).toBe("Blocked");
  });

  it("未知状态回落成原字符串，不回落成空串", () => {
    expect(planStatusLabel("SOME_FUTURE_STATUS")).toBe("SOME_FUTURE_STATUS");
  });
});
