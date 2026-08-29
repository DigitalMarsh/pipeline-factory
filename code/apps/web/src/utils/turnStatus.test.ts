import { describe, expect, it } from "vitest";
import { isExplorerTurnProcessing } from "./turnStatus";

describe("explorer turn processing state", () => {
  it("marks only a running assistant turn as processing", () => {
    expect(isExplorerTurnProcessing({ role: "assistant", status: "RUNNING" })).toBe(true);
    expect(isExplorerTurnProcessing({ role: "user", status: "RUNNING" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "COMPLETED" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "WAITING_FOR_INPUT" })).toBe(false);
  });
});
