import { describe, expect, it } from "vitest";
import { canDiscardPlan } from "./planControls";

describe("plan controls", () => {
  it("allows discard only for draft plans", () => {
    expect(canDiscardPlan("DRAFT")).toBe(true);
    expect(canDiscardPlan("DISCARDED")).toBe(false);
    expect(canDiscardPlan("READY")).toBe(false);
    expect(canDiscardPlan(null)).toBe(false);
  });
});
