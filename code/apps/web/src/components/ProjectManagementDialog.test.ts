// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectManagementDialog from "./ProjectManagementDialog.vue";
import { api } from "../api";
import type { Project, ProjectCatalogItem } from "../types";

vi.mock("../api", () => ({
  api: {
    projects: vi.fn(),
    createProject: vi.fn(),
    archiveProject: vi.fn(),
    activateProject: vi.fn(),
  },
}));

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => props.modelValue ? h("div", { class: "project-management-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean },
  setup(props, { slots, attrs }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

const ElTagStub = defineComponent({ setup(_, { slots }) { return () => h("span", { class: "tag-stub" }, slots.default?.()); } });

function project(id: string, name: string, status: Project["status"] = "ACTIVE"): ProjectCatalogItem {
  return {
    id,
    name,
    repoRoot: `/tmp/${id}`,
    defaultBranch: "main",
    worktreeRoot: `/tmp/${id}-worktrees`,
    status,
    currentExplorerThreadId: id === "project-1" ? "explorer-1" : null,
    configVersion: 1,
    configHash: "hash",
    settings: {
      concurrency: { maxParallelRuns: 1, defaultTimeoutMs: 1000, executionTimeoutMs: 1000, maxAutoContinuationTurns: 0, maxRepairAttempts: 0 },
      commands: [],
      hooks: {},
      models: { explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna" } },
      toolPolicy: { allowedMcpTools: [], allowedPluginTools: [], computerUseEnabled: false },
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    archivedAt: null,
    summary: {
      currentExplorerThread: id === "project-1" ? "explorer-1" : null,
      currentExplorerTitle: id === "project-1" ? "Current exploration" : null,
      threadCount: 0,
      planCount: 0,
      runCount: 0,
      activeRunCount: 0,
      needsAttentionCount: 0,
      lastActivityAt: null,
    },
  };
}

function mountDialog(initialProjects = [project("project-1", "Project 1"), project("project-2", "Project 2")]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const selected: string[] = [];
  const settings: string[] = [];
  const created: Project[] = [];
  const app = createApp(ProjectManagementDialog, {
    modelValue: true,
    projects: initialProjects,
    currentProjectId: "project-1",
    "onUpdate:modelValue": (value: boolean) => updates.push(value),
    onSelectProject: (id: string) => selected.push(id),
    onOpenSettings: (id: string) => settings.push(id),
    onProjectCreated: (value: Project) => created.push(value),
  });
  app.component("ElDialog", ElDialogStub);
  app.component("ElButton", ElButtonStub);
  app.component("ElTag", ElTagStub);
  app.directive("loading", {});
  app.mount(host);
  return { app, host, updates, selected, settings, created };
}

describe("ProjectManagementDialog", () => {
  beforeEach(() => {
    vi.mocked(api.projects).mockResolvedValue({ items: [project("project-1", "Project 1"), project("project-2", "Project 2")] });
    vi.mocked(api.createProject).mockResolvedValue({ project: project("project-3", "Project 3"), explorer: {} as never });
  });

  it("marks the current project and closes without leaving the Explorer", async () => {
    const mounted = mountDialog();
    await nextTick();

    expect(mounted.host.textContent).toContain("Manage Projects");
    expect(mounted.host.querySelector(".current-project-badge")?.textContent).toContain("Current");

    const done = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Done"));
    done?.click();
    await nextTick();
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits a project selection and closes the dialog", async () => {
    const mounted = mountDialog();
    await nextTick();

    const secondCard = mounted.host.querySelectorAll(".project-management-card")[1];
    [...(secondCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.includes("Open Explorer"))?.click();
    await nextTick();

    expect(mounted.selected).toEqual(["project-2"]);
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits settings navigation intent and closes the dialog", async () => {
    const mounted = mountDialog();
    await nextTick();

    const secondCard = mounted.host.querySelectorAll(".project-management-card")[1];
    [...(secondCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.includes("Settings"))?.click();
    await nextTick();

    expect(mounted.settings).toEqual(["project-2"]);
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("creates a project from the dialog form", async () => {
    const mounted = mountDialog();
    await nextTick();

    [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("New Project"))?.click();
    await nextTick();
    const name = mounted.host.querySelector<HTMLInputElement>('input[placeholder="例如：Pipeline Factory"]');
    const repoRoot = mounted.host.querySelector<HTMLInputElement>('input[placeholder="/Users/you/Project/repository"]');
    if (name && repoRoot) {
      name.value = "Project 3";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      repoRoot.value = "/tmp/project-3";
      repoRoot.dispatchEvent(new Event("input", { bubbles: true }));
    }
    [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Validate & Create"))?.click();
    await nextTick();
    await nextTick();

    expect(api.createProject).toHaveBeenCalledWith({ name: "Project 3", repoRoot: "/tmp/project-3" });
    expect(mounted.created).toHaveLength(1);
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });
});
