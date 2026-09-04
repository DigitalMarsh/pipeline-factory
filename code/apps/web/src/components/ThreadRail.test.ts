// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import ThreadRail from "./ThreadRail.vue";
import type { ExplorerThread, Project } from "../types";

function mountRail(panel: "projects" | "explorers" = "explorers") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let openHistoryCount = 0;
  let selectedPanel: "projects" | "explorers" | null = null;
  let selectedProjectId: string | null = null;
  let selectedExplorerId: string | null = null;
  let manageProjectsCount = 0;
  const thread = { id: "explorer-1", projectId: "project-1", title: "Current exploration", state: "ACTIVE", contextMode: "FRESH", messageCount: 2, lastActivityAt: "2026-09-02T14:00:00.000Z" } as unknown as ExplorerThread;
  const project = { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE", currentExplorerThreadId: "explorer-1" } as unknown as Project;
  const projects = [
    { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE" },
    { id: "project-2", name: "Project 2", repoRoot: "/tmp/project-2", status: "ARCHIVED" },
  ] as unknown as Project[];
  const explorers = [
    { id: "explorer-1", projectId: "project-1", title: "Current exploration", state: "ACTIVE", contextMode: "FRESH", messageCount: 2, lastActivityAt: "2026-09-02T14:00:00.000Z" },
    { id: "explorer-2", projectId: "project-1", title: "Second exploration", state: "COMPLETED", contextMode: "FRESH", messageCount: 4, lastActivityAt: "2026-09-01T14:00:00.000Z" },
  ] as unknown as ExplorerThread[];
  const app = createApp(defineComponent({
    setup() {
      const activePanel = ref(panel);
      return () => h(ThreadRail, {
        panel: activePanel.value,
        thread,
        project,
        projects,
        explorers,
        onOpenHistory: () => { openHistoryCount += 1; },
        onSelectPanel: (value: "projects" | "explorers") => { selectedPanel = value; activePanel.value = value; },
        onSelectProject: (projectId: string) => { selectedProjectId = projectId; },
        onSelectExplorer: (explorerId: string) => { selectedExplorerId = explorerId; },
        onManageProjects: () => { manageProjectsCount += 1; },
      });
    },
  }));
  app.mount(host);
  return {
    app,
    host,
    getOpenHistoryCount: () => openHistoryCount,
    getSelectedPanel: () => selectedPanel,
    getSelectedProjectId: () => selectedProjectId,
    getSelectedExplorerId: () => selectedExplorerId,
    getManageProjectsCount: () => manageProjectsCount,
  };
}

describe("ThreadRail left workspace navigation", () => {
  it("renders exactly the Projects and Explorers entry buttons", () => {
    const mounted = mountRail();
    const entries = [...mounted.host.querySelectorAll<HTMLButtonElement>("button[data-left-panel]")];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(["项目", "探索"]);
    expect(entries[0]?.getAttribute("aria-selected")).toBe("false");
    expect(entries[1]?.getAttribute("aria-selected")).toBe("true");
    expect(mounted.host.querySelector(".explorer-list")).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("switches only the left content area to the project list", async () => {
    const mounted = mountRail();
    mounted.host.querySelector<HTMLButtonElement>('button[data-left-panel="projects"]')?.click();
    await nextTick();

    expect(mounted.getSelectedPanel()).toBe("projects");
    expect(mounted.host.querySelector(".project-list")).not.toBeNull();
    expect(mounted.host.querySelector(".explorer-list")).toBeNull();
    expect(mounted.host.textContent).toContain("Project 1");
    expect(mounted.host.textContent).toContain("Manage Projects");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits the selected project id from the project list", async () => {
    const mounted = mountRail("projects");
    mounted.host.querySelector<HTMLButtonElement>('button[data-project-id="project-2"]')?.click();
    await nextTick();

    expect(mounted.getSelectedProjectId()).toBe("project-2");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("switches back to the Explorer list and emits an Explorer selection", async () => {
    const mounted = mountRail("projects");
    mounted.host.querySelector<HTMLButtonElement>('button[data-left-panel="explorers"]')?.click();
    await nextTick();

    expect(mounted.host.querySelector(".explorer-list")).not.toBeNull();
    mounted.host.querySelector<HTMLButtonElement>('button[data-explorer-id="explorer-2"]')?.click();
    await nextTick();

    expect(mounted.getSelectedExplorerId()).toBe("explorer-2");

    mounted.app.unmount();
    mounted.host.remove();
  });

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

  it("opens project management from the project list", async () => {
    const mounted = mountRail("projects");
    mounted.host.querySelector<HTMLButtonElement>("button.left-panel-manage")?.click();
    await nextTick();

    expect(mounted.getManageProjectsCount()).toBe(1);
    expect(mounted.getSelectedProjectId()).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("keeps context navigation out of the left rail", () => {
    const mounted = mountRail();

    expect(mounted.host.querySelector(".rail-nav")).toBeNull();
    expect(mounted.host.querySelectorAll("button[data-context]")).toHaveLength(0);
    expect(mounted.host.textContent).not.toContain("Plan candidates");
    expect(mounted.host.textContent).not.toContain("Dispatched plans");
    expect(mounted.host.textContent).not.toContain("Active runs");
    expect(mounted.host.textContent).not.toContain("Needs attention");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
