// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { AgentLoop, ExecutionTask, Run } from "../types";
import ExecutionHeaderStatus from "./ExecutionHeaderStatus.vue";

const run: Run = {
  id: "run-1",
  projectId: "project-1",
  planId: "plan-1",
  planRevision: 2,
  status: "MERGED",
  branch: "factory/add-doc",
  workspacePath: "/tmp/worktree",
  baseCommit: "abc123",
  executionThreadId: "thread-1",
  createdAt: "2026-09-19T00:00:00.000Z",
  startedAt: "2026-09-19T00:01:00.000Z",
};

const task: ExecutionTask = {
  id: "task-1",
  title: "Create document",
  status: "DONE",
  dependencies: [],
  evidenceSequence: 1,
  blockedReason: null,
};

const loop: AgentLoop = {
  id: "loop-1",
  ownerType: "run",
  ownerId: "run-1",
  role: "executor",
  mode: "factory-controlled",
  state: "COMPLETED",
  stepCount: 2,
  maxSteps: 40,
  startedAt: "2026-09-19T00:01:00.000Z",
  completedAt: "2026-09-19T00:02:00.000Z",
  providerThreadId: null,
  providerTurnId: null,
  checkpointJson: null,
};

const ElPopoverStub = defineComponent({
  props: { visible: Boolean },
  emits: ["update:visible"],
  setup(props, { emit, slots }) {
    return () => h("div", { class: "popover-stub", onClick: (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest(".execution-header-status-trigger")) emit("update:visible", !props.visible);
    } }, [slots.reference?.(), props.visible ? slots.default?.() : null]);
  },
});

const ElButtonStub = defineComponent({
  setup(_, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button" }, slots.default?.());
  },
});

const ElTagStub = defineComponent({
  setup(_, { slots }) {
    return () => h("span", { class: "tag-stub" }, slots.default?.());
  },
});

function mountStatus(status = run.status) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const app = createApp(defineComponent({
    setup() {
      return () => h(ExecutionHeaderStatus, {
        run: { ...run, status },
        threadState: "ACTIVE",
        telemetry: null,
        telemetryNow: Date.now(),
        tasks: [task],
        taskCounts: { completed: 1, total: 1, blocked: 0, active: 0 },
        selectedTaskId: null,
        executorLoop: loop,
        executorSteps: [],
        loopStatusLabel: "Completed",
        verification: null,
        mergeRequest: null,
        actionBusy: false,
        sourceCommit: "abc123",
        targetCommit: "def456",
        diagnosticsCount: { journal: 2, tools: 1, steps: 2 },
        onFocusTask: (value: unknown) => emitted.push({ event: "focus-task", payload: value }),
        onOpenPlan: () => emitted.push({ event: "open-plan" }),
        onOpenDiagnostics: () => emitted.push({ event: "open-diagnostics" }),
      });
    },
  }));
  app.component("el-popover", ElPopoverStub);
  app.component("el-button", ElButtonStub);
  app.component("el-tag", ElTagStub);
  app.component("el-input", defineComponent({ props: { modelValue: String, size: String }, emits: ["update:modelValue"], setup(props, { emit }) { return () => h("input", { value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }); } }));
  app.mount(host);
  return { app, host, emitted };
}

function trigger(host: HTMLElement, card: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-status-card="${card}"]`)!;
}

describe("ExecutionHeaderStatus", () => {
  it("renders six compact status cards and starts closed", () => {
    const mounted = mountStatus();

    expect(mounted.host.querySelectorAll(".execution-header-status-card")).toHaveLength(6);
    expect(mounted.host.textContent).toContain("Revision 2");
    expect(mounted.host.textContent).toContain("当前状态无需操作");
    expect(trigger(mounted.host, "review").getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.querySelector("#execution-header-review-details")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("opens details with keyboard activation and closes the previous card", async () => {
    const mounted = mountStatus();
    const context = trigger(mounted.host, "context");
    const telemetry = trigger(mounted.host, "telemetry");

    context.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(context.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("/tmp/worktree");

    telemetry.click();
    await nextTick();
    expect(context.getAttribute("aria-expanded")).toBe("false");
    expect(telemetry.getAttribute("aria-expanded")).toBe("true");
    expect(mounted.host.textContent).toContain("Provider 未返回精确 usage");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("shows the no-action Run Control state and forwards task focus", async () => {
    const mounted = mountStatus("MERGED");
    const controls = trigger(mounted.host, "controls");
    controls.click();
    await nextTick();
    expect(mounted.host.textContent).toContain("当前状态无需操作");
    expect(mounted.host.textContent).not.toContain("Terminate run");

    trigger(mounted.host, "progress").click();
    await nextTick();
    mounted.host.querySelector<HTMLButtonElement>(".execution-task")!.click();
    expect(mounted.emitted).toEqual([{ event: "focus-task", payload: task }]);

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("explains review status and keeps the execution branch in review details", async () => {
    const mounted = mountStatus("MERGE_READY");
    const review = trigger(mounted.host, "review");
    review.click();
    await nextTick();

    expect(mounted.host.textContent).toContain("Ready for review");
    expect(mounted.host.textContent).toContain("执行和验证已完成");
    expect(mounted.host.textContent).toContain("factory/add-doc");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("forwards the Plan detail entry from Run context", async () => {
    const mounted = mountStatus();
    trigger(mounted.host, "context").click();
    await nextTick();
    mounted.host.querySelector<HTMLButtonElement>(".execution-header-detail-footer button")!.click();

    expect(mounted.emitted).toContainEqual({ event: "open-plan" });

    mounted.app.unmount();
    mounted.host.remove();
  });
});
