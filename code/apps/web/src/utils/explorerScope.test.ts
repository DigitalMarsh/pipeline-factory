import { describe, expect, it } from "vitest";
import { belongsToExplorerPlan } from "./explorerScope";

describe("Explorer Task scope", () => {
  it("keeps only records belonging to the active Task", () => {
    expect(belongsToExplorerPlan("task-1", "task-1")).toBe(true);
    expect(belongsToExplorerPlan("task-2", "task-1")).toBe(false);
  });

  it("does not guess that an unowned record belongs to Task 1", () => {
    expect(belongsToExplorerPlan(undefined, "task-1")).toBe(false);
    expect(belongsToExplorerPlan(null, "task-1")).toBe(false);
  });

  it("keeps the unscoped thread view available before a Task is active", () => {
    expect(belongsToExplorerPlan(undefined, null)).toBe(true);
  });
});
