// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import ThreadRail from "./ThreadRail.vue";
import type { ExplorerThread, Project } from "../types";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function mountRail(panel: "projects" | "explorers" = "explorers", creatingExplorer = false, projectActionId: string | null = null, includeArchived = false, showArchived = false, explorerLoading = false, explorerError: string | null = null, explorerItems?: ExplorerThread[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let createExplorerCount = 0;
  let createProjectCount = 0;
  let selectedPanel: "projects" | "explorers" | null = null;
  let selectedProjectId: string | null = null;
  let selectedExplorerId: string | null = null;
  let archivedExplorerId: string | null = null;
  const openedProjectIds: string[] = [];
  const settingsProjectIds: string[] = [];
  const archivedProjectIds: string[] = [];
  const thread = { id: "explorer-1", projectId: "project-1", title: "Current exploration", state: "ACTIVE", contextMode: "FRESH", messageCount: 2, lastActivityAt: "2026-09-02T14:00:00.000Z" } as unknown as ExplorerThread;
  const project = { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE", currentExplorerThreadId: "explorer-1" } as unknown as Project;
  const projects = [
    { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE" },
    { id: "project-2", name: "Project 2", repoRoot: "/tmp/project-2", status: "ARCHIVED" },
  ] as unknown as Project[];
  const explorers = explorerItems ?? [
    { id: "explorer-1", projectId: "project-1", title: "Current exploration", state: "ACTIVE", contextMode: "FRESH", messageCount: 2, lastActivityAt: "2026-09-02T14:00:00.000Z" },
    { id: "explorer-2", projectId: "project-1", title: "Second exploration", state: "COMPLETED", contextMode: "FRESH", messageCount: 4, lastActivityAt: "2026-09-01T14:00:00.000Z" },
    ...(includeArchived ? [{ id: "explorer-3", projectId: "project-1", title: "Archived exploration", state: "ARCHIVED", contextMode: "FRESH", messageCount: 1, lastActivityAt: "2026-08-31T14:00:00.000Z" }] : []),
  ] as unknown as ExplorerThread[];
  const app = createApp(defineComponent({
    setup() {
      const activePanel = ref(panel);
      const archivedVisible = ref(showArchived);
      return () => h(ThreadRail, {
        panel: activePanel.value,
        thread,
        project,
        projects,
        explorers,
        showArchived: archivedVisible.value,
        explorerLoading,
        explorerError,
        creatingExplorer,
        projectActionId,
        onCreateExplorer: () => { createExplorerCount += 1; },
        onCreateProject: () => { createProjectCount += 1; },
        onSelectPanel: (value: "projects" | "explorers") => { selectedPanel = value; activePanel.value = value; },
        onSelectProject: (projectId: string) => { selectedProjectId = projectId; },
        onSelectExplorer: (explorerId: string) => { selectedExplorerId = explorerId; },
        onToggleShowArchived: (value: boolean) => { archivedVisible.value = value; },
        onArchiveExplorer: (explorerId: string) => { archivedExplorerId = explorerId; },
        onOpenProject: (projectId: string) => { openedProjectIds.push(projectId); },
        onOpenProjectSettings: (projectId: string) => { settingsProjectIds.push(projectId); },
        onArchiveProject: (projectId: string) => { archivedProjectIds.push(projectId); },
      });
    },
  }));
  app.mount(host);
  return {
    app,
    host,
    getCreateExplorerCount: () => createExplorerCount,
    getCreateProjectCount: () => createProjectCount,
    getSelectedPanel: () => selectedPanel,
    getSelectedProjectId: () => selectedProjectId,
    getSelectedExplorerId: () => selectedExplorerId,
    getArchivedExplorerId: () => archivedExplorerId,
    getOpenedProjectIds: () => openedProjectIds,
    getSettingsProjectIds: () => settingsProjectIds,
    getArchivedProjectIds: () => archivedProjectIds,
  };
}

describe("ThreadRail left workspace navigation", () => {
  it("renders exactly the Projects and Explorers entry buttons", () => {
    const mounted = mountRail();
    const entries = [...mounted.host.querySelectorAll<HTMLButtonElement>("button[data-left-panel]")];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(["探索", "项目"]);
    expect(entries[0]?.getAttribute("aria-selected")).toBe("true");
    expect(entries[1]?.getAttribute("aria-selected")).toBe("false");
    expect(mounted.host.querySelector(".explorer-list")).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens the inline project switcher without leaving the Explorer panel", async () => {
    const mounted = mountRail();
    const contextCard = mounted.host.querySelector<HTMLButtonElement>("button.project-context-card");

    expect(contextCard).not.toBeNull();
    expect(contextCard?.textContent).toContain("Project 1");
    expect(contextCard?.textContent).toContain("2 explorations");
    expect(contextCard?.textContent).toContain("/tmp/project-1");
    expect(contextCard?.textContent).toContain("Active");
    expect(contextCard?.getAttribute("aria-expanded")).toBe("false");

    contextCard?.click();
    await nextTick();

    expect(mounted.getSelectedPanel()).toBeNull();
    expect(contextCard?.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).not.toBeNull();
    expect(mounted.host.querySelectorAll("[data-inline-project-id]")).toHaveLength(2);
    expect(mounted.host.querySelector<HTMLButtonElement>('[data-inline-project-id="project-1"]')?.disabled).toBe(true);
    expect(mounted.host.querySelector(".explorer-list")).not.toBeNull();
    expect(mounted.host.querySelector(".project-list")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits a selected inline project and closes the switcher", async () => {
    const mounted = mountRail();
    const contextCard = mounted.host.querySelector<HTMLButtonElement>("button.project-context-card");

    contextCard?.click();
    await nextTick();
    mounted.host.querySelector<HTMLButtonElement>('[data-inline-project-id="project-2"]')?.click();
    await nextTick();

    expect(mounted.getSelectedProjectId()).toBe("project-2");
    expect(mounted.getSelectedPanel()).toBeNull();
    expect(contextCard?.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("closes the inline project switcher on Escape and outside pointer events", async () => {
    const mounted = mountRail();
    const contextCard = mounted.host.querySelector<HTMLButtonElement>("button.project-context-card");

    contextCard?.click();
    await nextTick();
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).not.toBeNull();
    contextCard?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).toBeNull();

    contextCard?.click();
    await nextTick();
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(mounted.host.querySelector("[data-inline-project-switcher]")).toBeNull();

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
    expect(mounted.host.textContent).toContain("Open Explorer");
    expect(mounted.host.textContent).toContain("Settings");
    expect(mounted.host.textContent).toContain("Archive");
    expect(mounted.host.textContent).toContain("New Project");
    expect(mounted.host.querySelector(".left-panel-manage")).toBeNull();

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

  it("emits create-project from the project list footer", async () => {
    const mounted = mountRail("projects");
    mounted.host.querySelector<HTMLButtonElement>('[data-project-action="create"]')?.click();
    await nextTick();

    expect(mounted.getCreateProjectCount()).toBe(1);

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

  it("renders all Explorer threads inline and marks the current thread active", () => {
    const mounted = mountRail();
    const currentThread = mounted.host.querySelector<HTMLButtonElement>('button[data-explorer-id="explorer-1"]');
    const explorerRows = [...mounted.host.querySelectorAll<HTMLButtonElement>("button[data-explorer-id]")];

    expect(mounted.host.querySelector(".thread-identity")).toBeNull();
    expect(mounted.host.querySelector("[aria-label=\"Open Explorer history\"]")).toBeNull();
    expect(explorerRows).toHaveLength(2);
    expect(explorerRows.map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Current exploration"), expect.stringContaining("Second exploration")]));
    expect(currentThread?.classList.contains("active")).toBe(true);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("keeps Explorer rows from shrinking when the thread list overflows", () => {
    expect(styles).toMatch(/\.explorer-list-row\s*\{[^}]*flex:\s*0 0 auto;/s);
  });

  it("hides archived Explorers by default and toggles them into the list", async () => {
    const mounted = mountRail("explorers", false, null, true);
    const toggle = mounted.host.querySelector<HTMLButtonElement>("[data-explorer-filter=archived]");

    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(mounted.host.querySelector('[data-explorer-id="explorer-3"]')).toBeNull();

    toggle?.click();
    await nextTick();

    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(mounted.host.querySelector('[data-explorer-id="explorer-3"]')).not.toBeNull();

    toggle?.click();
    await nextTick();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(mounted.host.querySelector('[data-explorer-id="explorer-3"]')).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("disables archiving the current Explorer and emits row archive actions", async () => {
    const mounted = mountRail("explorers", false, null, true, true);
    const currentArchive = mounted.host.querySelector<HTMLButtonElement>('[data-explorer-id="explorer-1"] [data-explorer-action="archive"]');
    const otherArchive = mounted.host.querySelector<HTMLButtonElement>('[data-explorer-id="explorer-2"] [data-explorer-action="archive"]');
    const archivedActivate = mounted.host.querySelector<HTMLButtonElement>('[data-explorer-id="explorer-3"] [data-explorer-action="activate"]');

    expect(currentArchive?.disabled).toBe(true);
    expect(currentArchive?.getAttribute("aria-label")).toContain("当前线程");
    otherArchive?.click();
    archivedActivate?.click();
    await nextTick();

    expect(mounted.getArchivedExplorerId()).toBe("explorer-3");
    expect(mounted.getSelectedExplorerId()).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits create-explorer from the inline new Explorer button", async () => {
    const mounted = mountRail();
    const createButton = mounted.host.querySelector<HTMLButtonElement>("button.left-panel-create");

    expect(createButton).not.toBeNull();
    expect(createButton?.textContent).toContain("新建 Explorer");
    createButton?.click();
    await nextTick();
    expect(mounted.getCreateExplorerCount()).toBe(1);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("disables the new Explorer button while creation is in flight", () => {
    const mounted = mountRail("explorers", true);
    const createButton = mounted.host.querySelector<HTMLButtonElement>("button.left-panel-create");

    expect(createButton?.disabled).toBe(true);
    expect(createButton?.getAttribute("aria-busy")).toBe("true");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows an explicit loading state for the Explorer directory", () => {
    const mounted = mountRail("explorers", false, null, false, false, true);

    expect(mounted.host.querySelector("[data-explorer-list-state=loading]")?.textContent).toContain("加载 Explorer 线程");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows an actionable empty state after the Explorer directory finishes loading", () => {
    const mounted = mountRail("explorers", false, null, false, false, false, null, []);

    expect(mounted.host.querySelector("[data-explorer-list-state=empty]")?.textContent).toContain("暂无 Explorer 线程");
    expect(mounted.host.querySelector("button.left-panel-create")).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows an explicit error state without hiding the existing directory", () => {
    const mounted = mountRail("explorers", false, null, false, false, false, "线程列表加载失败");

    expect(mounted.host.querySelector("[data-explorer-list-state=error]")?.textContent).toContain("线程列表加载失败");
    expect(mounted.host.querySelector('[data-explorer-id="explorer-1"]')).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("emits project actions independently from project selection", async () => {
    const mounted = mountRail("projects");
    const secondProject = mounted.host.querySelector<HTMLElement>('[data-project-row="project-2"]');
    secondProject?.querySelector<HTMLButtonElement>('[data-project-action="open-explorer"]')?.click();
    secondProject?.querySelector<HTMLButtonElement>('[data-project-action="settings"]')?.click();
    secondProject?.querySelector<HTMLButtonElement>('[data-project-action="archive"]')?.click();
    await nextTick();

    expect(mounted.getOpenedProjectIds()).toEqual(["project-2"]);
    expect(mounted.getSettingsProjectIds()).toEqual(["project-2"]);
    expect(mounted.getArchivedProjectIds()).toEqual(["project-2"]);
    expect(mounted.getSelectedProjectId()).toBeNull();
    expect(mounted.host.querySelector(".left-panel-manage")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("marks the active project action as busy and disables it", () => {
    const mounted = mountRail("projects", false, "project-2");
    const archive = mounted.host.querySelector<HTMLButtonElement>('[data-project-row="project-2"] [data-project-action="archive"]');

    expect(archive?.disabled).toBe(true);
    expect(archive?.getAttribute("aria-busy")).toBe("true");

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
