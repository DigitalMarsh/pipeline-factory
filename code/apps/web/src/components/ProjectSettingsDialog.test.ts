// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import ProjectSettingsDialog from "./ProjectSettingsDialog.vue";
import { api } from "../api";
import type { Project } from "../types";

vi.mock("../api", () => ({
  api: {
    project: vi.fn(),
    updateProject: vi.fn(),
    validateRepository: vi.fn(),
    // 后端目录：两个后端、各自一组模型与推理强度。控制台的 agent/模型/推理强度三个下拉全部由它驱动。
    modelBackends: vi.fn(async () => ({
      backends: [
        { id: "codex-app-server", kind: "codex-app-server", source: "implicit", models: ["gpt-6-sol", "gpt-5.6-luna"], reasoningEfforts: ["low", "high"], endpoint: "codex app-server --stdio", endpointSource: "provider-settings" },
        { id: "deepseek", kind: "claude-agent-sdk", source: "registry", models: ["deepseek-chat"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], endpoint: "api.deepseek.com", endpointSource: "config" },
      ],
      roles: { explorer: "codex-app-server", executor: "codex-app-server" },
      defaultBackend: "codex-app-server",
    })),
  },
}));

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => props.modelValue ? h("div", { class: "project-settings-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { slots, attrs }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

const ElTagStub = defineComponent({ setup(_, { slots }) { return () => h("span", slots.default?.()); } });
const ElSwitchStub = defineComponent({ props: { modelValue: Boolean, disabled: Boolean }, setup() { return () => h("input", { type: "checkbox" }); } });
const ElCheckboxStub = defineComponent({ props: { modelValue: Boolean, label: String, disabled: Boolean }, setup(props) { return () => h("label", [h("input", { type: "checkbox", checked: props.modelValue, disabled: props.disabled }), props.label]); } });

function project(): Project {
  return {
    id: "project-1",
    name: "Project 1",
    shortName: "P1",
    repoRoot: "/tmp/project-1",
    defaultBranch: "main",
    worktreeRoot: "/tmp/project-1-worktrees",
    status: "ACTIVE",
    currentExplorerThreadId: "explorer-1",
    configVersion: 3,
    configHash: "hash-3",
    settings: {
      concurrency: { maxParallelRuns: 2, defaultTimeoutMs: 120000, executionTimeoutMs: 1800000, maxAutoContinuationTurns: 0, maxRepairAttempts: 2 },
      commands: [{ commandId: "project.test", argv: ["pnpm", "test"], environment: { NODE_ENV: "test" } }],
      hooks: {},
      models: { explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna" } },
      toolPolicy: { allowedMcpTools: [], allowedPluginTools: [], computerUseEnabled: false },
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    archivedAt: null,
  };
}

function mountDialog() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const saved: Project[] = [];
  const app = createApp(ProjectSettingsDialog, {
    modelValue: true,
    projectId: "project-1",
    "onUpdate:modelValue": (value: boolean) => updates.push(value),
    onSaved: (value: Project) => saved.push(value),
  });
  app.component("ElDialog", ElDialogStub);
  app.component("ElButton", ElButtonStub);
  app.component("ElTag", ElTagStub);
  app.component("ElSwitch", ElSwitchStub);
  app.component("ElCheckbox", ElCheckboxStub);
  app.directive("loading", {});
  app.mount(host);
  return { app, host, updates, saved };
}

describe("ProjectSettingsDialog", () => {
  it("loads the project configuration and saves it without route navigation", async () => {
    const initial = project();
    const updated = { ...initial, name: "Project 1 updated", configVersion: 4 };
    vi.mocked(api.project).mockResolvedValue({ project: initial, summary: {} as never });
    vi.mocked(api.updateProject).mockResolvedValue({ project: updated });
    const mounted = mountDialog();
    await nextTick();
    await nextTick();

    expect(mounted.host.textContent).toContain("项目标识");
    expect(mounted.host.querySelector<HTMLInputElement>('input[disabled]')?.value).toBe("project-1");
    const shortName = mounted.host.querySelector<HTMLInputElement>('input[placeholder="例如：PF"]');
    if (shortName) {
      shortName.value = "P1X";
      shortName.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const save = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存项目配置"));
    save?.click();
    await nextTick();
    await nextTick();

    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({ expectedConfigVersion: 3, shortName: "P1X" }));
    expect(mounted.saved).toEqual([updated]);
    expect(mounted.updates).toEqual([]);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("keeps settings sections inside the same dialog", async () => {
    vi.mocked(api.project).mockResolvedValue({ project: project(), summary: {} as never });
    const mounted = mountDialog();
    await nextTick();
    await nextTick();

    const execution = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("执行"));
    execution?.click();
    await nextTick();

    expect(mounted.host.textContent).toContain("执行策略");
    expect(mounted.host.textContent).not.toContain("Max parallel runs");
    expect(mounted.host.textContent).not.toContain("Project settings page");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("uses dropdowns for both agents, model roles and reasoning effort", async () => {
    vi.mocked(api.project).mockResolvedValue({ project: project(), summary: {} as never });
    vi.mocked(api.updateProject).mockResolvedValue({ project: project() });
    const mounted = mountDialog();
    await nextTick();
    await nextTick();

    const modelsTab = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("模型与工具"));
    modelsTab?.click();
    await nextTick();
    // 顺序：Explorer agent / model / reasoning，然后 Executor 三项。agent 是本次新增的那一列。
    const selects = mounted.host.querySelectorAll<HTMLSelectElement>(".settings-form-grid select");
    expect(selects).toHaveLength(6);
    // 未固定后端时默认项写的是"跟随全局（<生效后端>）"，而不是一个空字符串标签。
    expect(selects[0]!.options[0]!.textContent).toContain("跟随全局");
    expect([...selects[0]!.options].some((option) => option.value === "deepseek")).toBe(true);
    // 模型与推理强度跟着所选 agent 走：codex 的推理强度里没有 xhigh，deepseek（Claude 侧）的有。
    expect([...selects[1]!.options].some((option) => option.value === "gpt-6-sol")).toBe(true);
    expect([...selects[2]!.options].some((option) => option.value === "high")).toBe(true);
    expect([...selects[2]!.options].some((option) => option.value === "xhigh")).toBe(false);

    selects[1]!.value = "gpt-6-sol";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    selects[2]!.value = "high";
    selects[2]!.dispatchEvent(new Event("change", { bubbles: true }));
    // 换个 agent（index 3 = executor agent）：模型候选随之换成该后端的清单（index 4 = executor model）。
    selects[3]!.value = "deepseek";
    selects[3]!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    const executorModelOptions = [...mounted.host.querySelectorAll<HTMLSelectElement>(".settings-form-grid select")[4]!.options].map((option) => option.value);
    expect(executorModelOptions).toContain("deepseek-chat");
    const save = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存项目配置"));
    save?.click();
    await nextTick();
    await nextTick();

    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
      settings: expect.objectContaining({
        models: expect.objectContaining({
          explorer: expect.objectContaining({ model: "gpt-6-sol", reasoningEffort: "high", backend: null }),
          executor: expect.objectContaining({ backend: "deepseek" }),
        }),
      }),
    }));
    mounted.app.unmount();
    mounted.host.remove();
  });
});
