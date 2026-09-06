// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import ExplorerPlanRequirements from "./ExplorerPlanRequirements.vue";

type Requirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[] };
type Issue = { path: string; code: string; area: string; message: string };

const requirements: Requirement[] = [
  { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal"], optionalFields: [] },
  { key: "scope", label: "功能范围与排除项", requiredFields: ["scope.includePaths"], optionalFields: [] },
  { key: "execution", label: "执行与人工合并", requiredFields: ["merge.strategy"], optionalFields: ["execution.toolPolicy"] },
];

const completed = requirements.map((requirement) => requirement.label);

function mountRequirements(initialDiagnostics: Issue[] = []) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const diagnostics = ref(initialDiagnostics);
  const app = createApp(defineComponent({
    setup() {
      return () => h(ExplorerPlanRequirements, { requirements, completed, diagnostics: diagnostics.value });
    },
  }));
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

  it("opens for new diagnostics but preserves a user's manual collapse", async () => {
    const mounted = mountRequirements();
    const button = toggle(mounted.host);

    mounted.diagnostics.value = [{ path: "scope.includePaths", code: "REQUIRED", area: "功能范围与排除项", message: "必须指定至少一个范围路径" }];
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

  it("keeps the details grid responsive on narrow layouts", () => {
    const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.plan-requirements-grid \{ grid-template-columns: 1fr; \}/);
  });
});
