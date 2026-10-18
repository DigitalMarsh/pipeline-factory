// @vitest-environment jsdom
/**
 * 测试职责：Worktree 面板的可见行为 —— 表格渲染、筛选、合并进行中的横幅、预览对话框、
 *   以及"不能操作"的按钮状态。
 *
 * 设计说明：服务端判据（`mergeable` / `cleanupable`）在 fixture 里直接给定，本测试只验证界面
 *   是否**如实反映**它们、以及按钮是否真的把请求发了出去。真正的判据由 domain 与 API 用例覆盖。
 */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectWorktreesPanel from "./ProjectWorktreesPanel.vue";
import type { Project, WorktreeInventory, WorktreeItem, WorktreeMergePreview } from "../types";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    worktrees: vi.fn(),
    previewWorktreeMerge: vi.fn(),
    mergeWorktree: vi.fn(),
    continueWorktreeMerge: vi.fn(),
    abortWorktreeMerge: vi.fn(),
    cleanupWorktree: vi.fn(),
    updateProject: vi.fn(),
    worktreeLog: vi.fn(),
    worktreeCommitFiles: vi.fn(),
    worktreeCommitDiff: vi.fn(),
    worktreeServices: vi.fn(),
    startWorktreeService: vi.fn(),
    stopWorktreeService: vi.fn(),
    worktreeServiceLogs: vi.fn(),
    worktreeEventsUrl: vi.fn((projectId: string) => `/api/v4/projects/${projectId}/worktrees/events`),
    worktreeRuntime: vi.fn(),
    switchWorktreeRuntime: vi.fn(),
    clearWorktreeRuntime: vi.fn(),
    startRuntimeService: vi.fn(),
    stopRuntimeService: vi.fn(),
    runtimeServiceLogs: vi.fn(),
  },
}));
vi.mock("../api", () => ({ api: apiMocks }));

/** 极简 EventSource 桩：测试只需要 `addEventListener` + 一个触发入口。 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    FakeEventSource.instances = FakeEventSource.instances.filter((instance) => instance !== this);
  }
}

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.modelValue ? h("div", { class: "el-dialog-stub" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null);
  },
});
const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});
const ElTagStub = defineComponent({
  setup(_props, { attrs, slots }) {
    return () => h("span", attrs, slots.default?.());
  },
});

const mountedApps: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => {
  mountedApps.splice(0).forEach(({ app, host }) => {
    app.unmount();
    host.remove();
  });
  FakeEventSource.instances = [];
  openedSettingsTabs.length = 0;
  vi.clearAllMocks();
});

function item(overrides: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    itemId: "branch:feature/a",
    kind: "branch_worktree",
    branch: "feature/a",
    displayName: "feature/a",
    isBaseBranch: false,
    hasWorktree: true,
    isDetached: false,
    worktreePath: "/repo-wt/a",
    effectivePath: "/repo-wt/a",
    missing: false,
    status: "committed_unmerged",
    mergeRelation: "current_unmerged",
    gitDirtyState: "clean",
    conflictFiles: [],
    aheadCount: 2,
    behindCount: 0,
    merged: false,
    lastCommit: "abc1234",
    lastCommitAt: 1_760_000_000,
    mergeable: true,
    blockers: [],
    cleanupable: false,
    cleanupBlockers: ["该分支当前未合并到主分支，不能清理。"],
    isLiveRunWorkspace: false,
    everMerged: false,
    isIgnored: false,
    matchesScope: true,
    containedInBranch: true,
    factory: null,
    ...overrides,
  };
}

function inventory(overrides: Partial<WorktreeInventory> = {}): WorktreeInventory {
  return {
    projectId: "project-1",
    repoRoot: "/repo",
    baseBranch: "main",
    baseHead: "basehead",
    currentBranch: "main",
    mergeInProgress: null,
    activeRunIds: [],
    filter: { filterMode: "all", branchPatterns: [], ignoredBranches: [], includeDetachedWorktrees: true },
    filteredOutCount: 0,
    items: [
      item({
        itemId: "branch:main",
        branch: "main",
        displayName: "main",
        isBaseBranch: true,
        kind: "base_branch",
        status: "no_updates",
        aheadCount: 0,
        mergeRelation: "current_merged",
        merged: true,
        mergeable: false,
        blockers: ["不能合并主分支自身。"],
        cleanupable: false,
        cleanupBlockers: ["主分支不能清理。"],
      }),
      item(),
      item({
        itemId: "branch:feature/merged",
        branch: "feature/merged",
        displayName: "feature/merged",
        status: "merged_clean",
        merged: true,
        aheadCount: 0,
        mergeRelation: "current_merged",
        mergeable: false,
        blockers: ["该分支已经合并到主分支。"],
        cleanupable: true,
        cleanupBlockers: [],
      }),
    ],
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

function preview(overrides: Partial<WorktreeMergePreview> = {}): WorktreeMergePreview {
  return {
    projectId: "project-1",
    repoRoot: "/repo",
    itemId: "branch:feature/a",
    branch: "feature/a",
    baseBranch: "main",
    baseHead: "basehead",
    taskHead: "taskhead",
    mergeBase: "mergebase",
    aheadCount: 2,
    behindCount: 0,
    dirtyState: "clean",
    merged: false,
    conclusion: "ready",
    conclusionLabel: "可以合并",
    canConfirm: true,
    blockers: [],
    warnings: [],
    recentCommits: [{ hash: "abc1234", subject: "feature change", author: "Bill", relativeTime: "1 天前" }],
    fileSummary: { total: 1, added: 1, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0, unknown: 0 },
    fileChanges: [{ status: "A", path: "ahead.txt", previousPath: null }],
    conflictPrediction: { status: "clean", hasConflicts: false, conflictFiles: [], message: "未预测到文本级合并冲突。" },
    commands: ["git -C /repo switch main", "git -C /repo merge --no-ff feature/a"],
    expectedBranchHead: "taskhead",
    expectedBaseHead: "basehead",
    factory: null,
    ...overrides,
  };
}

const openedSettingsTabs: string[] = [];

async function mountPanel(next: WorktreeInventory, options: { runtime?: unknown } = {}) {
  apiMocks.worktrees.mockResolvedValue(next);
  apiMocks.updateProject.mockResolvedValue({ project: { id: "project-1" } });
  apiMocks.worktreeRuntime.mockResolvedValue(
    options.runtime ?? {
      runtime: {
        path: "/worktrees/.runtime",
        exists: false,
        link: null,
        current: null,
        servicesConfigPath: null,
      },
      services: null,
    },
  );
  apiMocks.worktreeServices.mockResolvedValue({
    itemId: "branch:feature/a",
    worktreePath: "/repo-wt/a",
    configPath: null,
    configError: null,
    services: [],
    states: [],
  });
  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(ProjectWorktreesPanel, {
    projectId: "project-1",
    project: { id: "project-1", name: "Project 1", settings: {} } as unknown as Project,
    onOpenSettings: (tab: string) => openedSettingsTabs.push(tab),
  });
  app.component("el-dialog", ElDialogStub);
  app.component("el-button", ElButtonStub);
  app.component("el-tag", ElTagStub);
  app.mount(host);
  mountedApps.push({ app, host });
  await flush();
  return host;
}

async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("Worktree 面板", () => {
  it("渲染清单与汇总，并按状态筛选", async () => {
    const host = await mountPanel(inventory());

    expect(host.querySelector("[data-worktrees-summary]")?.textContent).toContain("1 项可合并");
    expect(host.querySelectorAll("[data-worktree-item]")).toHaveLength(3);

    host.querySelector<HTMLButtonElement>('[data-worktree-status-filter="cleanup"]')?.click();
    await flush();
    const rows = host.querySelectorAll("[data-worktree-item]");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-worktree-item")).toBe("branch:feature/merged");
  });

  it("不可合并的行按钮被禁用，选中后列出原因", async () => {
    const host = await mountPanel(inventory());
    const mainRow = host.querySelector<HTMLElement>('[data-worktree-item="branch:main"]');
    const previewButton = mainRow?.querySelector<HTMLButtonElement>("[data-worktree-preview]");
    expect(previewButton?.disabled).toBe(true);

    mainRow?.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(host.querySelector("[data-worktree-detail]")?.textContent).toContain("不能合并主分支自身");
  });

  it("合并进行中的横幅排在表格之前，并能继续/中止", async () => {
    apiMocks.continueWorktreeMerge.mockResolvedValue({
      result: {
        status: "merged",
        message: "合并继续完成。",
        branch: "feature/a",
        baseBranch: "main",
        conflictFiles: [],
        baseHeadBefore: "a",
        baseHeadAfter: "b",
        commands: [],
        factory: null,
      },
    });
    const host = await mountPanel(
      inventory({
        mergeInProgress: { kind: "merge", mergeHead: "deadbeefdeadbeef", currentBranch: "main", conflictFiles: ["README.md"] },
      }),
    );

    const banner = host.querySelector("[data-merge-in-progress]");
    const table = host.querySelector(".worktrees-table");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("README.md");
    expect(banner && table ? banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();

    host.querySelector<HTMLButtonElement>("[data-merge-continue]")?.click();
    await flush();
    expect(apiMocks.continueWorktreeMerge).toHaveBeenCalledWith("project-1");
  });

  it("预览合并会拉预览并在对话框里展示结论与命令", async () => {
    apiMocks.previewWorktreeMerge.mockResolvedValue({ preview: preview() });
    const host = await mountPanel(inventory());
    const row = host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]');

    row?.querySelector<HTMLButtonElement>("[data-worktree-preview]")?.click();
    await flush();

    expect(apiMocks.previewWorktreeMerge).toHaveBeenCalledWith("project-1", "branch:feature/a");
    const dialog = host.querySelector("[data-merge-preview]");
    expect(dialog?.textContent).toContain("可以合并");
    host.querySelector<HTMLButtonElement>('[data-preview-tab="commands"]')?.click();
    await flush();
    expect(host.querySelector('[data-preview-pane="commands"]')?.textContent).toContain("merge --no-ff feature/a");
  });

  it("确认合并把预览给出的两个 SHA 原样带回", async () => {
    apiMocks.previewWorktreeMerge.mockResolvedValue({ preview: preview() });
    apiMocks.mergeWorktree.mockResolvedValue({
      result: {
        status: "merged",
        message: "合并完成。",
        branch: "feature/a",
        baseBranch: "main",
        conflictFiles: [],
        baseHeadBefore: "basehead",
        baseHeadAfter: "newhead",
        commands: [],
        factory: { mergeRequest: "not_found", runId: null, workspace: null, message: "该分支不属于任何 Factory Run。" },
      },
    });
    const host = await mountPanel(inventory());
    host
      .querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]')
      ?.querySelector<HTMLButtonElement>("[data-worktree-preview]")
      ?.click();
    await flush();

    host.querySelector<HTMLButtonElement>("[data-merge-confirm]")?.click();
    await flush();

    expect(apiMocks.mergeWorktree).toHaveBeenCalledWith("project-1", {
      itemId: "branch:feature/a",
      expectedBranchHead: "taskhead",
      expectedBaseHead: "basehead",
    });
    expect(host.querySelector("[data-merge-result]")?.textContent).toContain("该分支不属于任何 Factory Run");
  });

  it("清理按钮按服务端 cleanupable 禁用", async () => {
    const host = await mountPanel(inventory());
    const mergedRow = host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/merged"]');
    const unmergedRow = host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]');

    expect(mergedRow?.querySelector<HTMLButtonElement>("[data-worktree-cleanup]")?.disabled).toBe(false);
    expect(unmergedRow?.querySelector<HTMLButtonElement>("[data-worktree-cleanup]")?.disabled).toBe(true);
  });
});

describe("Worktree 面板：复盘后新增的交互", () => {
  it("按名称排序会改变行序（主分支仍置顶）", async () => {
    const inventoryWithTimes = inventory();
    inventoryWithTimes.items[1] = item({ itemId: "branch:zeta", branch: "zeta", displayName: "zeta", lastCommitAt: 100 });
    inventoryWithTimes.items[2] = item({
      itemId: "branch:alpha",
      branch: "alpha",
      displayName: "alpha",
      lastCommitAt: 300,
      status: "merged_clean",
      merged: true,
      mergeRelation: "current_merged",
      cleanupable: true,
      cleanupBlockers: [],
    });
    const host = await mountPanel(inventoryWithTimes);

    // 方向与键是**两个独立开关**：默认倒序（最近提交在前）。先切正序，再按名称。
    host.querySelector<HTMLButtonElement>("[data-worktree-sort-direction]")?.click();
    host.querySelector<HTMLButtonElement>('[data-worktree-sort="name"]')?.click();
    await flush();
    const rows = [...host.querySelectorAll("[data-worktree-item]")].map((row) => row.getAttribute("data-worktree-item"));
    expect(rows[0]).toBe("branch:main");
    expect(rows.slice(1)).toEqual(["branch:alpha", "branch:zeta"]);
  });

  it("范围编辑在项目设置里：面板只给入口", async () => {
    const host = await mountPanel(inventory());
    const button = host.querySelector<HTMLButtonElement>("[data-worktree-open-settings]");

    expect(button?.textContent).toContain("在项目设置中配置");
    button?.click();
    await flush();

    // 面板不再自己改范围；它把用户带到项目设置的 Worktree 页签。
    expect(apiMocks.updateProject).not.toHaveBeenCalled();
    expect(openedSettingsTabs).toEqual(["worktree"]);
  });

  it("详情里的忽略按钮把分支写进 ignoredBranches", async () => {
    const host = await mountPanel(inventory());
    const row = host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]');
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    host.querySelector<HTMLButtonElement>("[data-worktree-toggle-ignore]")?.click();
    await flush();

    expect(apiMocks.updateProject).toHaveBeenCalledWith("project-1", {
      settings: { worktree: { ignoredBranches: ["feature/a"] } },
    });
  });

  it("显示被过滤的项时带 includeFiltered 重新拉清单", async () => {
    const host = await mountPanel(inventory({ filteredOutCount: 3 }));
    const button = host.querySelector<HTMLButtonElement>("[data-worktree-include-filtered]");
    expect(button?.textContent).toContain("3");
    button?.click();
    await flush();
    expect(apiMocks.worktrees).toHaveBeenLastCalledWith("project-1", { includeFiltered: true });
  });

  it("includeFiltered 为真且过滤数归零时按钮仍在，能切回范围视图", async () => {
    const host = await mountPanel(inventory({ filteredOutCount: 1 }));
    // 切到"显示全部"之后服务端回 0 条被过滤项：此时若只按 filteredOutCount 渲染，按钮会消失，
    // 用户再也切不回范围视图（浏览器实测踩过）。
    apiMocks.worktrees.mockResolvedValue(inventory({ filteredOutCount: 0 }));
    host.querySelector<HTMLButtonElement>("[data-worktree-include-filtered]")?.click();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();

    const button = host.querySelector<HTMLButtonElement>("[data-worktree-include-filtered]");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("只看项目范围");

    button?.click();
    await flush();
    expect(apiMocks.worktrees).toHaveBeenLastCalledWith("project-1", { includeFiltered: false });
  });

  it("服务端事件只触发一次防抖刷新", async () => {
    const host = await mountPanel(inventory());
    const source = FakeEventSource.instances[0];
    expect(source?.url).toContain("/worktrees/events");
    const callsBefore = apiMocks.worktrees.mock.calls.length;

    source?.dispatchEvent(new Event("worktree"));
    source?.dispatchEvent(new Event("worktree"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await flush();

    expect(apiMocks.worktrees.mock.calls.length).toBe(callsBefore + 1);
    void host;
  });

  it("重连后补一次刷新，首次连接不重复拉清单", async () => {
    const host = await mountPanel(inventory());
    const source = FakeEventSource.instances[0];
    const calls = apiMocks.worktrees.mock.calls.length;

    // 首次 open 与 onMounted 的 load() 重复，不该再拉一次。
    source?.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(apiMocks.worktrees.mock.calls.length).toBe(calls);

    // 断线期间的写操作不会补推，所以重连成功要补一次。
    source?.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(apiMocks.worktrees.mock.calls.length).toBe(calls + 1);
    void host;
  });

  it("提交历史按钮打开只读日志对话框", async () => {
    apiMocks.worktreeLog.mockResolvedValue({
      items: [
        {
          hash: "abc1234",
          shortHash: "abc1234",
          subject: "feature change",
          author: "Bill",
          authoredAt: "2026-10-17",
          relativeTime: "1 天前",
        },
      ],
    });
    apiMocks.worktreeCommitFiles.mockResolvedValue({ items: [{ status: "A", path: "ahead.txt", previousPath: null }] });
    const host = await mountPanel(inventory());
    host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    host.querySelector<HTMLButtonElement>("[data-worktree-log-open]")?.click();
    await flush();
    await flush();

    expect(apiMocks.worktreeLog).toHaveBeenCalledWith("project-1", "feature/a");
    expect(host.querySelector("[data-worktree-log]")?.textContent).toContain("feature change");
  });
});

/** 执行目录：合并前验证用的固定路径。 */
describe("Worktree 面板 · 执行目录", () => {
  function runtimeInfo(overrides: Partial<{ itemId: string; branch: string; displayName: string }> = {}) {
    return {
      runtime: {
        path: "/worktrees/.runtime",
        exists: true,
        link: { path: "/worktrees/.runtime/repo", target: "/worktrees/a", isSymlink: true, exists: true },
        current: {
          itemId: overrides.itemId ?? "branch:feature/a",
          branch: overrides.branch ?? "feature/a",
          displayName: overrides.displayName ?? "feature/a",
          worktreePath: "/worktrees/a",
        },
        servicesConfigPath: null,
      },
      services: null,
    };
  }

  it("未切换时显示「尚未切换」，详情里可以设为执行目录", async () => {
    const host = await mountPanel(inventory());
    expect(host.querySelector("[data-worktree-runtime]")?.textContent).toContain("尚未切换");

    host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    const button = host.querySelector<HTMLButtonElement>("[data-runtime-switch]");
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    button?.click();
    await flush();

    expect(apiMocks.switchWorktreeRuntime).toHaveBeenCalledWith("project-1", "branch:feature/a");
  });

  it("已是当前目标时按钮禁用，服务区块走 runtime 接口", async () => {
    apiMocks.runtimeServiceLogs.mockResolvedValue({ items: [] });
    const host = await mountPanel(inventory(), { runtime: runtimeInfo() });
    expect(host.querySelector("[data-worktree-runtime]")?.textContent).toContain("当前");

    host.querySelector<HTMLElement>('[data-worktree-item="branch:feature/a"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();

    expect(host.querySelector<HTMLButtonElement>("[data-runtime-switch]")?.disabled).toBe(true);
    // 服务区块在 runtime 模式下先读项目执行目录（load 一次 + 服务区块一次），而不是 worktree 接口。
    expect(apiMocks.worktreeServices).not.toHaveBeenCalled();
    expect(apiMocks.worktreeRuntime.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("清空执行目录要先确认，确认后调用 clear", async () => {
    const host = await mountPanel(inventory(), { runtime: runtimeInfo() });
    host.querySelector<HTMLButtonElement>("[data-runtime-clear]")?.click();
    await flush();

    const confirm = [...document.querySelectorAll(".confirm-dialog button")].find((button) => button.textContent?.includes("清空")) as
      HTMLButtonElement | undefined;
    confirm?.click();
    await flush();

    expect(apiMocks.clearWorktreeRuntime).toHaveBeenCalledWith("project-1");
  });
});
