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
const ElCheckboxStub = defineComponent({ props: { modelValue: Boolean, label: String, disabled: Boolean }, emits: ["update:modelValue"], setup(props, { slots, emit }) { return () => h("label", [h("input", { type: "checkbox", checked: props.modelValue, disabled: props.disabled, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).checked) }), slots.default?.() ?? props.label]); } });

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

function mountDialog(options: { initialTab?: string } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const saved: Project[] = [];
  const app = createApp(ProjectSettingsDialog, {
    modelValue: true,
    projectId: "project-1",
    ...options,
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

/**
 * 页脚那颗按钮到底是「完成」还是「保存并关闭」。
 *
 * 这一段是**照着一个真实报障写的**：「项目设置里把执行侧 Agent 改成 Claude，确定后重开还是 codex，
 * 改过几次了」。查下来不是保存失败——是那个对话框的页脚只有一颗「完成」，而保存按钮在**滚动区底部**。
 * 改完直接点页脚那颗 = 关掉对话框，改动一个字都不落库，而且没有任何提示。
 * 于是「改了没生效」可以无限重演，每次都一模一样。
 */
describe("ProjectSettingsDialog 的页脚按钮", () => {
  const openModelsTab = async (initial = project()) => {
    vi.mocked(api.project).mockResolvedValue({ project: initial, summary: {} as never });
    const mounted = mountDialog();
    await nextTick();
    await nextTick();
    [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("模型与工具"))?.click();
    await nextTick();
    return mounted;
  };

  const executorAgent = (host: HTMLElement): HTMLSelectElement =>
    [...host.querySelectorAll("select")].find((select) => select.closest("label")?.textContent?.trim().startsWith("执行侧 Agent")) as HTMLSelectElement;

  const footerText = (host: HTMLElement): string => host.querySelector(".settings-dialog-footer")?.textContent ?? "";

  it("**没有改动时是「完成」，一有改动就变成「保存并关闭」**", async () => {
    const mounted = await openModelsTab();

    expect(footerText(mounted.host)).toContain("完成");
    expect(footerText(mounted.host)).not.toContain("保存并关闭");

    const select = executorAgent(mounted.host);
    select.value = "codex-app-server";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    await nextTick();

    expect(footerText(mounted.host)).toContain("保存并关闭");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("**点它先保存、成功才关** —— 这条就是那个报障的回归", async () => {
    const initial = project();
    vi.mocked(api.updateProject).mockResolvedValue({ project: { ...initial, configVersion: 4 } });
    const mounted = await openModelsTab(initial);

    const select = executorAgent(mounted.host);
    select.value = "codex-app-server";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    await nextTick();

    [...mounted.host.querySelectorAll<HTMLButtonElement>(".settings-dialog-footer button")]
      .find((button) => button.textContent?.includes("保存并关闭"))
      ?.click();
    await nextTick();
    await nextTick();

    // 保存真的发出去了，而且带上了新的 backend；然后才关。此前这里只有一次 `close()`。
    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
      settings: expect.objectContaining({
        models: expect.objectContaining({ executor: expect.objectContaining({ backend: "codex-app-server" }) }),
      }),
    }));
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
    mounted.host.remove();
  });
});

/**
 * 启动钩子：**Run 的 Worktree 初始化入口**。
 *
 * 「命令」页签登记 argv（那是安全不变量要求的——钩子只按命令 ID 引用，永远不接受模型给的
 * 字符串），「钩子」页签决定它在什么时刻以什么策略跑。建 CodeGraph 索引、装依赖、预热缓存
 * 都是这一条路，所以这里钉的是它作为入口必须可用的两件事：命令 ID 配得上，失败策略可配。
 *
 * 失败策略为什么必须可配：这两类初始化命令失败的后果完全不同。装依赖失败 → Agent 改出来的
 * 东西不可信，必须拦住 Run；建 CodeGraph 索引失败 → 只是少一张图，Run 照跑。一个开关才能
 * 同时表达这两件事，缺省保持"阻塞"（这个开关存在之前的行为），要放行得显式取消勾选。
 */
describe("启动钩子（Worktree 初始化入口）", () => {
  const openHooksTab = async (initial: Project) => {
    vi.mocked(api.project).mockResolvedValue({ project: initial, summary: {} as never });
    vi.mocked(api.updateProject).mockResolvedValue({ project: initial });
    const mounted = mountDialog();
    await nextTick();
    await nextTick();
    [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("钩子"))?.click();
    await nextTick();
    return mounted;
  };

  const blockingBox = (host: HTMLElement): HTMLInputElement => host.querySelector<HTMLInputElement>('.hook-blocking input[type="checkbox"]')!;
  const saveButton = (host: HTMLElement): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存项目配置"));
  /** 最近一次保存提交出去的 start 钩子；载荷形状断言全部走它。 */
  const savedStartHook = (): Record<string, unknown> | undefined => {
    const payload = vi.mocked(api.updateProject).mock.calls.at(-1)?.[1] as { settings?: { hooks?: { start?: Record<string, unknown> } } } | undefined;
    return payload?.settings?.hooks?.start;
  };

  it("命令 ID 是「命令」页签登记的那条，页面不提供第二个登记处", async () => {
    const initial = project();
    initial.settings.hooks = { start: { commandId: "project.codegraph-init" } };
    const mounted = await openHooksTab(initial);

    expect(mounted.host.textContent).toContain("Worktree 的初始化入口");
    expect(mounted.host.querySelector<HTMLInputElement>('input[placeholder="project.start"]')?.value).toBe("project.codegraph-init");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("**缺省勾着「失败时阻塞 Run」** —— 不碰这个开关的项目与它存在之前逐字一致", async () => {
    const initial = project();
    initial.settings.hooks = { start: { commandId: "project.start" } };
    const mounted = await openHooksTab(initial);

    expect(blockingBox(mounted.host).checked).toBe(true);

    saveButton(mounted.host)?.click();
    await nextTick();
    await nextTick();

    expect(savedStartHook()).toMatchObject({ commandId: "project.start", blocking: true });

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("取消勾选后保存，`blocking: false` 真的进了载荷 —— 建索引失败不该拦住 Run", async () => {
    const initial = project();
    initial.settings.hooks = { start: { commandId: "project.codegraph-init" } };
    const mounted = await openHooksTab(initial);

    const box = blockingBox(mounted.host);
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();

    saveButton(mounted.host)?.click();
    await nextTick();
    await nextTick();

    expect(savedStartHook()).toMatchObject({ commandId: "project.codegraph-init", blocking: false });

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("载入时读得回来：库里存着 `blocking: false`，重开这一页就是没勾上的", async () => {
    const initial = project();
    initial.settings.hooks = { start: { commandId: "project.codegraph-init", blocking: false } };
    const mounted = await openHooksTab(initial);

    expect(blockingBox(mounted.host).checked).toBe(false);

    mounted.app.unmount();
    mounted.host.remove();
  });
});

/**
 * `initialTab` 只为一条路存在：旧 `/projects/:id/settings?tab=` 地址重定向到 Explorer 时，
 * 把用户原本要看的页签带过来（见 router.ts 与 ExplorerView 的 consumeSettingsQuery）。
 * 它必须**只在这条路上**改变行为——从左侧项目列表打开设置是没带页签的，那时保持上次停留的
 * 那一页才是对的。
 */
describe("项目设置对话框的页签入口", () => {
  const sectionTitle = (host: HTMLElement) => host.querySelector(".settings-section h2")?.textContent ?? "";
  const activeTab = (host: HTMLElement) => host.querySelector(".settings-tabs button.active")?.textContent?.trim() ?? "";

  const mountAt = async (initialTab?: string) => {
    vi.mocked(api.project).mockResolvedValue({ project: project(), summary: {} as never });
    const mounted = mountDialog(initialTab === undefined ? {} : { initialTab });
    await nextTick();
    await nextTick();
    return mounted;
  };

  it("给了页签就落在那一页（旧 `?tab=hooks` 的那条路）", async () => {
    const mounted = await mountAt("hooks");

    expect(activeTab(mounted.host)).toContain("钩子");
    expect(sectionTitle(mounted.host)).toBe("生命周期钩子");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("**取了一个不认的页签时不乱跳** —— 否则会落到末尾那个 v-else 分支，显示「模型与工具」而导航上一个按钮都不高亮", async () => {
    const mounted = await mountAt("nope");

    expect(activeTab(mounted.host)).toContain("常规");
    expect(sectionTitle(mounted.host)).toBe("项目标识");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("不给页签时是常规页（从项目列表打开设置走的就是这条）", async () => {
    const mounted = await mountAt();

    expect(activeTab(mounted.host)).toContain("常规");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
