import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.vue", import.meta.url), "utf8");

describe("global project selector", () => {
  it("does not render a topbar project selector", () => {
    expect(appSource).not.toContain("project-switcher");
    expect(appSource).not.toContain("Switch Project");
    expect(appSource).not.toContain("api.projects()");
  });

  it("keeps the Explorer view instance stable across project changes", () => {
    expect(appSource).toContain('module === "explore" ? module');
    expect(appSource).toContain('`${module}:${projectId}`');
  });

  it("does not expose the global Workbench entry", () => {
    expect(appSource).not.toContain('to="/workbench"');
    expect(appSource).not.toContain("topbar-workbench");
  });

  it("binds the topbar status to a live API health check", () => {
    expect(appSource).toContain("api.health()");
    expect(appSource).toContain("setInterval");
    expect(appSource).toContain("clearInterval");
    expect(appSource).toContain("Refresh API health");
    expect(appSource).not.toContain("<i /> Healthy</span>");
    expect(appSource).not.toContain("Factory is healthy");
  });
});
