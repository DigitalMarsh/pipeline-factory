import { describe, expect, it } from "vitest";
import { statusVisualFor } from "./statusVisual";

describe("statusVisualFor", () => {
  it("keeps Plan and dispatch statuses on one visual vocabulary", () => {
    expect(statusVisualFor("IN_PROGRESS")).toMatchObject({ label: "Running", tone: "info" });
    expect(statusVisualFor("WAITING_GLOBAL_CAPACITY")).toMatchObject({ label: "Waiting · global capacity", tone: "warning" });
    expect(statusVisualFor("MERGED")).toMatchObject({ label: "Merged", tone: "success" });
    expect(statusVisualFor("unexpected")).toMatchObject({ label: "Unexpected", tone: "neutral" });
  });
});
