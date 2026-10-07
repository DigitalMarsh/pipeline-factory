import { describe, expect, it } from "vitest";
import { normalizeProjectId } from "./projectRoutes";
import * as routeUtils from "./projectRoutes";

const workspaceRoutes = routeUtils as unknown as {
  projectModuleForPath: (path: string) => "explore" | "execute" | null;
  projectPathForModule: (module: "explore" | "execute", projectId: string) => string;
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
  it("preserves Explore and Execute when switching projects", () => {
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/explorer")).toBe("explore");
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/plans")).toBe("execute");
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/runs/run-1")).toBe("execute");
    expect(workspaceRoutes.projectPathForModule("explore", "beta")).toBe("/projects/beta/explorer");
    expect(workspaceRoutes.projectPathForModule("execute", "beta")).toBe("/projects/beta/plans");
  });

  it("**没有 settings 这个模块** —— 它是 Explorer 里的对话框，不是一个可停留的页面", () => {
    // 退役整页设置时最容易漏的一处：这个模块当初只是给顶部切换器算 router-view 的 key 用的。
    // 留着它，"设置页"就仍然是一个能被寻址的工作区，而那个页面已经不存在了。
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/settings")).toBeNull();
    expect(workspaceRoutes.projectModuleForPath("/projects/alpha/settings/hooks")).toBeNull();
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
