// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElTag, ElTree } from "element-plus";
import { describe, expect, it } from "vitest";
import ThreadRail from "./ThreadRail.vue";
import type { ExplorerPlan, ExplorerThread, Project } from "../types";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "./ThreadRail.vue"), "utf8");

function mountRail(
  panel: "projects" | "explorers" = "explorers",
  creatingExplorer = false,
  projectActionId: string | null = null,
  includeArchived = false,
  showArchived = false,
  explorerLoading = false,
  explorerError: string | null = null,
  explorerItems?: ExplorerThread[],
  planCenterActive = false,
  planCenterCount = 2,
  projectExecutionActive = false,
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let createExplorerCount = 0;
  let createProjectCount = 0;
  let selectedPanel: "projects" | "explorers" | null = null;
  let selectedPlanCenter = false;
  let selectedProjectId: string | null = null;
  let selectedExplorerId: string | null = null;
  let selectedExplorerPlanId: string | null = null;
  let selectedProjectExecution = false;
  let renamedExplorerPlanId: string | null = null;
  let threadAction: string | null = null;
  let archivedExplorerId: string | null = null;
  const openedProjectIds: string[] = [];
  const settingsProjectIds: string[] = [];
  const archivedProjectIds: string[] = [];
  const thread = {
    id: "explorer-1",
    projectId: "project-1",
    title: "Current exploration",
    state: "ACTIVE",
    contextMode: "FRESH",
    messageCount: 2,
    lastActivityAt: "2026-09-02T14:00:00.000Z",
  } as unknown as ExplorerThread;
  const project = {
    id: "project-1",
    name: "Project 1",
    repoRoot: "/tmp/project-1",
    status: "ACTIVE",
    currentExplorerThreadId: "explorer-1",
  } as unknown as Project;
  const projects = [
    { id: "project-1", name: "Project 1", repoRoot: "/tmp/project-1", status: "ACTIVE" },
    { id: "project-2", name: "Project 2", repoRoot: "/tmp/project-2", status: "ARCHIVED" },
  ] as unknown as Project[];
  const explorers =
    explorerItems ??
    ([
      {
        id: "explorer-1",
        projectId: "project-1",
        title: "Current exploration",
        state: "ACTIVE",
        contextMode: "FRESH",
        messageCount: 2,
        lastActivityAt: "2026-09-02T14:00:00.000Z",
      },
      {
        id: "explorer-2",
        projectId: "project-1",
        title: "Second exploration",
        state: "COMPLETED",
        contextMode: "FRESH",
        messageCount: 4,
        lastActivityAt: "2026-09-01T14:00:00.000Z",
      },
      ...(includeArchived
        ? [
            {
              id: "explorer-3",
              projectId: "project-1",
              title: "Archived exploration",
              state: "ARCHIVED",
              contextMode: "FRESH",
              messageCount: 1,
              lastActivityAt: "2026-08-31T14:00:00.000Z",
            },
          ]
        : []),
    ] as unknown as ExplorerThread[]);
  const requirements = [
    {
      id: "requirement-1",
      explorerThreadId: "explorer-1",
      projectId: "project-1",
      ordinal: 1,
      title: "Plan 1 / 待探索",
      titleSource: "AUTO",
      titleStatus: "PLACEHOLDER",
      latestUserMessageSummary: "写一份苹果的简介",
      runtimeStatus: "COMPLETED",
    },
    {
      id: "requirement-2",
      explorerThreadId: "explorer-1",
      projectId: "project-1",
      ordinal: 2,
      title: "Plan 2 / 待探索",
      titleSource: "AUTO",
      titleStatus: "PLACEHOLDER",
      latestUserMessageSummary: "写一份香蕉的简介",
      runtimeStatus: "QUEUED",
    },
  ] as unknown as ExplorerPlan[];
  const app = createApp(
    defineComponent({
      setup() {
        const activePanel = ref(panel);
        const archivedVisible = ref(showArchived);
        return () =>
          h(ThreadRail, {
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
            requirements,
            activeExplorerPlanId: "requirement-1",
            explorerPaused: false,
            projectExecutionActive,
            onCreateExplorer: () => {
              createExplorerCount += 1;
            },
            onCreateProject: () => {
              createProjectCount += 1;
            },
            onSelectPanel: (value: "projects" | "explorers") => {
              selectedPanel = value;
              activePanel.value = value;
            },
            onSelectPlanCenter: () => {
              selectedPlanCenter = true;
            },
            onSelectProject: (projectId: string) => {
              selectedProjectId = projectId;
            },
            onSelectExplorer: (explorerId: string) => {
              selectedExplorerId = explorerId;
            },
            onSelectProjectExecution: () => {
              selectedProjectExecution = true;
            },
            onSelectExplorerPlan: (explorerPlanId: string) => {
              selectedExplorerPlanId = explorerPlanId;
            },
            onRenameExplorerPlan: (explorerPlanId: string) => {
              renamedExplorerPlanId = explorerPlanId;
            },
            onThreadAction: (command: string) => {
              threadAction = command;
            },
            onToggleShowArchived: (value: boolean) => {
              archivedVisible.value = value;
            },
            onArchiveExplorer: (explorerId: string) => {
              archivedExplorerId = explorerId;
            },
            onOpenProject: (projectId: string) => {
              openedProjectIds.push(projectId);
            },
            onOpenProjectSettings: (projectId: string) => {
              settingsProjectIds.push(projectId);
            },
            onArchiveProject: (projectId: string) => {
              archivedProjectIds.push(projectId);
            },
          });
      },
    }),
  );
  app.component("el-tree", ElTree);
  app.component("el-button", ElButton);
  app.component("el-dropdown", ElDropdown);
  app.component("el-dropdown-item", ElDropdownItem);
  app.component("el-dropdown-menu", ElDropdownMenu);
  // 状态标签现在就是 `el-tag`——不注册的话它会被当成未知元素渲染，断言不到标签本身。
  app.component("el-tag", ElTag);
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
    getSelectedProjectExecution: () => selectedProjectExecution,
    getRenamedExplorerPlanId: () => renamedExplorerPlanId,
    getThreadAction: () => threadAction,
    getArchivedExplorerId: () => archivedExplorerId,
    getOpenedProjectIds: () => openedProjectIds,
    getSettingsProjectIds: () => settingsProjectIds,
    getArchivedProjectIds: () => archivedProjectIds,
  };
}

describe("ThreadRail left workspace navigation", () => {
  it("places the fixed project execution entry between the project area and New Explorer", async () => {
    const mounted = mountRail("explorers", false, null, false, false, false, null, undefined, false, 2, true);
    const projectCard = mounted.host.querySelector<HTMLElement>(".project-context-card");
    const executionEntry = mounted.host.querySelector<HTMLButtonElement>("[data-project-execution-entry]");
    const createExplorer = mounted.host.querySelector<HTMLButtonElement>('button[aria-label="新建 Explorer"]');

    expect(projectCard).not.toBeNull();
    expect(executionEntry?.textContent).toContain("项目执行线程");
    expect(executionEntry?.classList.contains("active")).toBe(true);
    expect(executionEntry?.getAttribute("aria-current")).toBe("page");
    expect(projectCard!.compareDocumentPosition(executionEntry!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(executionEntry!.compareDocumentPosition(createExplorer!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    executionEntry?.click();
    await nextTick();
    expect(mounted.getSelectedProjectExecution()).toBe(true);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("renders Explorers, Projects, and the plan center entry button", () => {
    const mounted = mountRail();
    const entries = [...mounted.host.querySelectorAll<HTMLButtonElement>("button.left-entry-button")];

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(["探索", "项目"]);
    expect(entries[0]?.getAttribute("aria-selected")).toBe("true");
    expect(entries[1]?.getAttribute("aria-selected")).toBe("false");
    expect(mounted.host.querySelector('[data-left-context="plan-center"]')).toBeNull();
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
    expect(contextCard?.textContent).toContain("2 条探索线程");
    expect(contextCard?.textContent).toContain("启用中");
    const titleRow = contextCard?.querySelector<HTMLElement>(".project-context-title-row");
    const metaRow = contextCard?.querySelector<HTMLElement>(".project-context-meta-row");
    expect(titleRow?.querySelector(".project-context-name")?.textContent).toContain("Project 1");
    expect(contextCard?.querySelector(".el-tag")?.textContent).toContain("启用中");
    expect(metaRow?.querySelector(".project-context-count")?.textContent).toContain("2 条探索线程");
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
    // **CSS 的换行与缩进不是这条断言的判据**：Prettier 会把一条规则从"一行写完"重排成"一行一声明"，
    // 而规则本身一个字都没变。断言的是**声明序列**，所以两边都先把连续空白压成单个空格再比——
    // 这样它测的是样式，不是排版。
    const flat = (text: string) => text.replace(/\s+/g, " ");
    expect(flat(styles)).toContain(flat(".project-context-title-row { display: flex; min-width: 0; align-items: center; width: 100%;"));
    expect(flat(styles)).toContain(
      flat(".project-context-name { display: block; min-width: 0; flex: 1 1 auto; margin-top: 0; overflow: hidden;"),
    );
    expect(styles).not.toContain(".project-context-path");
    expect(flat(styles)).toContain(flat(".project-context-summary { display: flex; min-width: 0; align-items: center; margin-top: 0;"));
    expect(flat(styles)).toContain(flat(".project-context-card { display: flex; min-width: 0; align-items: center; gap: 8px;"));
    // 状态标签改用 `el-tag`（尺寸由组件决定），这条手写规则随之外迁——与 `project-context-path` 同样是"不该再有"的断言。
    expect(styles).not.toContain(".project-context-status");
    expect(flat(styles)).toContain(flat(".left-panel-header { flex: 0 0 auto; min-width: 0; padding: 0 5px 8px;"));
    expect(flat(styles)).toContain(flat(".left-panel-scroll { min-height: 0; flex: 1 1 auto; overflow-y: auto; padding: 8px 1px 2px;"));
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
    expect(mounted.host.textContent).toContain("打开探索");
    expect(mounted.host.textContent).toContain("设置");
    expect(mounted.host.textContent).toContain("归档");
    expect(mounted.host.textContent).toContain("新建项目");
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
    expect(mounted.host.querySelector('[aria-label="Open Explorer history"]')).toBeNull();
    expect(explorerRows).toHaveLength(2);
    expect(explorerRows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Current exploration"), expect.stringContaining("Second exploration")]),
    );
    expect(currentThread?.querySelector(".explorer-list-item .left-list-icon")).toBeNull();
    expect(currentThread?.querySelector(".explorer-list-item small")).toBeNull();
    expect(currentThread?.querySelector(".explorer-list-item")?.textContent ?? "").not.toContain("messages");
    expect(currentThread?.querySelector(".explorer-list-item")?.textContent ?? "").not.toContain("explorer-1");
    expect(currentThread?.classList.contains("active")).toBe(true);
    expect(currentThread?.getAttribute("aria-current")).toBe("page");
    expect(mounted.host.querySelector<HTMLButtonElement>('button[data-explorer-id="explorer-2"]')?.classList.contains("active")).toBe(
      false,
    );

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("keeps requirement navigation out of the Explorer thread rail", async () => {
    const mounted = mountRail();
    const activeRow = mounted.host.querySelector<HTMLElement>('[data-explorer-id="explorer-1"]');
    const inactiveRow = mounted.host.querySelector<HTMLElement>('[data-explorer-id="explorer-2"]');

    expect(activeRow?.querySelector(".explorer-thread-tree")).toBeNull();
    expect(mounted.host.querySelector(".el-tree")).toBeNull();
    expect(activeRow?.querySelectorAll(".explorer-tree-task-row")).toHaveLength(0);
    expect(activeRow?.textContent).not.toContain("写一份苹果的简介");
    expect(activeRow?.textContent).not.toContain("写一份香蕉的简介");
    expect(inactiveRow?.querySelector(".explorer-thread-tree")).toBeNull();
    expect(source).not.toContain("<el-tree");
    expect(source).not.toContain('command="new-requirement"');

    activeRow?.querySelector<HTMLButtonElement>('button[data-explorer-id="explorer-1"]')?.click();
    await nextTick();

    expect(mounted.getSelectedExplorerId()).toBe("explorer-1");

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

  it("groups explorer threads by their creation day", async () => {
    const now = new Date();
    const todayAt = (hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 5).toISOString();
    const yesterdayAt = (hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 5).toISOString();
    const mounted = mountRail("explorers", false, null, false, false, false, null, [
      {
        id: "explorer-today",
        projectId: "project-1",
        title: "今天开的",
        state: "ACTIVE",
        contextMode: "FRESH",
        messageCount: 1,
        createdAt: todayAt(9),
        lastActivityAt: todayAt(9),
      },
      {
        id: "explorer-yesterday",
        projectId: "project-1",
        title: "昨天开的",
        state: "COMPLETED",
        contextMode: "FRESH",
        messageCount: 2,
        createdAt: yesterdayAt(21),
        lastActivityAt: yesterdayAt(21),
      },
    ] as unknown as ExplorerThread[]);

    // 分组按**创建日**：线程标题本身就是创建时刻，按活动日分组会与它显示的名字自相矛盾。
    const headings = [...mounted.host.querySelectorAll<HTMLElement>("[data-explorer-day]")];
    expect(headings.map((heading) => heading.querySelector("span")?.textContent)).toEqual(["今天", "昨天"]);
    expect(headings[0]?.querySelector("small")?.textContent).toBe("1");
    // 日期头是展示层，不能顶替线程行：两行仍然可选中。
    expect(mounted.host.querySelector('[data-explorer-id="explorer-today"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-explorer-id="explorer-yesterday"]')).not.toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
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
    const currentArchive = mounted.host.querySelector<HTMLButtonElement>(
      '[data-explorer-id="explorer-1"] [data-explorer-action="archive"]',
    );
    const otherArchive = mounted.host.querySelector<HTMLButtonElement>('[data-explorer-id="explorer-2"] [data-explorer-action="archive"]');
    const archivedActivate = mounted.host.querySelector<HTMLButtonElement>(
      '[data-explorer-id="explorer-3"] [data-explorer-action="activate"]',
    );

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
    const createButton = mounted.host.querySelector<HTMLButtonElement>('button[aria-label="新建 Explorer"]');

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
    const createButton = mounted.host.querySelector<HTMLButtonElement>('button[aria-label="新建 Explorer"]');

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
    expect(mounted.host.querySelector('button[aria-label="新建 Explorer"]')).not.toBeNull();

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

  it("does not put Plan Center in the left rail", async () => {
    const mounted = mountRail();

    expect(mounted.host.querySelector(".rail-nav")).toBeNull();
    expect(mounted.host.querySelectorAll("button[data-context]")).toHaveLength(0);
    expect(mounted.host.querySelector<HTMLButtonElement>('button[data-left-context="plan-center"]')).toBeNull();
    expect(mounted.host.textContent).not.toContain("Plan candidates");
    expect(mounted.host.textContent).not.toContain("Dispatched plans");
    expect(mounted.host.textContent).not.toContain("Active runs");
    expect(mounted.host.textContent).not.toContain("Needs attention");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
