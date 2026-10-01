// @vitest-environment jsdom
/**
 * 测试职责：验证 Plan 详情里两个"Factory-owned、由人来设"的编辑器 —— 前置 Plan 与验证子集 ——
 *   在候选态可改、在只读/非候选态只展示，并且**勾选项只来自传入的词表**。
 * 设计说明：这里挂真实组件（不是读源码），因为这两块的交互（勾选 → 保存 → 抛事件）才是要保的东西。
 * 维护提示：新增这类"人来设的调度字段"时，照抄这里的三个场景：可选、不脏时禁用、保存抛出选择结果。
 */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import PlanDetailContent from "./PlanDetailContent.vue";
import type { Plan } from "../types";

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => { mounted.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); }); });

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean, size: String, type: String },
  emits: ["click"],
  setup(props, { slots, emit }) {
    return () => h("button", { type: "button", disabled: props.disabled, onClick: (event: Event) => emit("click", event) }, slots.default?.());
  },
});

function candidatePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1", planId: "plan-1", title: "Candidate", revision: 1, status: "DRAFT", projectId: "project-1",
    sourceExplorerThreadId: "explorer-1", queuedAt: null, dispatchedAt: null, runId: null, lastEventAt: "2026-10-01T00:00:00.000Z", attentionReason: null,
    contract: { goal: "goal", acceptanceCriteria: ["ok"], include: ["docs/guide.md"], exclude: [], baseBranch: "main", baseCommit: "abc", tasks: [], conflictKeys: [], executorModelRole: "executor", toolPolicy: "executor-scoped-write", verificationCommandIds: ["project.test", "docs.validate"], maxRepairAttempts: 1, mergeStrategy: "manual", requireHumanMerge: true, dependsOnPlanIds: [] },
    generatedSpec: {
      schemaVersion: 2, title: "Candidate", artifact: { mode: "REPOSITORY_FILE", path: "docs/guide.md" },
      objective: { goal: "goal", audience: ["devs"], acceptanceCriteria: ["ok"], outOfScope: [] },
      design: { technicalConstraints: ["markdown"], dataSecurity: ["none"], failureHandling: ["keep"] },
      scope: { includePaths: ["docs/guide.md"], excludePaths: [] },
      tasks: [{ id: "docs", title: "Update guide", dependencies: [] }],
      dependencies: [], conflicts: [], execution: {}, verification: { mode: "PROJECT_DEFAULT", suites: ["docs"] }, merge: { strategy: "manual", requireHumanMerge: true },
    },
    resolvedContract: {
      schemaVersion: 2, artifact: { mode: "REPOSITORY_FILE", path: "docs/guide.md" },
      objective: { goal: "goal", audience: ["devs"], acceptanceCriteria: ["ok"], outOfScope: [] },
      design: { technicalConstraints: ["markdown"], dataSecurity: ["none"], failureHandling: ["keep"] },
      conflicts: [], repository: { projectId: "project-1", name: "P", repoRoot: "/repo", baseBranch: "main", baseCommit: "abc", configVersion: 1, configHash: "h" },
      scope: { includePaths: ["docs/guide.md"], excludePaths: [] },
      tasks: [{ id: "docs", title: "Update guide", dependencies: [], status: "READY" }],
      dependencies: [], execution: { executorModelRole: "executor", toolPolicy: "executor-scoped-write", maxRepairAttempts: 1 },
      verification: { mode: "PROJECT_DEFAULT", commandIds: ["docs.validate"] }, merge: { strategy: "manual", requireHumanMerge: true },
    },
    ...overrides,
  } as Plan;
}

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const emitted: { dependencies: string[][]; suites: string[][] } = { dependencies: [], suites: [] };
  const app = createApp(PlanDetailContent, {
    plan: candidatePlan(),
    ...props,
    onUpdateDependencies: (ids: string[]) => emitted.dependencies.push(ids),
    onUpdateVerificationSuites: (suites: string[]) => emitted.suites.push(suites),
  });
  app.component("el-button", ElButtonStub);
  app.mount(host);
  mounted.push({ app, host });
  return { host, emitted };
}

describe("PlanDetailContent scheduling editors", () => {
  it("lets a candidate pick verification tags from the Project vocabulary only", async () => {
    const { host, emitted } = mount({ canEditVerificationSuites: true, verificationSuiteOptions: ["docs", "unit"] });

    const options = [...host.querySelectorAll<HTMLElement>(".dependency-option")];
    expect(options.map((option) => option.textContent?.trim())).toEqual(["docs", "unit"]);
    // 当前值来自 generatedSpec.suites：docs 已勾、unit 未勾。
    const boxes = options.map((option) => option.querySelector<HTMLInputElement>("input[type=checkbox]")!);
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);

    // 没有改动时保存按钮是禁用的（避免把"没变"也写一遍）。
    const save = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存验证子集"));
    expect(save()?.disabled).toBe(true);

    const unitBox = boxes[1]!;
    unitBox.checked = true;
    unitBox.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(save()?.disabled).toBe(false);
    save()?.click();
    expect(emitted.suites).toEqual([["docs", "unit"]]);
  });

  it("says so when the Project has no verification tags registered", () => {
    const { host } = mount({ canEditVerificationSuites: true, verificationSuiteOptions: [] });
    // 空词表不是错误：如实说明"要先在 Project 命令里加 tags"，而不是给一个空的下拉。
    expect(host.textContent).toContain("还没有登记任何验证 tag");
    expect(host.querySelectorAll(".dependency-option")).toHaveLength(0);
  });

  it("shows the requested tags read-only once the candidate is no longer editable", () => {
    const { host } = mount({ canEditVerificationSuites: false, verificationSuiteOptions: ["docs", "unit"] });
    expect(host.textContent).toContain("Verification subset");
    expect(host.textContent).toContain("docs");
    // 只读态没有复选框、也没有保存按钮。
    expect(host.querySelectorAll(".dependency-option")).toHaveLength(0);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("保存验证子集"))).toBe(false);
  });

  it("keeps the prerequisite plan editor working alongside it", async () => {
    const { host, emitted } = mount({ canEditDependencies: true, dependencyOptions: [{ id: "plan-0", title: "Upstream" }] });
    const box = host.querySelector<HTMLInputElement>(".dependency-option input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存前置 Plan"))?.click();
    expect(emitted.dependencies).toEqual([["plan-0"]]);
  });
});
