// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectExecutionThreadPanel from "./ProjectExecutionThreadPanel.vue";
import type { Project, ProjectExecutionMessage, ProjectExecutionThreadSnapshot } from "../types";

const { apiMocks } = vi.hoisted(() => ({
  apiMocks: {
    projectExecutionThread: vi.fn(),
    updateProjectExecutionPreferences: vi.fn(),
    submitProjectExecutionTurn: vi.fn(),
    cancelProjectExecutionTurn: vi.fn(),
    projectExecutionEventsUrl: vi.fn(() => "/events"),
  },
}));
vi.mock("../api", () => ({ api: apiMocks }));

class FakeEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close() {}
}

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => {
  mounted.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); });
  vi.clearAllMocks();
});

function makeSnapshot(projectId: string, messages: ProjectExecutionMessage[] = []): ProjectExecutionThreadSnapshot {
  return {
    thread: { id: `execution-${projectId}`, projectId, providerThreadId: null, modelOverride: null, reasoningEffortOverride: null, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" },
    messages,
    events: [],
    lastEventSequence: 0,
    defaultModel: "gpt-5.6-luna",
    defaultReasoningEffort: "low",
    modelOptions: ["gpt-5.6-luna", "gpt-5.6-sol"],
    reasoningEffortOptions: [{ value: null, label: "跟随项目默认" }, { value: "low", label: "low" }, { value: "high", label: "high" }],
  } as ProjectExecutionThreadSnapshot;
}

function makeProject(id: string): Project {
  return { id, name: id, repoRoot: `/repo/${id}`, status: "ACTIVE", settings: { models: { executor: { model: "gpt-5.6-luna", reasoningEffort: "low" } } } } as Project;
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

function mountPanel(props: { projectId: string; project: Project | null }) {
  vi.stubGlobal("EventSource", FakeEventSource);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ProjectExecutionThreadPanel, props) });
  app.component("el-button", defineComponent({
    props: { disabled: Boolean, loading: Boolean, type: String, circle: Boolean, size: String, text: Boolean },
    emits: ["click"],
    setup(componentProps, { attrs, emit, slots }) {
      return () => h("button", { ...attrs, disabled: componentProps.disabled, onClick: (event: Event) => emit("click", event) }, slots.default?.());
    },
  }));
  app.mount(host);
  mounted.push({ app, host });
  return { host, app };
}

describe("ProjectExecutionThreadPanel", () => {
  it("loads per-project history, saves model and reasoning choices, and sends a direct request", async () => {
    const user: ProjectExecutionMessage = { id: "user-1", threadId: "execution-project-1", turnId: "turn-1", clientTurnId: "client-1", role: "user", content: "direct request", status: "COMPLETED", error: null, createdAt: "2026-09-26T00:00:00.000Z", sequence: 1, loopId: null, model: null, reasoningEffort: null };
    const assistant: ProjectExecutionMessage = { ...user, id: "assistant-1", clientTurnId: null, role: "assistant", content: "done", status: "COMPLETED", sequence: 2, model: "gpt-5.6-sol", reasoningEffort: "high" };
    apiMocks.projectExecutionThread.mockImplementation(async (projectId: string) => ({ ...makeSnapshot(projectId), messages: projectId === "project-1" ? [user, assistant] : [] }));
    apiMocks.updateProjectExecutionPreferences.mockImplementation(async (_projectId: string, preferences: { model: string | null; reasoningEffort: string | null }) => ({ thread: { ...makeSnapshot("project-1").thread, modelOverride: preferences.model, reasoningEffortOverride: preferences.reasoningEffort } }));
    apiMocks.submitProjectExecutionTurn.mockResolvedValue({ thread: makeSnapshot("project-1").thread, user, assistant });
    const props = reactive({ projectId: "project-1", project: makeProject("project-1") as Project | null });
    const mountedPanel = mountPanel(props);

    await waitUntil(() => mountedPanel.host.textContent?.includes("direct request") === true);
    expect(mountedPanel.host.textContent).toContain("done");
    const selects = mountedPanel.host.querySelectorAll<HTMLSelectElement>(".project-execution-select select");
    expect(selects).toHaveLength(2);
    selects[0]!.value = "gpt-5.6-sol";
    selects[0]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitUntil(() => apiMocks.updateProjectExecutionPreferences.mock.calls.length === 1);
    expect(apiMocks.updateProjectExecutionPreferences).toHaveBeenLastCalledWith("project-1", { model: "gpt-5.6-sol", reasoningEffort: null });
    selects[1]!.value = "high";
    selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    await waitUntil(() => apiMocks.updateProjectExecutionPreferences.mock.calls.length === 2);
    expect(apiMocks.updateProjectExecutionPreferences).toHaveBeenLastCalledWith("project-1", { model: "gpt-5.6-sol", reasoningEffort: "high" });

    const composer = mountedPanel.host.querySelector<HTMLTextAreaElement>("textarea[aria-label='项目执行请求']")!;
    composer.value = "please update the project";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    mountedPanel.host.querySelector<HTMLButtonElement>("button.project-execution-send")?.click();
    await waitUntil(() => apiMocks.submitProjectExecutionTurn.mock.calls.length === 1);
    expect(apiMocks.submitProjectExecutionTurn).toHaveBeenCalledWith("project-1", "please update the project", expect.stringContaining("project-execution-"));
  });

  it("clears the previous project's messages immediately when the selected Project changes", async () => {
    apiMocks.projectExecutionThread.mockImplementation(async (projectId: string) => ({ ...makeSnapshot(projectId), messages: projectId === "project-1" ? [{ id: "private-old-message", threadId: "execution-project-1", turnId: "turn-old", clientTurnId: "old", role: "user", content: "only project one", status: "COMPLETED", error: null, createdAt: "2026-09-26T00:00:00.000Z", sequence: 1, loopId: null, model: null, reasoningEffort: null }] : [] }));
    const props = reactive({ projectId: "project-1", project: makeProject("project-1") as Project | null });
    const mountedPanel = mountPanel(props);
    await waitUntil(() => mountedPanel.host.textContent?.includes("only project one") === true);

    props.projectId = "project-2";
    props.project = makeProject("project-2");
    await nextTick();
    expect(mountedPanel.host.textContent).not.toContain("only project one");
    await waitUntil(() => apiMocks.projectExecutionThread.mock.calls.some(([projectId]) => projectId === "project-2"));
    await waitUntil(() => mountedPanel.host.textContent?.includes("直接从项目任务开始") === true);
  });
});
