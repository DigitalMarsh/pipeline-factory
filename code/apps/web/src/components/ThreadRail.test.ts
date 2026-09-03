// @vitest-environment jsdom
import { createApp, defineComponent, h, inject, nextTick, provide, ref } from "vue";
import { describe, expect, it } from "vitest";
import ThreadRail from "./ThreadRail.vue";

const dropdownCommand = Symbol("dropdown-command");

const ElDropdownStub = defineComponent({
  setup(_, { slots, emit }) {
    const open = ref(false);
    provide(dropdownCommand, (command: string) => emit("command", command));
    return () => h("div", { class: "el-dropdown-stub" }, [
      h("div", { class: "el-dropdown-trigger", onClick: () => { open.value = true; } }, slots.default?.()),
      open.value ? h("div", { class: "el-dropdown-content" }, slots.dropdown?.()) : null,
    ]);
  },
});

const ElDropdownMenuStub = defineComponent({
  setup(_, { slots }) {
    return () => h("div", { class: "el-dropdown-menu-stub" }, slots.default?.());
  },
});

const ElDropdownItemStub = defineComponent({
  props: { command: { type: String, required: true } },
  setup(props, { slots }) {
    const select = inject<(command: string) => void>(dropdownCommand);
    return () => h("button", { class: "el-dropdown-item-stub", type: "button", onClick: () => select?.(props.command) }, slots.default?.());
  },
});

const RouterLinkStub = defineComponent({
  props: { to: { type: [String, Object], default: "#" } },
  setup(props, { slots }) {
    return () => h("a", { href: typeof props.to === "string" ? props.to : "#" }, slots.default?.());
  },
});

function mountRail(contextSelection = "candidate") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let openHistoryCount = 0;
  let selectedProjectId: string | null = null;
  let selectedContext: string | null = null;
  const app = createApp(ThreadRail, {
    thread: { id: "explorer-1", projectId: "project-1", title: "Current exploration", state: "ACTIVE", contextMode: "FRESH", messageCount: 2, lastActivityAt: "2026-09-02T14:00:00.000Z" },
    project: { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE", currentExplorerThreadId: "explorer-1" },
    projects: [
      { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE" },
      { id: "project-2", name: "Project 2", repoRoot: "/tmp/project-2", status: "ARCHIVED" },
    ],
    onOpenHistory: () => { openHistoryCount += 1; },
    onSelectProject: (projectId: string) => { selectedProjectId = projectId; },
    contextSelection,
    onSelectContext: (selection: string) => { selectedContext = selection; },
  });
  app.component("RouterLink", RouterLinkStub);
  app.component("ElDropdown", ElDropdownStub);
  app.component("ElDropdownMenu", ElDropdownMenuStub);
  app.component("ElDropdownItem", ElDropdownItemStub);
  app.mount(host);
  return { app, host, getOpenHistoryCount: () => openHistoryCount, getSelectedProjectId: () => selectedProjectId, getSelectedContext: () => selectedContext };
}

describe("ThreadRail current Explorer entry", () => {
  it("opens Explorer history from the current thread card", async () => {
    const mounted = mountRail();
    const currentThread = mounted.host.querySelector<HTMLButtonElement>("button.thread-identity");

    expect(currentThread).not.toBeNull();
    currentThread?.click();
    await nextTick();
    expect(mounted.getOpenHistoryCount()).toBe(1);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("does not render a separate Explorer history control", () => {
    const mounted = mountRail();

    expect(mounted.host.querySelector(".thread-history-button")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens the project menu from the current project card", async () => {
    const mounted = mountRail();
    const projectButton = mounted.host.querySelector<HTMLButtonElement>("button.rail-project");

    expect(projectButton).not.toBeNull();
    expect(projectButton?.textContent).toContain("Project 1");
    expect(mounted.host.querySelector(".el-dropdown-content")).toBeNull();

    projectButton?.click();
    await nextTick();

    expect(mounted.host.querySelector(".el-dropdown-content")).not.toBeNull();
    expect(mounted.host.textContent).toContain("Manage Projects");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits the selected project id from the project menu", async () => {
    const mounted = mountRail();
    mounted.host.querySelector<HTMLButtonElement>("button.rail-project")?.click();
    await nextTick();

    const projectItem = [...mounted.host.querySelectorAll<HTMLButtonElement>(".el-dropdown-item-stub")]
      .find((item) => item.textContent?.includes("Project 2"));
    projectItem?.click();
    await nextTick();

    expect(mounted.getSelectedProjectId()).toBe("project-2");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("switches the right-panel context when a context entry is selected", async () => {
    const mounted = mountRail();
    const dispatchedEntry = mounted.host.querySelector<HTMLButtonElement>('button[data-context="dispatched"]');

    expect(dispatchedEntry).not.toBeNull();
    dispatchedEntry?.click();
    await nextTick();

    expect(mounted.getSelectedContext()).toBe("dispatched");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
