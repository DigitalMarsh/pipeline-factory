import { describe, expect, it } from "vitest";
import { apiHealthVisual, classifyApiHealth } from "./apiHealth";

describe("api health presentation", () => {
  it("treats only an explicit ok response as healthy", () => {
    expect(classifyApiHealth({ status: "ok" })).toBe("healthy");
    expect(classifyApiHealth({ status: "down" })).toBe("unavailable");
    expect(classifyApiHealth(null)).toBe("unavailable");
  });

  it("provides stable copy for each health state", () => {
    expect(apiHealthVisual("checking")).toMatchObject({ label: "Checking API…", tone: "checking" });
    expect(apiHealthVisual("healthy")).toMatchObject({ label: "API Healthy", tone: "healthy" });
    expect(apiHealthVisual("unavailable")).toMatchObject({ label: "API Unavailable", tone: "unavailable" });
  });
});
