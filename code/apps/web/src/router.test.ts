import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectDefaultProjectId } from "./routerDefaults";

const routerSource = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
const routerDefaultsSource = readFileSync(new URL("./routerDefaults.ts", import.meta.url), "utf8");

describe("project workspace routes", () => {
  it("removes the global Workbench route but keeps project Execute", () => {
    expect(routerSource).not.toContain('path: "/workbench"');
    expect(routerSource).toContain('path: "/projects/:projectId/execute"');
  });

  it("redirects the legacy Plan Center address into the Explorer context panel", () => {
    expect(routerSource).toContain('path: "/projects/:projectId/plans"');
    expect(routerSource).toContain('contextPanel: "plan-center"');
    expect(routerSource).not.toContain("PlanCenterView");
  });

  it("resolves the root entry from the remembered project before active-project fallback", () => {
    expect(routerDefaultsSource).toContain("pipeline-factory:last-project-id");
    expect(routerDefaultsSource).toContain("localStorage.getItem(LAST_PROJECT_STORAGE_KEY)");
    expect(routerDefaultsSource).toContain("status === \"ACTIVE\"");
    expect(routerSource).toContain('return "/projects"');
    expect(routerSource).toContain("/explorer");
  });

  it("remembers a project whenever a project-scoped route is entered", () => {
    expect(routerDefaultsSource).toContain("localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId)");
  });

  it("prefers the remembered project and falls back to active then any project", () => {
    const projects = [
      { id: "archived", status: "ARCHIVED" as const },
      { id: "active", status: "ACTIVE" as const },
    ];

    expect(selectDefaultProjectId(projects, "archived")).toBe("archived");
    expect(selectDefaultProjectId(projects, "missing")).toBe("active");
    expect(selectDefaultProjectId([{ id: "only", status: "ARCHIVED" as const }], null)).toBe("only");
    expect(selectDefaultProjectId([], null)).toBeNull();
  });
});
