// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import PlanCenterPanel from "./PlanCenterPanel.vue";
import { api } from "../api";
import type { Plan, Project } from "../types";

vi.mock("../api", () => ({
  api: {
    plans: vi.fn(),
    startPlanRun: vi.fn(),
    cancelRun: vi.fn(),
    revisePlanConfiguration: vi.fn(),
  },
}));

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});
const ElSelectStub = defineComponent({ setup(_, { slots }) { return () => h("div", slots.default?.()); } });
const ElOptionStub = defineComponent({ setup(_, { slots }) { return () => h("div", slots.default?.()); } });
const ElTagStub = defineComponent({ setup(_, { slots }) { return () => h("span", slots.default?.()); } });
const RouterLinkStub = defineComponent({ setup(_, { slots }) { return () => h("a", slots.default?.()); } });

function project(): Project {
  return {
    id: "project-1", name: "Project 1", shortName: "P1", repoRoot: "/tmp/project-1", defaultBranch: "main", worktreeRoot: "/tmp/project-1-worktrees", status: "ACTIVE", currentExplorerThreadId: "explorer-1", configVersion: 1, configHash: "hash-1",
    settings: { concurrency: { maxParallelRuns: 2, defaultTimeoutMs: 120000, executionTimeoutMs: 1800000, maxAutoContinuationTurns: 0, maxRepairAttempts: 2 }, commands: [], hooks: {}, models: { explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna" } }, toolPolicy: { allowedMcpTools: [], allowedPluginTools: [], computerUseEnabled: false } },
    createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", archivedAt: null,
  };
}

function plan(): Plan {
  return { id: "plan-1", title: "Viewable plan", revision: 2, status: "DISPATCHED", projectId: "project-1", sourceExplorerThreadId: "explorer-1", queuedAt: "2026-09-05T00:00:00.000Z", dispatchedAt: "2026-09-05T00:01:00.000Z", runId: null, lastEventAt: "2026-09-05T00:01:00.000Z", attentionReason: null };
}

function mountPanel() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const viewed: Plan[] = [];
  const app = createApp(PlanCenterPanel, { projectId: "project-1", project: project(), onViewPlan: (value: Plan) => viewed.push(value) });
  app.component("ElButton", ElButtonStub);
  app.component("ElSelect", ElSelectStub);
  app.component("ElOption", ElOptionStub);
  app.component("ElTag", ElTagStub);
  app.component("RouterLink", RouterLinkStub);
  app.directive("loading", {});
  app.mount(host);
  return { app, host, viewed };
}

describe("PlanCenterPanel", () => {
  it("emits the selected plan when View full plan is clicked", async () => {
    const expected = plan();
    vi.mocked(api.plans).mockResolvedValue({ items: [expected], nextCursor: null });
    const mounted = mountPanel();
    await nextTick();
    await nextTick();

    const viewButton = [...mounted.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("View full plan"));
    viewButton?.click();

    expect(mounted.viewed).toEqual([expected]);
    mounted.app.unmount();
    mounted.host.remove();
  });
});
