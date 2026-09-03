import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.vue", import.meta.url), "utf8");

describe("global project selector", () => {
  it("does not render a topbar project selector", () => {
    expect(appSource).not.toContain("project-switcher");
    expect(appSource).not.toContain("Switch Project");
    expect(appSource).not.toContain("api.projects()");
  });
});
