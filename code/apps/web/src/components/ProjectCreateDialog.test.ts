// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectCreateDialog from "./ProjectCreateDialog.vue";
import { api } from "../api";
import type { ExplorerThread, Project } from "../types";

vi.mock("../api", () => ({
  api: { createProject: vi.fn() },
}));

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => props.modelValue ? h("div", { class: "project-create-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean },
  setup(props, { slots, attrs }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

const createdProject = { id: "project-3", name: "Project 3", repoRoot: "/tmp/project-3", status: "ACTIVE" } as unknown as Project;

function mountDialog() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const created: Array<{ project: Project; explorer: ExplorerThread }> = [];
  const app = createApp(ProjectCreateDialog, {
    modelValue: true,
    "onUpdate:modelValue": (value: boolean) => updates.push(value),
    onProjectCreated: (project: Project, explorer: ExplorerThread) => created.push({ project, explorer }),
  });
  app.component("ElDialog", ElDialogStub);
  app.component("ElButton", ElButtonStub);
  app.mount(host);
  return { app, host, updates, created };
}

describe("ProjectCreateDialog", () => {
  beforeEach(() => {
    vi.mocked(api.createProject).mockResolvedValue({ project: createdProject, explorer: { id: "explorer-3" } as ExplorerThread });
  });

  it("shows the existing Project creation fields inside a modal", () => {
    const mounted = mountDialog();

    expect(mounted.host.textContent).toContain("New Project");
    expect(mounted.host.querySelector('input[placeholder="例如：Pipeline Factory"]')).not.toBeNull();
    expect(mounted.host.querySelector('input[placeholder="例如：PF"]')).not.toBeNull();
    expect(mounted.host.querySelector('input[placeholder="/Users/you/Project/repository"]')).not.toBeNull();
    expect(mounted.host.textContent).toContain("Validate & Create");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("validates required fields without leaving the current page", async () => {
    const mounted = mountDialog();
    mounted.host.querySelector<HTMLButtonElement>('button[data-create-action="submit"]')?.click();
    await nextTick();

    expect(mounted.host.querySelector(".project-create-alert")?.textContent).toContain("项目名称");
    expect(api.createProject).not.toHaveBeenCalled();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("creates the project and emits the created Explorer without navigating", async () => {
    const mounted = mountDialog();
    const name = mounted.host.querySelector<HTMLInputElement>('input[placeholder="例如：Pipeline Factory"]');
    const shortName = mounted.host.querySelector<HTMLInputElement>('input[placeholder="例如：PF"]');
    const repoRoot = mounted.host.querySelector<HTMLInputElement>('input[placeholder="/Users/you/Project/repository"]');
    if (name && shortName && repoRoot) {
      name.value = "Project 3";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      shortName.value = "P3";
      shortName.dispatchEvent(new Event("input", { bubbles: true }));
      repoRoot.value = "/tmp/project-3";
      repoRoot.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await nextTick();
    mounted.host.querySelector<HTMLButtonElement>('button[data-create-action="submit"]')?.click();
    await nextTick();
    await nextTick();

    expect(api.createProject).toHaveBeenCalledWith({ name: "Project 3", shortName: "P3", repoRoot: "/tmp/project-3" });
    expect(mounted.created).toEqual([{ project: createdProject, explorer: { id: "explorer-3" } }]);
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });
});
