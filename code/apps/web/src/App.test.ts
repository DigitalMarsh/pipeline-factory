import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("./App.vue", import.meta.url), "utf8");

/** 换行与缩进不是这些断言的判据：Prettier 会把源码重排，而断言要证的是"这里接上了某个东西"。 */
const flat = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([({])\s+/g, "$1")
    .replace(/\s+([)}\])]+)/g, "$1")
    .trim();
const flatAppSource = flat(appSource);

describe("global project selector", () => {
  it("does not render a topbar project selector", () => {
    expect(appSource).not.toContain("project-switcher");
    expect(appSource).not.toContain("Switch Project");
    expect(appSource).not.toContain("api.projects()");
  });

  it("keeps the Explorer view instance stable across project changes", () => {
    // 探索工作区那把 key **不带 projectId**：在那个工作区里切项目时不重挂视图，就地换数据。
    expect(flatAppSource).toContain(flat('isExplorerWorkspacePath(viewRoute.path) ? "explore" : viewRoute.path'));
    // 此前还有一档 `execute`（`${module}:${projectId}`，切项目要整页重挂）——「执行台」整页退役后
    // 只剩一档，那个分支随它一起没了；这里钉住"它没回来"。
    expect(appSource).not.toContain("`${module}:${projectId}`");
  });

  it("does not expose the global Workbench entry", () => {
    expect(appSource).not.toContain('to="/workbench"');
    expect(appSource).not.toContain("topbar-workbench");
  });

  it("binds the topbar status to a live API health check", () => {
    expect(appSource).toContain("api.health()");
    expect(appSource).toContain("setInterval");
    expect(appSource).toContain("clearInterval");
    expect(appSource).toContain("刷新 API 健康状态");
    expect(appSource).not.toContain("<i /> Healthy</span>");
    expect(appSource).not.toContain("Factory is healthy");
  });
});
