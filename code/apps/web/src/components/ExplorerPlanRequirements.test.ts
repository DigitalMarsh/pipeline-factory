// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { ElTag } from "element-plus";
import { describe, expect, it } from "vitest";
import ExplorerPlanRequirements from "./ExplorerPlanRequirements.vue";

type Requirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };
type Issue = { path: string; code: string; area: string; message: string };

const requirements: Requirement[] = [
  { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal"], optionalFields: [] },
  { key: "scope", label: "功能范围与排除项", requiredFields: ["scope.includePaths"], optionalFields: [] },
  // 这一条的 `requiredFields` 是**空**——现实里合并那一区就是这样（模型没有可填字段，全由 Factory 固定）。
  {
    key: "execution",
    label: "执行与人工合并",
    requiredFields: [],
    optionalFields: ["execution.toolPolicy"],
    factoryOwnedFields: ["merge.strategy"],
  },
];

const completed = requirements.map((requirement) => requirement.label);

function mountRequirements(initialDiagnostics: Issue[] = [], initiallyExpanded = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const diagnostics = ref(initialDiagnostics);
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(ExplorerPlanRequirements, { requirements, completed, diagnostics: diagnostics.value, initiallyExpanded });
      },
    }),
  );
  // 摘要那三个状态现在是 `el-tag`——不注册的话它会被当成未知元素渲染，且控制台会有 Vue 警告。
  app.component("el-tag", ElTag);
  app.mount(host);
  return { app, host, diagnostics };
}

function toggle(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(".plan-requirements-toggle")!;
}

function details(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>(".plan-requirements-details")!;
}

describe("ExplorerPlanRequirements", () => {
  it("starts collapsed with a compact completion summary", () => {
    const mounted = mountRequirements();
    const button = toggle(mounted.host);

    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("plan-requirements-details");
    expect(button.textContent).toContain("3/3 项已满足");
    expect(button.querySelector(".el-tag")?.textContent).toContain("3/3 项已满足");
    expect(details(mounted.host).getAttribute("style")).toContain("display: none");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("toggles full contract details with click and keyboard semantics", async () => {
    const mounted = mountRequirements();
    const button = toggle(mounted.host);

    button.click();
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(details(mounted.host).getAttribute("style") ?? "").not.toContain("display: none");
    expect(mounted.host.textContent).toContain("必填：title、objective.goal");
    expect(mounted.host.textContent).toContain("可由 Factory 补全：execution.toolPolicy");
    expect(mounted.host.textContent).toContain("REPOSITORY_FILE 必须指定仓库相对路径");
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  /**
   * 「合并策略与人工确认」是**第一个模型没有可填字段的区域**（策略与"必须人工确认"都由 Factory 固定）。
   * 它此前会渲染出一个悬空的「必填：」——一个后面什么都不跟的标签，看着像渲染坏了。
   * 这类区域要改说"由 Factory 固定：…"，把"这里没有你的字段"讲清楚。
   */
  it("没有必填字段的区域不渲染悬空的「必填：」，改说由 Factory 固定", async () => {
    const mounted = mountRequirements();
    toggle(mounted.host).click();
    await nextTick();

    const row = [...details(mounted.host).querySelectorAll<HTMLElement>(".plan-requirement-row")].find((item) =>
      item.textContent?.includes("执行与人工合并"),
    )!;
    expect(row.textContent).not.toContain("必填：");
    expect(row.textContent).toContain("由 Factory 固定：merge.strategy");
    // 同一行上的"可由 Factory 补全"照旧显示——两者是不同的话。
    expect(row.textContent).toContain("可由 Factory 补全：execution.toolPolicy");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("can start expanded when embedded in the header status detail popover", () => {
    const mounted = mountRequirements([], true);

    expect(toggle(mounted.host).getAttribute("aria-expanded")).toBe("true");
    expect(details(mounted.host).getAttribute("style") ?? "").not.toContain("display: none");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens for new diagnostics but preserves a user's manual collapse", async () => {
    const mounted = mountRequirements();
    const button = toggle(mounted.host);

    mounted.diagnostics.value = [
      { path: "scope.includePaths", code: "REQUIRED", area: "功能范围与排除项", message: "必须指定至少一个范围路径" },
    ];
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("问题 1");
    expect(mounted.host.textContent).toContain("必须指定至少一个范围路径");

    button.click();
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    mounted.diagnostics.value = [
      { path: "scope.includePaths", code: "REQUIRED", area: "功能范围与排除项", message: "必须指定至少一个范围路径" },
      { path: "merge.strategy", code: "INVALID", area: "执行与人工合并", message: "策略无效" },
    ];
    await nextTick();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("行首标记由图标组件渲染，不再是 ✓ / ! / · 这些文字字形", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(ExplorerPlanRequirements, {
              requirements,
              completed: [requirements[0]!.label], // 一条已完成
              diagnostics: [
                { path: "scope.includePaths", code: "REQUIRED", area: "功能范围与排除项", message: "必须指定至少一个范围路径" },
              ], // 一条有问题
              initiallyExpanded: true, // 第三条待补齐
            });
        },
      }),
    );
    app.component("el-tag", ElTag);
    app.mount(host);

    const markers = [...host.querySelectorAll<HTMLElement>(".plan-requirement-status")];
    expect(markers).toHaveLength(3);
    // 完成与问题各一个图标，待补齐是一个圆点；三种状态下都没有文字（字形当图标用是这一处曾经的毛病）。
    expect(markers.map((marker) => marker.textContent?.trim())).toEqual(["", "", ""]);
    expect(markers.filter((marker) => marker.querySelector("svg"))).toHaveLength(2);
    expect(markers.filter((marker) => marker.querySelector(".plan-requirement-dot"))).toHaveLength(1);

    app.unmount();
    host.remove();
  });

  it("keeps the details grid responsive on narrow layouts", () => {
    const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    // **换行与缩进不是这条断言的判据**：Prettier 会把一条规则从"一行写完"重排成"一行一声明"，规则本身
    // 一个字都没变。先把连续空白压成单个空格、再去掉括号分号花括号两侧的空格，比的才是声明序列。
    const flat = (text: string) =>
      text
        .replace(/\s+/g, " ")
        // 断行会在**下一个 token 前面**留下一个空格（`foo(\n  bar,` -> `foo( bar,`）。只吃掉这些
        // "断行带进来的"空格：开括号/花括号之后，闭括号/花括号/方括号/分号/逗号/引号之前。
        // **不要**动别处——尤其别去掉 `(` 前面的空格：正则断言不会被折叠，`@media (max-width:` 那样
        // 一改就再也匹配不上。
        .replace(/([({])\s+/g, "$1")
        .replace(/\s+([)}\]);,"'])/g, "$1")
        .replace(/,([)}\]])/g, "$1")
        .trim();
    expect(flat(styles)).toMatch(/@media \(max-width: 720px\).*?\.plan-requirements-grid \{grid-template-columns: 1fr;\}/);
  });
});
