import { describe, expect, it } from "vitest";
import { normalizeProjectId } from "./projectRoutes";

describe("normalizeProjectId", () => {
  it("returns null while the Project is not loaded instead of an empty route segment", () => {
    expect(normalizeProjectId(undefined)).toBeNull();
    expect(normalizeProjectId("")).toBeNull();
    expect(normalizeProjectId("   ")).toBeNull();
  });

  it("preserves a valid Project identifier", () => {
    expect(normalizeProjectId("project-demo")).toBe("project-demo");
  });
});
