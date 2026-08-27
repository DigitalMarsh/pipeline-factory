import { describe, expect, it } from "vitest";
import { canPauseRun } from "./runControls";

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
});
