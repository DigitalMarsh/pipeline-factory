import { describe, expect, it } from "vitest";
import { normalizeProjectId } from "./projectRoutes";
import * as routeUtils from "./projectRoutes";

const workspaceRoutes = routeUtils as unknown as {
  projectModuleForPath: (path: string) => "explore" | "execute" | "settings" | null;
  projectPathForModule: (module: "explore" | "execute" | "settings", projectId: string) => string;
  createProjectRequestScope: () => {
    begin: (projectId: string) => number;
    invalidate: () => void;
    isCurrent: (token: number, projectId: string) => boolean;
  };
};

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

describe("project workspace routing", () => {
  it("preserves Explore, Execute and Settings when switching projects", () => {
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/explorer")).toBe("explore");
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/plans")).toBe("execute");
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/runs/run-1")).toBe("execute");
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/settings/hooks")).toBe("settings");
    expect(workspaceRoutes.projectPathForModule("explore", "beta")).toBe("/projects/beta/explorer");
    expect(workspaceRoutes.projectPathForModule("execute", "beta")).toBe("/projects/beta/plans");
    expect(workspaceRoutes.projectPathForModule("settings", "beta")).toBe("/projects/beta/settings");
  });
});

describe("project request scope", () => {
  it("rejects late responses from the previous project after a scope switch", () => {
    const scope = workspaceRoutes.createProjectRequestScope();
    const alphaToken = scope.begin("alpha");
    const betaToken = scope.begin("beta");

    expect(scope.isCurrent(alphaToken, "alpha")).toBe(false);
    expect(scope.isCurrent(betaToken, "beta")).toBe(true);

    scope.invalidate();
    expect(scope.isCurrent(betaToken, "beta")).toBe(false);
  });
});
