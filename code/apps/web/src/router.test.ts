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

  /**
   * 整页「项目设置」退役（与 PlanCenterView 同一种收法）。两条老路径留成重定向而不是删掉：
   * 它们在书签、聊天记录、终端历史里到处都是，删掉之后旧链接会静默落到目录页，看起来像"这个
   * 项目坏了"。`settings=1` 是关键的一半——ExplorerView 靠它把对话框打开，否则重定向过去
   * 什么都不发生，用户以为设置页还在。
   */
  it("retires the standalone Project Settings page into the Explorer dialog", () => {
    expect(routerSource).not.toContain("ProjectSettingsView");
    expect(routerSource).toContain('path: "/projects/:projectId/settings"');
    expect(routerSource).toContain('path: "/projects/:projectId/settings/hooks"');
    expect(routerSource).toContain("settingsRedirect");
    expect(routerSource).toContain('settings: "1"');
    // `/settings/hooks` 是旧钩子页的地址，重定向过去要落在钩子那个页签上。
    expect(routerSource).toContain('settingsRedirect(to, "hooks")');
  });

  it("resolves the root entry from the remembered project before active-project fallback", () => {
    expect(routerDefaultsSource).toContain("pipeline-factory:last-project-id");
    expect(routerDefaultsSource).toContain("localStorage.getItem(LAST_PROJECT_STORAGE_KEY)");
    expect(routerDefaultsSource).toContain('status === "ACTIVE"');
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
