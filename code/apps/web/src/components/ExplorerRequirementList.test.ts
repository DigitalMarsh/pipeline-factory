// @vitest-environment jsdom
/**
 * 测试职责：需求清单的**行内动作**——重命名与删除都只是"发一个事件"，真正的事在 ExplorerView 里。
 *
 * 这里钉住的是"按钮在不在、发的是哪一条"：删除是不可恢复的动作，按钮必须逐行可辨（aria-label 带标题）、
 * 只能发自己那一行的 id。至于"能不能删"，判据在服务端，不在这个组件里——所以这里也不测。
 */
import { createApp, defineComponent, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ExplorerRequirementList from "./ExplorerRequirementList.vue";
import type { ExplorerRequirementRow } from "../utils/explorerRequirementRows";
import type { ExplorerPlan } from "../types";

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, type: { type: String, default: "button" } },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});
const ElTagStub = defineComponent({
  setup(_props, { slots }) {
    return () => h("span", { class: "el-tag" }, slots.default?.());
  },
});

function explorerPlan(id: string, ordinal: number, title: string): ExplorerPlan {
  return {
    id,
    explorerThreadId: "explorer-1",
    projectId: "project-1",
    ordinal,
    title,
    titleSource: "AUTO",
    titleStatus: "GENERATED",
    messageCount: 0,
    latestUserMessageSummary: null,
    exploration: { status: "READY", missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null },
    candidatePlanId: null,
    lastAssessedTurnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  };
}

function row(plan: ExplorerPlan): ExplorerRequirementRow {
  return {
    explorerPlan: plan,
    title: plan.title,
    plan: null,
    run: null,
    planStatus: { label: "草稿", tone: "neutral" },
    taskStatus: { label: "—", tone: "neutral" },
  };
}

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function mountList(rows: ExplorerRequirementRow[], disabled = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const removed: string[] = [];
  const renamed: string[] = [];
  createApp(ExplorerRequirementList, {
    rows,
    activeExplorerPlanId: rows[0]?.explorerPlan.id ?? null,
    disabled,
    onRemove: (id: string) => removed.push(id),
    onRename: (id: string) => renamed.push(id),
  })
    .component("ElButton", ElButtonStub)
    .component("ElTag", ElTagStub)
    .mount(host);
  return { host, removed, renamed };
}

describe("需求清单的行内删除", () => {
  const rows = [
    row(explorerPlan("explorer-plan-1", 1, "补一节目录结构")),
    row(explorerPlan("explorer-plan-2", 2, "加上甘特图")),
    row(explorerPlan("explorer-plan-3", 3, "修一下归属校验")),
  ];

  it("每一行都有删除按钮，且按标题可辨", () => {
    const { host } = mountList(rows);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-requirement-action="delete"]')];
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "删除补一节目录结构",
      "删除加上甘特图",
      "删除修一下归属校验",
    ]);
  });

  it("点第几行就只发那一条的 id —— 删除不可恢复，发错行等于删错东西", () => {
    const { host, removed } = mountList(rows);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-requirement-action="delete"]')];
    buttons[1]!.click();
    expect(removed).toEqual(["explorer-plan-2"]);
  });

  it("重命名按钮照旧只发自己那一行（两个按钮在同一格，别串了）", () => {
    const { host, renamed, removed } = mountList(rows);
    const renames = [...host.querySelectorAll<HTMLButtonElement>(".requirement-rename-button")];
    renames[2]!.click();
    expect(renamed).toEqual(["explorer-plan-3"]);
    expect(removed).toEqual([]);
  });

  it("线程归档时两颗按钮一起禁用", () => {
    const { host } = mountList(rows, true);
    for (const button of host.querySelectorAll<HTMLButtonElement>(".requirement-delete-button, .requirement-rename-button"))
      expect(button.disabled).toBe(true);
  });
});
