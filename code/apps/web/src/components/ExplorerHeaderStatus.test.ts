// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import type { AgentLoop, ExplorerThread } from "../types";
import ExplorerHeaderStatus from "./ExplorerHeaderStatus.vue";

const requirements = [
  { key: "objective", label: "目标与用户范围", requiredFields: ["title"], optionalFields: [] },
  { key: "scope", label: "功能范围与排除项", requiredFields: ["scope.includePaths"], optionalFields: [] },
  { key: "execution", label: "执行与人工合并", requiredFields: ["merge.strategy"], optionalFields: [] },
];
const progress: ExplorerThread["exploration"] = {
  status: "READY",
  missing: [],
  completed: requirements.map((requirement) => requirement.label),
  diagnostics: [],
  candidatePlanId: "plan-1",
  lastAssessedTurnId: "turn-1",
};
const loop: AgentLoop = {
  id: "loop-1",
  ownerType: "explorer-turn",
  ownerId: "turn-1",
  role: "explorer",
  mode: "provider-controlled",
  state: "RUNNING",
  stepCount: 1,
  maxSteps: 40,
  startedAt: "2026-09-16T00:00:00.000Z",
  completedAt: null,
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  checkpointJson: null,
  diagnostics: { providerActivityCount: 2, lastGate: null, terminal: null },
};

const ElPopoverStub = defineComponent({
  props: { visible: Boolean },
  emits: ["update:visible"],
  setup(props, { emit, slots }) {
    return () => h("div", { class: "popover-stub", onClick: (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest(".explorer-header-status-trigger")) emit("update:visible", !props.visible);
    } }, [slots.reference?.(), props.visible ? slots.default?.() : null]);
  },
});
const ElButtonStub = defineComponent({
  setup(_, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button" }, slots.default?.());
  },
});

function mountStatus(initialDiagnostics: ExplorerThread["exploration"]["diagnostics"] = []) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const threadId = ref("thread-1");
  let pauseCount = 0;
  const app = createApp(defineComponent({
    setup() {
      return () => h(ExplorerHeaderStatus, {
        requirements,
        completed: progress.completed,
        diagnostics: initialDiagnostics,
        progress: { ...progress, diagnostics: initialDiagnostics },
        agentLoop: loop,
        agentLoopLabel: "Running",
        agentLoopGateLabel: null,
        agentLoopTerminalLabel: null,
        agentLoopCompletionLabel: null,
        threadId: threadId.value,
        paused: false,
        onTogglePause: () => { pauseCount += 1; },
      });
    },
  }));
  app.component("el-popover", ElPopoverStub);
  app.component("el-button", ElButtonStub);
  app.mount(host);
  return { app, host, threadId, get pauseCount() { return pauseCount; } };
}

function statusTrigger(host: HTMLElement, card: "requirements" | "provider-loop" | "exploration"): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-status-card="${card}"]`)!;
}

describe("ExplorerHeaderStatus", () => {
  it("shows three compact cards and keeps details closed initially", () => {
    const mounted = mountStatus();
    const trigger = statusTrigger(mounted.host, "requirements");

    expect(mounted.host.querySelectorAll(".explorer-header-status-card")).toHaveLength(3);
    expect(mounted.host.textContent).toContain("3/3 项已满足");
    expect(mounted.host.textContent).toContain("Running");
    expect(mounted.host.textContent).toContain("Plan ready");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.querySelector(".explorer-header-status-details")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("marks diagnostics without automatically opening the floating details", () => {
    const mounted = mountStatus([{ path: "scope.includePaths", code: "REQUIRED", area: "功能范围与排除项", message: "必须指定范围" }]);
    const trigger = statusTrigger(mounted.host, "requirements");

    expect(mounted.host.querySelector(".explorer-header-status-card.invalid")).not.toBeNull();
    expect(mounted.host.textContent).toContain("问题 1");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens and closes the details with keyboard activation", async () => {
    const mounted = mountStatus();
    const trigger = statusTrigger(mounted.host, "requirements");

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await nextTick();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows only the requirements content for the requirements card", async () => {
    const mounted = mountStatus();
    statusTrigger(mounted.host, "requirements").click();
    await nextTick();

    expect(mounted.host.textContent).toContain("PLAN REQUIREMENTS");
    expect(mounted.host.textContent).toContain("必填：title");
    expect(mounted.host.textContent).not.toContain("Provider Turns");
    expect(mounted.host.textContent).not.toContain("完整设计方案已生成");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows only the provider loop content, forwards pause, and closes when the thread changes", async () => {
    const mounted = mountStatus();
    const trigger = statusTrigger(mounted.host, "provider-loop");

    trigger.click();
    await nextTick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("Provider Turns 1 / 40");
    expect(mounted.host.textContent).not.toContain("必填：title");
    expect(mounted.host.textContent).not.toContain("完整设计方案已生成");

    mounted.host.querySelector<HTMLElement>(".agent-loop-action")!.click();
    expect(mounted.pauseCount).toBe(1);

    mounted.threadId.value = "thread-2";
    await nextTick();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows only the exploration content and switches between cards", async () => {
    const mounted = mountStatus();
    const requirementsTrigger = statusTrigger(mounted.host, "requirements");
    const providerLoopTrigger = statusTrigger(mounted.host, "provider-loop");
    const explorationTrigger = statusTrigger(mounted.host, "exploration");

    requirementsTrigger.click();
    await nextTick();
    expect(requirementsTrigger.getAttribute("aria-expanded")).toBe("true");

    providerLoopTrigger.click();
    await nextTick();
    expect(requirementsTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(providerLoopTrigger.getAttribute("aria-expanded")).toBe("true");

    explorationTrigger.click();
    await nextTick();
    expect(providerLoopTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(explorationTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("完整设计方案已生成");
    expect(mounted.host.textContent).not.toContain("必填：title");
    expect(mounted.host.textContent).not.toContain("Provider Turns");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
