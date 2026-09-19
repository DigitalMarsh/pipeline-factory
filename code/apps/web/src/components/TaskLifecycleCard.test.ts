// @vitest-environment jsdom
import { createApp, h, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { Plan } from "../types";
import TaskLifecycleCard from "./TaskLifecycleCard.vue";

const plan: Plan = {
  id: "plan-1",
  title: "A task title that must stay readable within two lines on a narrow card",
  revision: 1,
  status: "DISPATCHED",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  createdAt: "2026-09-19T01:00:00.000Z",
  confirmedAt: "2026-09-19T01:01:00.000Z",
  queuedAt: "2026-09-19T01:02:00.000Z",
  dispatchedAt: "2026-09-19T01:03:00.000Z",
  runId: "run-1",
  lastEventAt: "2026-09-19T01:03:00.000Z",
  attentionReason: null,
  executionThread: { id: "thread-123456789", runId: "run-1", state: "ACTIVE" },
};

describe("TaskLifecycleCard", () => {
  it("uses one shared structure, shows details and execution thread, and emits actions", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const selected: unknown[] = [];
    const details: unknown[] = [];
    const runs: unknown[] = [];
    const app = createApp({
      setup() {
        return () => h(TaskLifecycleCard, {
          plan,
          onSelect: (value: Plan) => selected.push(value),
          onViewDetails: (value: Plan) => details.push(value),
          onOpenRun: (value: Plan) => runs.push(value),
        }, {
          actions: () => h("button", { class: "injected-action", type: "button", onClick: (event: Event) => event.stopPropagation() }, "Confirm"),
        });
      },
    });
    app.mount(host);
    await nextTick();

    expect(host.querySelectorAll(".task-lifecycle-row")).toHaveLength(2);
    expect(host.querySelectorAll(".task-lifecycle-step")).toHaveLength(8);
    expect(host.querySelectorAll(".task-lifecycle-row-reverse")).toHaveLength(1);
    expect(host.querySelector(".task-lifecycle-card-icon")).toBeNull();
    expect(host.querySelector(".task-lifecycle-card-head")?.children).toHaveLength(1);
    expect(host.querySelector(".task-lifecycle-card-heading")).not.toBeNull();
    expect(host.querySelector(".task-lifecycle-card-title-row")).not.toBeNull();
    expect(host.querySelector(".task-lifecycle-card-version")?.textContent).toBe("V1");
    expect(host.textContent).not.toContain("plan-1");
    expect(host.querySelectorAll(".task-lifecycle-row-connector")).toHaveLength(6);
    expect(host.querySelectorAll(".task-lifecycle-row")[0]?.querySelectorAll(".task-lifecycle-row-connector")).toHaveLength(3);
    expect(host.querySelectorAll(".task-lifecycle-row")[1]?.querySelectorAll(".task-lifecycle-row-connector")).toHaveLength(3);
    expect(host.querySelectorAll(".task-lifecycle-row-turn")).toHaveLength(1);
    expect(host.querySelectorAll(".task-lifecycle-row-connector-arrow")).toHaveLength(6);
    expect(host.querySelectorAll(".task-lifecycle-row-turn-arrow")).toHaveLength(1);
    expect(host.querySelector(".task-lifecycle-exception")).toBeNull();
    expect(host.querySelector(".task-lifecycle-current-label")).toBeNull();
    expect(host.querySelector(".task-lifecycle-step-current")).not.toBeNull();
    expect(host.querySelector(".task-lifecycle-step-current .task-lifecycle-step-dot svg")).not.toBeNull();
    expect([...host.querySelectorAll(".task-lifecycle-step-label")].map((node) => node.textContent)).toEqual([
      "Candidate",
      "Confirmed",
      "Enqueued",
      "Dispatched",
      "Running",
      "Verifying",
      "Ready for review",
      "Completed",
    ]);
    expect([...host.querySelectorAll(".task-lifecycle-step")].every((step) => {
      const children = [...step.children].map((child) => child.className);
      return children[0] === "task-lifecycle-step-copy" && children[1] === "task-lifecycle-step-dot" && children[2] === "task-lifecycle-step-time";
    })).toBe(true);
    expect(host.querySelector(".task-lifecycle-card-title")?.textContent).toContain("A task title");
    expect(host.textContent).toContain("V1");
    expect(host.textContent).toContain("View plan");
    expect(host.textContent).not.toContain("View full plan");
    expect(host.textContent).toContain("View run");
    expect(host.textContent).toContain("—");
    const footer = host.querySelector(".task-lifecycle-card-footer");
    expect(footer).not.toBeNull();
    expect([...footer!.children].map((child) => child.className)).toEqual([
      "task-lifecycle-details",
      "task-lifecycle-footer-actions",
      "task-lifecycle-run",
    ]);
    expect(host.querySelector(".task-lifecycle-action-row")).toBeNull();
    expect(footer?.querySelector(".task-lifecycle-footer-actions .injected-action")).not.toBeNull();
    expect(host.querySelectorAll(".task-lifecycle-step-complete .task-lifecycle-step-dot svg")).toHaveLength(3);
    expect(host.querySelectorAll(".task-lifecycle-step-current .task-lifecycle-step-dot svg")).toHaveLength(1);
    expect(host.querySelectorAll(".task-lifecycle-step-pending .task-lifecycle-step-dot svg")).toHaveLength(0);

    host.querySelector<HTMLElement>(".injected-action")?.click();
    expect(selected).toEqual([]);
    host.querySelector<HTMLElement>(".task-lifecycle-details")?.click();
    host.querySelector<HTMLElement>(".task-lifecycle-run")?.click();
    host.querySelector<HTMLElement>(".task-lifecycle-card")?.click();
    expect(details).toEqual([plan]);
    expect(runs).toEqual([plan]);
    expect(selected).toEqual([plan]);

    app.unmount();
    host.remove();
  });

  it("uses checks for reached statuses and empty circles for pending statuses", async () => {
    const completePlan: Plan = {
      ...plan,
      status: "MERGED",
      lifecycle: [
        { status: "DRAFT", occurredAt: plan.createdAt ?? null, revision: 1, current: false },
        { status: "READY", occurredAt: plan.confirmedAt ?? null, revision: 1, current: false },
        { status: "ENQUEUED", occurredAt: plan.queuedAt ?? null, revision: 1, current: false },
        { status: "DISPATCHED", occurredAt: plan.dispatchedAt ?? null, revision: 1, current: false },
        { status: "IN_PROGRESS", occurredAt: "2026-09-19T01:04:00.000Z", revision: 1, current: false },
        { status: "VERIFYING", occurredAt: "2026-09-19T01:05:00.000Z", revision: 1, current: false },
        { status: "MERGE_READY", occurredAt: "2026-09-19T01:06:00.000Z", revision: 1, current: false },
        { status: "MERGED", occurredAt: "2026-09-19T01:07:00.000Z", revision: 1, current: true },
      ],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ setup: () => () => h(TaskLifecycleCard, { plan: completePlan }) });
    app.mount(host);
    await nextTick();

    const icons = [...host.querySelectorAll(".task-lifecycle-step-dot svg")].map((node) => node.innerHTML);
    expect(icons).toHaveLength(8);
    expect(new Set(icons)).toHaveLength(1);
    expect(host.querySelectorAll(".task-lifecycle-step-complete .task-lifecycle-step-dot svg")).toHaveLength(7);
    expect(host.querySelectorAll(".task-lifecycle-step-current .task-lifecycle-step-dot svg")).toHaveLength(1);
    expect(host.querySelector(".task-lifecycle-step-pending .task-lifecycle-step-dot svg")).toBeNull();

    app.unmount();
    host.remove();
  });

  it("appends an exception node without expanding the normal lifecycle layout", async () => {
    const blockedPlan: Plan = {
      ...plan,
      status: "BLOCKED",
      attentionReason: "Verification failed",
      runId: null,
      executionThread: null,
      lifecycle: [
        { status: "DRAFT", occurredAt: plan.createdAt ?? null, revision: 1, current: false },
        { status: "READY", occurredAt: plan.confirmedAt ?? null, revision: 1, current: false },
        { status: "ENQUEUED", occurredAt: plan.queuedAt ?? null, revision: 1, current: false },
        { status: "DISPATCHED", occurredAt: plan.dispatchedAt ?? null, revision: 1, current: false },
        { status: "BLOCKED", occurredAt: null, revision: 1, current: true, reason: "Verification failed" },
      ],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      setup() {
        return () => h(TaskLifecycleCard, { plan: blockedPlan });
      },
    });
    app.mount(host);
    await nextTick();

    const exception = host.querySelector<HTMLElement>(".task-lifecycle-exception");
    expect(host.querySelectorAll(".task-lifecycle-row")).toHaveLength(2);
    expect(host.querySelectorAll(".task-lifecycle-step")).toHaveLength(8);
    expect(host.querySelector(".task-lifecycle-card-icon")).toBeNull();
    expect(host.querySelector(".task-lifecycle-step-exception")).toBeNull();
    expect(exception?.querySelector(".task-lifecycle-exception-heading strong")?.textContent).toBe("Blocked");
    expect(exception?.querySelector(".task-lifecycle-exception-current")?.textContent).toBe("CURRENT");
    expect(exception?.querySelector(".task-lifecycle-exception-copy p")?.textContent).toBe("Verification failed");
    expect(host.querySelector<HTMLButtonElement>(".task-lifecycle-run-disabled")?.disabled).toBe(true);

    app.unmount();
    host.remove();
  });
});
