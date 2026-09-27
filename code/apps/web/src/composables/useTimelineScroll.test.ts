// @vitest-environment jsdom
/**
 * 测试职责：锁住时间线的"是否已滚到底"与"当前激活键"两条判定。
 *
 * 设计说明：composable 不用生命周期钩子，所以可以脱离组件直接调用（放进 effectScope
 * 以保留 `ref`/`computed` 的作用域语义）。仓库没有 `@vue/test-utils`，这里用裸 DOM
 * fixture 喂 `timeline` ref。
 *
 * 维护提示：jsdom 的 `getBoundingClientRect` 恒返回全 0，所以"判定线以上"等价于
 * `nodeTop === scrollTop`——本文件测的是**遍历与取值规则**（谁最后胜出、key 怎么解析），
 * 不是像素几何。像素几何由样式与 `marker` 常量承担，改 `data-nav-key` 约定时
 * 必须同步改这里断言的字符串。
 */
import { effectScope, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import type { ExplorerActivityItem, Plan } from "../types";
import { useTimelineScroll } from "./useTimelineScroll";

const activity = (id: string, turnId = id): ExplorerActivityItem => ({
  id,
  explorerId: "explorer-1",
  turnId,
  sequence: 1,
  kind: "ASSISTANT_MESSAGE",
  status: "COMPLETED",
  title: "Plan Explorer",
  summary: "正文",
  details: null,
  occurredAt: "2026-09-01T10:00:00.000Z",
});

const plan = (id: string): Plan => ({
  id,
  title: id,
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  sourceTurnId: "turn-1",
  queuedAt: null,
  runId: null,
  lastEventAt: "2026-09-01T10:00:00.000Z",
  attentionReason: null,
});

/** jsdom 的 clientHeight / scrollHeight 是只读 0，用 defineProperty 打开可写。 */
function container(metrics: { clientHeight: number; scrollHeight: number; scrollTop: number }): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
  el.scrollTop = metrics.scrollTop;
  (el as HTMLElement & { scrollTo: () => void }).scrollTo = () => {};
  document.body.append(el);
  return el;
}

function navNode(parent: HTMLElement, navKey: string, id?: string): HTMLElement {
  const node = document.createElement("div");
  node.dataset.navKey = navKey;
  if (id) node.id = id;
  parent.append(node);
  return node;
}

function setup() {
  const visibleActivity = ref<ExplorerActivityItem[]>([]);
  const planBindings = ref<Map<string, Plan>>(new Map());
  const timeline = ref<HTMLElement | null>(null);
  const scope = effectScope();
  const api = scope.run(() => useTimelineScroll(timeline, { visibleActivity, planBindings }))!;
  return { ...api, timeline, visibleActivity, planBindings, scope };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("是否显示'滚到最新'按钮", () => {
  it("离底部超过容差时显示", () => {
    const { timeline, updateTimelineScrollState, showScrollToLatest } = setup();
    timeline.value = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });

    updateTimelineScrollState();

    expect(showScrollToLatest.value).toBe(true);
  });

  it("已经在底部时不显示", () => {
    const { timeline, updateTimelineScrollState, showScrollToLatest } = setup();
    timeline.value = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 900 });

    updateTimelineScrollState();

    expect(showScrollToLatest.value).toBe(false);
  });

  it("没有容器时一律不显示", () => {
    const { updateTimelineScrollState, showScrollToLatest } = setup();
    showScrollToLatest.value = true;

    updateTimelineScrollState();

    expect(showScrollToLatest.value).toBe(false);
  });
});

describe("跳回最新", () => {
  it("滚到底并收起按钮；没有容器时是空操作", () => {
    const { timeline, jumpToLatest, showScrollToLatest } = setup();
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    timeline.value = el;
    showScrollToLatest.value = true;

    jumpToLatest();

    expect(el.scrollTop).toBe(1000);
    expect(showScrollToLatest.value).toBe(false);
    jumpToLatest();
    expect(el.scrollTop).toBe(1000);
  });
});

describe("当前激活键", () => {
  it("取判定线以内最后一条导航项", () => {
    const { timeline, updateTimelineScrollState, activeTimelineKey } = setup();
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "message-turn-1");
    navNode(el, "message-turn-2");
    navNode(el, "message-turn-3");
    timeline.value = el;

    updateTimelineScrollState();

    expect(activeTimelineKey.value).toBe("message-turn-3");
  });

  it("一条导航项都没有时保留原值，不写空串", () => {
    const { timeline, updateTimelineScrollState, activeTimelineKey } = setup();
    timeline.value = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    activeTimelineKey.value = "message-turn-9";

    updateTimelineScrollState();

    expect(activeTimelineKey.value).toBe("message-turn-9");
  });

  it("激活到 plan- 键时直接把它当作激活 Plan", () => {
    const { timeline, updateTimelineScrollState, activeTimelineKey, activePlanKey } = setup();
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "message-turn-1");
    navNode(el, "plan-plan-7");
    timeline.value = el;

    updateTimelineScrollState();

    expect(activeTimelineKey.value).toBe("plan-plan-7");
    expect(activePlanKey.value).toBe("plan-plan-7");
  });

  it("激活到消息键时反查该活动上挂的 Plan 锚点", () => {
    const { timeline, visibleActivity, planBindings, updateTimelineScrollState, activePlanKey } = setup();
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    // 导航键的规则是 `message-${activity.id}`（utils/explorerTimeline 的 explorerTimelineTarget），
    // 不是 turn id —— 这里用 activity id 保持两边一致。
    navNode(el, "message-activity-1");
    timeline.value = el;
    visibleActivity.value = [activity("activity-1", "turn-1")];
    planBindings.value = new Map([["activity-1", plan("plan-7")]]);

    updateTimelineScrollState();

    expect(activePlanKey.value).toBe("plan-plan-7");
  });

  it("消息没挂 Plan 时激活 Plan 清空", () => {
    const { timeline, visibleActivity, updateTimelineScrollState, activePlanKey } = setup();
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "message-activity-1");
    timeline.value = el;
    visibleActivity.value = [activity("activity-1", "turn-1")];
    activePlanKey.value = "plan-stale";

    updateTimelineScrollState();

    expect(activePlanKey.value).toBe("");
  });
});

describe("跳到指定锚点", () => {
  it("目标自己是消息时以目标的导航键为准，忽略传入的 key", () => {
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "message-activity-1", "message-anchor");
    const { timeline, jumpToTimelineTarget, activeTimelineKey, activePlanKey } = setup();
    timeline.value = el;

    jumpToTimelineTarget("message-anchor", "input-input-2");

    expect(activeTimelineKey.value).toBe("message-activity-1");
    expect(activePlanKey.value).toBe("");
  });

  it("目标不是消息（输入卡片等）时用传入的 key", () => {
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "input:input-2", "input-anchor");
    const { timeline, jumpToTimelineTarget, activeTimelineKey, activePlanKey } = setup();
    timeline.value = el;

    jumpToTimelineTarget("input-anchor", "input-input-2");

    expect(activeTimelineKey.value).toBe("input-input-2");
    expect(activePlanKey.value).toBe("");
  });

  it("目标是 plan- 键时同步激活 Plan", () => {
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    navNode(el, "message-turn-1", "plan-anchor");
    const { timeline, jumpToTimelineTarget, activePlanKey } = setup();
    timeline.value = el;

    jumpToTimelineTarget("plan-anchor", "plan-plan-7");

    expect(activePlanKey.value).toBe("plan-plan-7");
  });

  it("找不到目标或没有容器时是空操作，不改激活态", () => {
    const el = container({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
    const { timeline, jumpToTimelineTarget, activeTimelineKey, activePlanKey } = setup();
    activeTimelineKey.value = "message-keep";
    activePlanKey.value = "plan-keep";

    jumpToTimelineTarget("nope", "plan-plan-7");
    expect(activeTimelineKey.value).toBe("message-keep");
    expect(activePlanKey.value).toBe("plan-keep");

    timeline.value = el;
    jumpToTimelineTarget("nope", "plan-plan-7");
    expect(activeTimelineKey.value).toBe("message-keep");
    expect(activePlanKey.value).toBe("plan-keep");
  });
});
