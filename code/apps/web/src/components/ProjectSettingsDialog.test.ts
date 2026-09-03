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

function project(): Project {
  return {
    id: "project-1",
    name: "Project 1",
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

    expect(mounted.host.textContent).toContain("Project identity");
    expect(mounted.host.querySelector<HTMLInputElement>('input[disabled]')?.value).toBe("project-1");
    const save = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save Project configuration"));
    save?.click();
    await nextTick();
    await nextTick();

    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({ expectedConfigVersion: 3 }));
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

    const execution = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Execution"));
    execution?.click();
    await nextTick();

    expect(mounted.host.textContent).toContain("Execution policy");
    expect(mounted.host.textContent).not.toContain("Project settings page");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
