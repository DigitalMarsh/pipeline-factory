// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { AgentLoop, AgentLoopStep, ExecutionTask, Run } from "../types";
import type { ExecutionStreamItem } from "../utils/executionStream";
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
  startedAt: "2026-09-19T00:02:00.000Z",
  completedAt: "2026-09-19T00:03:00.000Z",
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
    return () =>
      h(
        "div",
        {
          class: "popover-stub",
          onClick: (event: MouseEvent) => {
            if ((event.target as HTMLElement).closest(".execution-header-status-trigger")) emit("update:visible", !props.visible);
          },
        },
        [slots.reference?.(), props.visible ? slots.default?.() : null],
      );
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

function mountStatus(
  status = run.status,
  runActivity: ExecutionStreamItem[] = [],
  runtimeFacts: ExecutionStreamItem[] = [],
  executorSteps: AgentLoopStep[] = [],
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(ExecutionHeaderStatus, {
            run: { ...run, status },
            threadState: "ACTIVE",
            telemetry: null,
            telemetryNow: Date.now(),
            tasks: [task],
            taskCounts: { completed: 1, total: 1, blocked: 0, active: 0 },
            runActivity,
            runtimeFacts,
            selectedTaskId: null,
            executorLoop: loop,
            executorSteps,
            loopStatusLabel: "Completed",
            verification: null,
            mergeRequest: null,
            actionBusy: false,
            sourceCommit: "abc123",
            targetCommit: "def456",
            onFocusTask: (value: unknown) => emitted.push({ event: "focus-task", payload: value }),
            onOpenPlan: () => emitted.push({ event: "open-plan" }),
          });
      },
    }),
  );
  app.component("el-popover", ElPopoverStub);
  app.component("el-button", ElButtonStub);
  app.component("el-tag", ElTagStub);
  app.component(
    "el-input",
    defineComponent({
      props: { modelValue: String, size: String },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("input", {
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  );
  app.mount(host);
  return { app, host, emitted };
}

function trigger(host: HTMLElement, card: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-status-card="${card}"]`)!;
}

function runActivityItem(overrides: Partial<ExecutionStreamItem> = {}): ExecutionStreamItem {
  return {
    id: "execution-activity-1",
    kind: "activity",
    role: "system",
    title: "Run created",
    content: "",
    detail: "Plan plan-1 · Revision 2",
    status: "INFO",
    occurredAt: "2026-10-01T02:55:40.000Z",
    sequence: 1,
    messageType: "RUN_ACTIVITY",
    ...overrides,
  };
}

describe("ExecutionHeaderStatus", () => {
  it("renders six compact status cards and starts closed", () => {
    const mounted = mountStatus();

    expect(mounted.host.querySelectorAll(".execution-header-status-card")).toHaveLength(6);
    expect(mounted.host.textContent).toContain("第 2 版");
    expect(mounted.host.textContent).toContain("当前状态无需操作");
    expect(trigger(mounted.host, "review").getAttribute("aria-expanded")).toBe("false");
    expect(mounted.host.querySelector("#execution-header-review-details")).toBeNull();

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("列出 Run 级活动：只在 RUN CONTEXT 弹层里，且没有时不渲染这一节", async () => {
    const mounted = mountStatus("MERGED", [
      runActivityItem(),
      runActivityItem({ id: "execution-activity-2", title: "Hook skipped", detail: "start", sequence: 2 }),
    ]);

    // 弹层没打开时这一节不该占位置——它此前是执行会话里一个常显的分组。
    expect(mounted.host.textContent).not.toContain("Run 级活动");

    trigger(mounted.host, "context").click();
    await nextTick();
    expect(mounted.host.textContent).toContain("Run 级活动");
    expect(mounted.host.textContent).toContain("属于整个 Run，不归属于任何单个执行步骤");
    expect(mounted.host.querySelectorAll(".run-activity-item")).toHaveLength(2);
    expect(mounted.host.textContent).toContain("Run created");
    expect(mounted.host.textContent).toContain("Hook skipped");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("没有 Run 级活动时连空状态都不渲染", async () => {
    const mounted = mountStatus();

    trigger(mounted.host, "context").click();
    await nextTick();
    expect(mounted.host.querySelectorAll(".run-activity-item")).toHaveLength(0);
    expect(mounted.host.textContent).not.toContain("Run 级活动");

    mounted.app.unmount();
    mounted.host.remove();
  });

  it("有 Run 级活动失败时卡片本身变红，而不是只藏在弹层里", async () => {
    const mounted = mountStatus("MERGED", [runActivityItem({ title: "Hook failed", status: "FAILED" })]);

    expect(trigger(mounted.host, "context").querySelector(".execution-header-status-card")?.className).toContain("blocked");
    expect(mounted.host.textContent).toContain("有 Run 级活动失败");

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
    expect(mounted.host.textContent).not.toContain("终止 Run");

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

    expect(mounted.host.textContent).toContain("待人工审阅");
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

  /**
   * 旧判据是"最后 4 条"，而 `PROVIDER_ACTIVITY` **成对出现**（started / completed 各一条），
   * 4 格里通常 3 格是它——等于 4 格只讲了一件事，而**真正的原因从来没被显示过**：
   * 只有 `#44 LOOP_SUSPENDED`，看不出是 `PROCESS_RESTARTED`。现在只留有结论的并顶出原因码。
   * 判据的细节在 utils/agentLoopSteps.test.ts。
   */
  it("Loop 面板列的是**结论**，不是「最后几条」：只剩结论那一格，且原因码看得见", async () => {
    const activity = (sequence: number, phase: string): AgentLoopStep => ({
      loopId: "agent-loop-1",
      sequence,
      stepType: "PROVIDER_ACTIVITY",
      status: "COMPLETED",
      callId: null,
      providerThreadId: null,
      providerTurnId: null,
      payload: { phase },
      occurredAt: "2026-10-01T02:56:00.000Z",
    });
    const mounted = mountStatus(
      "RECOVERING",
      [],
      [],
      [
        activity(41, "started"),
        activity(42, "completed"),
        activity(43, "started"),
        activity(44, "completed"),
        {
          loopId: "agent-loop-1",
          sequence: 45,
          stepType: "LOOP_SUSPENDED",
          status: "RUNNING",
          callId: null,
          providerThreadId: null,
          providerTurnId: null,
          payload: { reason: "PROCESS_RESTARTED" },
          occurredAt: "2026-10-05T14:28:38.533Z",
        },
      ],
    );

    trigger(mounted.host, "loop").click();
    await nextTick();

    const chips = [...mounted.host.querySelectorAll(".loop-step")].map((chip) => chip.textContent?.replace(/\s+/g, " ").trim());
    expect(chips).toEqual(["#45 循环挂起 · PROCESS_RESTARTED"]);
    // 原始枚举名留着当 title：排障时要按它去 grep 代码与日志。
    expect(mounted.host.querySelector(".loop-step")?.getAttribute("title")).toBe("LOOP_SUSPENDED");
    expect(mounted.host.querySelector(".loop-step")?.className).toContain("tone-attention");
    expect(mounted.host.textContent).not.toContain("PROVIDER_ACTIVITY");

    mounted.app.unmount();
    mounted.host.remove();
  });
});
