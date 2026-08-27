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
