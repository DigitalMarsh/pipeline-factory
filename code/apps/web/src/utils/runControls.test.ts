import { describe, expect, it } from "vitest";
import { canPauseRun, canTerminateRun } from "./runControls";

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

  it.each(["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"])("allows termination for %s", (runStatus) => {
    expect(canTerminateRun(runStatus)).toBe(true);
  });

  it.each(["MERGE_READY", "BLOCKED", "CANCELLED"])("does not allow termination for %s", (runStatus) => {
    expect(canTerminateRun(runStatus)).toBe(false);
  });
});
