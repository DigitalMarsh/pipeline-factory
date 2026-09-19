// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElTree } from "element-plus";
import { describe, expect, it } from "vitest";
import ThreadRail from "./ThreadRail.vue";
import type { ExplorerThread, Project } from "../types";
import type { TaskTreeItem } from "../utils/taskTree";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "./ThreadRail.vue"), "utf8");

function mountRail(panel: "projects" | "explorers" = "explorers", creatingExplorer = false, projectActionId: string | null = null, includeArchived = false, showArchived = false, explorerLoading = false, explorerError: string | null = null, explorerItems?: ExplorerThread[], planCenterActive = false, planCenterCount = 2) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let createExplorerCount = 0;
  let createProjectCount = 0;
  let selectedPanel: "projects" | "explorers" | null = null;
  let selectedPlanCenter = false;
  let selectedProjectId: string | null = null;
  let selectedExplorerId: string | null = null;
  let selectedExplorerPlanId: string | null = null;
  let selectedPlanTreeItem: TaskTreeItem | null = null;
  let threadAction: string | null = null;
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
  const taskTreeItems = [
    {
      task: { id: "task-1", ordinal: 1, title: "Plan 1 / 待探索", latestUserMessageSummary: "写一份苹果的简介", runtimeStatus: "COMPLETED" },
      plan: { id: "plan-1", title: "Apple overview", revision: 1, status: "DRAFT" },
      planKey: "plan-plan-1",
      planTarget: "plan:plan-1",
    },
    {
      task: { id: "task-2", ordinal: 2, title: "Task 2 / 待探索", latestUserMessageSummary: "写一份香蕉的简介", runtimeStatus: "QUEUED" },
      plan: { id: "plan-2", title: "Banana overview", revision: 1, status: "DRAFT" },
      planKey: "plan-plan-2",
      planTarget: "plan:plan-2",
    },
  ] as unknown as TaskTreeItem[];
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
        planCenterActive,
        planCenterCount,
        taskTreeItems,
        activeExplorerPlanId: "task-1",
        explorerPaused: false,
        onCreateExplorer: () => { createExplorerCount += 1; },
        onCreateProject: () => { createProjectCount += 1; },
        onSelectPanel: (value: "projects" | "explorers") => { selectedPanel = value; activePanel.value = value; },
        onSelectPlanCenter: () => { selectedPlanCenter = true; },
        onSelectProject: (projectId: string) => { selectedProjectId = projectId; },
        onSelectExplorer: (explorerId: string) => { selectedExplorerId = explorerId; },
        onSelectExplorerPlan: (explorerPlanId: string) => { selectedExplorerPlanId = explorerPlanId; },
        onSelectPlanTreeItem: (item: TaskTreeItem) => { selectedPlanTreeItem = item; },
        onThreadAction: (command: string) => { threadAction = command; },
        onToggleShowArchived: (value: boolean) => { archivedVisible.value = value; },
        onArchiveExplorer: (explorerId: string) => { archivedExplorerId = explorerId; },
        onOpenProject: (projectId: string) => { openedProjectIds.push(projectId); },
        onOpenProjectSettings: (projectId: string) => { settingsProjectIds.push(projectId); },
        onArchiveProject: (projectId: string) => { archivedProjectIds.push(projectId); },
      });
    },
  }));
  app.component("el-tree", ElTree);
  app.component("el-button", ElButton);
  app.component("el-dropdown", ElDropdown);
  app.component("el-dropdown-item", ElDropdownItem);
  app.component("el-dropdown-menu", ElDropdownMenu);
  app.mount(host);
  return {
    app,
    host,
    getCreateExplorerCount: () => createExplorerCount,
    getCreateProjectCount: () => createProjectCount,
    getSelectedPanel: () => selectedPanel,
    getSelectedPlanCenter: () => selectedPlanCenter,
    getSelectedProjectId: () => selectedProjectId,
    getSelectedExplorerId: () => selectedExplorerId,
    getSelectedExplorerPlanId: () => selectedExplorerPlanId,
    getSelectedPlanTreeItem: () => selectedPlanTreeItem,
    getThreadAction: () => threadAction,
    getArchivedExplorerId: () => archivedExplorerId,
    getOpenedProjectIds: () => openedProjectIds,
    getSettingsProjectIds: () => settingsProjectIds,
    getArchivedProjectIds: () => archivedProjectIds,
  };
}

describe("ThreadRail left workspace navigation", () => {
  it("renders Explorers, Projects, and the plan center entry button", () => {
    const mounted = mountRail();
    const entries = [...mounted.host.querySelectorAll<HTMLButtonElement>("button.left-entry-button")];

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(["探索", "项目", "计划中心2"]);
    expect(entries[0]?.getAttribute("aria-selected")).toBe("true");
    expect(entries[1]?.getAttribute("aria-selected")).toBe("false");
    expect(entries[2]?.getAttribute("aria-selected")).toBe("false");
    expect(entries[2]?.getAttribute("data-left-context")).toBe("plan-center");
    expect(entries[2]?.getAttribute("aria-label")).toBe("计划中心");
    expect(mounted.host.querySelector(".explorer-list")).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens the inline project switcher without leaving the Explorer panel", async () => {
    const mounted = mountRail();
    const contextCard = mounted.host.querySelector<HTMLButtonElement>("button.project-context-card");

    expect(contextCard).not.toBeNull();
    expect(contextCard?.textContent).toContain("Project 1");
    expect(contextCard?.textContent).not.toContain("CURRENT PROJECT");
    expect(contextCard?.textContent).toContain("2 explorations");
    expect(contextCard?.textContent).toContain("Active");
    const titleRow = contextCard?.querySelector<HTMLElement>(".project-context-title-row");
    const metaRow = contextCard?.querySelector<HTMLElement>(".project-context-meta-row");
    expect(titleRow?.querySelector(".project-context-name")?.textContent).toContain("Project 1");
    expect(contextCard?.querySelector(".project-context-status")?.textContent).toContain("Active");
    expect(metaRow?.querySelector(".project-context-count")?.textContent).toContain("2 explorations");
    expect(metaRow?.querySelectorAll("*")).toHaveLength(1);
    expect(contextCard?.querySelector(".project-context-path")).toBeNull();
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

  it("uses compact styling for the project context card", () => {
    expect(styles).toContain(".project-context-title-row { display: flex; min-width: 0; align-items: center; width: 100%;");
    expect(styles).toContain(".project-context-name { display: block; min-width: 0; flex: 1 1 auto; margin-top: 0; overflow: hidden;");
    expect(styles).not.toContain(".project-context-path");
    expect(styles).toContain(".project-context-summary { display: flex; min-width: 0; align-items: center; margin-top: 0;");
    expect(styles).toContain(".project-context-card { display: flex; min-width: 0; align-items: center; gap: 8px;");
    expect(styles).toContain(".project-context-status { display: inline-flex; align-self: center; align-items: center;");
    expect(styles).toContain(".left-panel-header { flex: 0 0 auto; min-width: 0; padding: 0 5px 8px;");
    expect(styles).toContain(".left-panel-scroll { min-height: 0; flex: 1 1 auto; overflow-y: auto; padding: 8px 1px 2px;");
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
    expect(currentThread?.querySelector(".explorer-list-item .left-list-icon")).toBeNull();
    expect(currentThread?.querySelector(".explorer-list-item small")).toBeNull();
    expect(currentThread?.querySelector(".explorer-list-item")?.textContent ?? "").not.toContain("messages");
    expect(currentThread?.querySelector(".explorer-list-item")?.textContent ?? "").not.toContain("explorer-1");
    expect(currentThread?.classList.contains("active")).toBe(true);
    expect(currentThread?.getAttribute("aria-current")).toBe("page");
    expect(currentThread?.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.querySelector<HTMLButtonElement>('button[data-explorer-id="explorer-2"]')?.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("renders the active Explorer as a lightweight always-visible Task and Plan tree", async () => {
    const mounted = mountRail();
    const activeRow = mounted.host.querySelector<HTMLElement>('[data-explorer-id="explorer-1"]');
    const inactiveRow = mounted.host.querySelector<HTMLElement>('[data-explorer-id="explorer-2"]');

    expect(activeRow?.querySelector(".explorer-thread-tree")).not.toBeNull();
    expect(activeRow?.querySelector(".el-tree")).not.toBeNull();
    expect(activeRow?.querySelectorAll(".el-tree-node")).toHaveLength(5);
    expect(activeRow?.querySelectorAll(".explorer-tree-task-row")).toHaveLength(2);
    expect(activeRow?.querySelectorAll(".explorer-tree-plan-button")).toHaveLength(2);
    expect(activeRow?.querySelector(".explorer-tree-plan-button")?.textContent).toContain("Apple overview");
    expect(activeRow?.querySelectorAll(".explorer-tree-plan-button")[1]?.textContent).toContain("Banana overview");
    expect(source).toContain("<el-tree");
    expect(source).toContain(":default-expand-all=\"true\"");
    expect(source).toContain(":expand-on-click-node=\"false\"");
    expect(styles).toContain(".explorer-thread-tree .el-tree-node__expand-icon { display: none; }");
    expect(styles).toContain(".explorer-thread-tree > .el-tree-node > .el-tree-node__children::before");
    expect(styles).toContain(".explorer-thread-tree > .el-tree-node > .el-tree-node__children > .el-tree-node::after");
    expect(styles).toContain(".explorer-thread-tree > .el-tree-node > .el-tree-node__children > .el-tree-node > .el-tree-node__children::before");
    expect(styles).toContain(".thread-rail .explorer-tree-task-row.active { border-left-color:");
    expect(inactiveRow?.querySelector(".explorer-thread-tree")).toBeNull();
    expect(activeRow?.querySelector<HTMLButtonElement>(".explorer-tree-task-button")?.getAttribute("aria-current")).toBe("page");

    activeRow?.querySelectorAll<HTMLButtonElement>(".explorer-tree-task-button")[1]?.click();
    activeRow?.querySelectorAll<HTMLButtonElement>(".explorer-tree-plan-button")[1]?.click();
    await nextTick();

    expect(mounted.getSelectedExplorerPlanId()).toBe("task-2");
    expect(mounted.getSelectedPlanTreeItem()?.planKey).toBe("plan-plan-2");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("exposes thread actions beside the active thread row", () => {
    const mounted = mountRail();
    const activeRow = mounted.host.querySelector<HTMLElement>('[data-explorer-id="explorer-1"]');

    expect(activeRow?.querySelector(".explorer-thread-row-actions")).not.toBeNull();
    expect(activeRow?.querySelector<HTMLButtonElement>('[aria-label="线程操作"]')).not.toBeNull();
    expect(styles).toContain(".explorer-thread-row-actions");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("keeps delete as a dangerous current-thread dropdown action", () => {
    expect(source).toContain('command="delete"');
    expect(source).toContain("thread-action-danger");
    expect(source).toContain("删除线程");
    expect(styles).toContain(".thread-action-danger");
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

  it("moves only Plan Center into the left rail", async () => {
    const mounted = mountRail();

    expect(mounted.host.querySelector(".rail-nav")).toBeNull();
    expect(mounted.host.querySelectorAll("button[data-context]")).toHaveLength(0);
    expect(mounted.host.querySelector<HTMLButtonElement>('button[data-left-context="plan-center"]')).not.toBeNull();
    expect(mounted.host.textContent).not.toContain("Plan candidates");
    expect(mounted.host.textContent).not.toContain("Dispatched plans");
    expect(mounted.host.textContent).not.toContain("Active runs");
    expect(mounted.host.textContent).not.toContain("Needs attention");

    mounted.host.querySelector<HTMLButtonElement>('button[data-left-context="plan-center"]')?.click();
    await nextTick();
    expect(mounted.getSelectedPlanCenter()).toBe(true);

    mounted.app.unmount();
    mounted.host.remove();
  });
});
