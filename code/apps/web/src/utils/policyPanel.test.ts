import { describe, expect, it } from "vitest";
import { closePolicyPanel, openPolicyPanel, explorerPolicySections } from "./policyPanel";

describe("Explorer policy panel", () => {
  it("opens and closes from the banner action", () => {
    expect(openPolicyPanel(false)).toBe(true);
    expect(closePolicyPanel(true)).toBe(false);
  });

  it("describes the read-only boundary", () => {
    expect(explorerPolicySections.map((section) => section.title)).toEqual([
      "Explorer access",
      "Disabled tools",
      "Execution boundary",
    ]);
    expect(explorerPolicySections[1]?.items).toContain("Write files");
    expect(explorerPolicySections[1]?.items).toContain("Run shell commands");
  });
});
