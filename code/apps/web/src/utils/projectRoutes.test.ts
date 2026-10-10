import { describe, expect, it } from "vitest";
import { createProjectRequestScope, explorerPathFor, isExplorerWorkspacePath, normalizeProjectId } from "./projectRoutes";

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
  it("认得出「某个项目的探索工作区」这个地址，也只认它", () => {
    expect(isExplorerWorkspacePath("/projects/alpha/explorer")).toBe(true);
    // 退役的三个整页：`/plans` `/runs` `/execute` 现在都是重定向，路由器不会停在那儿，
    // 所以它们**不再是可停留的工作区**（此前 `/plans` `/runs` 会被认成 "execute" 那一档）。
    for (const path of ["/projects/alpha/plans", "/projects/alpha/runs/run-1", "/projects/alpha/execute"]) {
      expect(isExplorerWorkspacePath(path)).toBe(false);
    }
    expect(isExplorerWorkspacePath("/projects/alpha/settings")).toBe(false);
    expect(isExplorerWorkspacePath("/projects/alpha/settings/hooks")).toBe(false);
    expect(isExplorerWorkspacePath("/projects")).toBe(false);
  });

  it("查询串与 hash 不参与判定", () => {
    expect(isExplorerWorkspacePath("/projects/alpha/explorer?runId=run-1#candidate")).toBe(true);
  });

  it("**没有 settings 这个模块** —— 它是 Explorer 里的对话框，不是一个可停留的页面", () => {
    // 退役整页设置时最容易漏的一处：这个模块当初只是给顶部切换器算 router-view 的 key 用的。
    // 留着它，"设置页"就仍然是一个能被寻址的工作区，而那个页面已经不存在了。
    expect(isExplorerWorkspacePath("/projects/alpha/settings")).toBe(false);
    expect(isExplorerWorkspacePath("/projects/alpha/settings/hooks")).toBe(false);
  });

  it("探索工作区地址只此一处拼，且带上项目名", () => {
    expect(explorerPathFor("beta")).toBe("/projects/beta/explorer");
    // 项目 id 可能带需要转义的字符；别让调用方各自 encode。
    expect(explorerPathFor("a/b c")).toBe("/projects/a%2Fb%20c/explorer");
  });
});

describe("project request scope", () => {
  it("rejects late responses from the previous project after a scope switch", () => {
    const scope = createProjectRequestScope();
    const alphaToken = scope.begin("alpha");
    const betaToken = scope.begin("beta");

    expect(scope.isCurrent(alphaToken, "alpha")).toBe(false);
    expect(scope.isCurrent(betaToken, "beta")).toBe(true);

    scope.invalidate();
    expect(scope.isCurrent(betaToken, "beta")).toBe(false);
  });
});
