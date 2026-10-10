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

  /**
   * 整页「Run 详情」退役（与上面两条同一种收法）。它此前**没有任何入口**——全仓没有一处
   * `router.push` / `RouterLink` 拼过这条路径，内容是内嵌形态的同一份代码。留重定向的理由同上，
   * 但这一条的落点要比 `/settings` 复杂：
   *
   * - 只带 `runId` 的话，探索视图会退回「项目当前线程」，左栏落在别人家的需求上；点一下「Run」
   *   页签还会按选中的需求行重新推导 runId，把人带到另一条 Run 去。所以线程与需求两个 id 都要带上；
   * - 那两个 id 要查两个接口才知道，所以**不能写成路由记录的 `redirect`**（必须同步返回），
   *   得写在 `beforeEnter` 里；
   * - 记录本身仍然登记（`component` 是个永不渲染的占位），否则命中时 vue-router 会报
   *   `No match found for location`。
   */
  it("retires the standalone Run detail page into the shared drawer", () => {
    // 断言的是**代码里**没有它了（注释会引用旧名说明改了什么，那不算）。
    expect(routerSource).not.toContain("views/RunDetailView.vue");
    expect(routerSource).not.toContain("component: RunDetailView");
    expect(routerSource).toContain('path: "/projects/:projectId/runs/:runId"');
    expect(routerSource).toContain("beforeEnter");
    expect(routerSource).toContain("runDetailRedirect");
    expect(routerSource).toContain('requirementTab: "task"');
    // 两个 id 一起查出来带上——只带 runId 会落到别人家的需求/另一条 Run 上（浏览器实测）。
    expect(routerSource).toContain("sourceExplorerThreadId");
    expect(routerSource).toContain("explorerPlanId");
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
