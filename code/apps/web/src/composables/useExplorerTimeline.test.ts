/**
 * 测试职责：锁住"需求范围内的时间线投影"——过滤、兜底、绑定与游离 Plan 的判定。
 *
 * 设计说明：composable 不用生命周期钩子，直接调用即可（无需组件、无需 jsdom）。
 * 依赖全部以 `ref` 注入，测试只改 ref 的 `.value` 就能驱动整条 computed 链。
 *
 * 维护提示：本文件测的是**范围过滤与回退规则**，不是排序——时间线的排序由
 * `utils/explorerTimeline` 的 `buildExplorerTimeline` 负责，那边有配对测试。
 */
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerInputRequest, ExplorerPlan, ExplorerTurn, Plan } from "../types";
import { useExplorerTimeline } from "./useExplorerTimeline";

const plan = (id: string, overrides: Partial<Plan> = {}): Plan => ({
  id,
  title: id,
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  queuedAt: null,
  runId: null,
  lastEventAt: "2026-09-01T10:00:00.000Z",
  attentionReason: null,
  ...overrides,
});

const turn = (id: string, overrides: Partial<ExplorerTurn> = {}): ExplorerTurn => ({
  id,
  threadId: "explorer-1",
  role: "user",
  content: `正文-${id}`,
  status: "COMPLETED",
  createdAt: "2026-09-01T10:00:00.000Z",
  sequence: 1,
  ...overrides,
});

const activity = (id: string, overrides: Partial<ExplorerActivityItem> = {}): ExplorerActivityItem => ({
  id,
  explorerId: "explorer-1",
  turnId: `turn-${id}`,
  sequence: 1,
  kind: "ASSISTANT_MESSAGE",
  status: "COMPLETED",
  title: "Plan Explorer",
  summary: "正文",
  details: null,
  occurredAt: "2026-09-01T10:00:00.000Z",
  ...overrides,
});

const explorerPlan = (id: string): ExplorerPlan => ({ id, title: id, ordinal: 1 }) as ExplorerPlan;

const inputRequest = (id: string, explorerPlanId?: string): ExplorerInputRequest =>
  ({
    id,
    threadId: "explorer-1",
    status: "OPEN",
    createdAt: "2026-09-01T10:02:00.000Z",
    explorerPlanId,
  }) as ExplorerInputRequest;

function setup() {
  const turns = ref<ExplorerTurn[]>([]);
  const activity = ref<ExplorerActivityItem[]>([]);
  const inputRequests = ref<ExplorerInputRequest[]>([]);
  const allPlans = ref<Plan[]>([]);
  const activeExplorerPlan = ref<ExplorerPlan | null>(null);

  const api = useExplorerTimeline({ turns, activity, inputRequests, allPlans, activeExplorerPlan });
  return { ...api, turns, activity, inputRequests, allPlans, activeExplorerPlan };
}

describe("需求范围过滤", () => {
  it("按激活需求过滤 Turn、Activity 与输入请求", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    s.turns.value = [turn("t1", { explorerPlanId: "ep-1" }), turn("t2", { explorerPlanId: "ep-2" })];
    s.activity.value = [activity("a1", { explorerPlanId: "ep-1" }), activity("a2", { explorerPlanId: "ep-2" })];
    s.inputRequests.value = [inputRequest("i1", "ep-1"), inputRequest("i2", "ep-2")];

    expect(s.visibleTurns.value.map((item) => item.id)).toEqual(["t1"]);
    expect(s.visibleActivity.value.map((item) => item.id)).toEqual(["a1"]);
    expect(s.visibleInputRequests.value.map((item) => item.id)).toEqual(["i1"]);
  });

  it("没有激活需求时不过滤——全部数据都算当前范围", () => {
    // 依据 utils/explorerScope 的 belongsToExplorerPlan：`!activePlanId` 一律返回 true，
    // 所以线程还没有需求时整条消息流照常展示。这条锁的是现状，不是"更严格更好"。
    const s = setup();
    s.turns.value = [turn("t1", { explorerPlanId: "ep-1" }), turn("orphan")];
    s.activity.value = [activity("a1", { explorerPlanId: "ep-1" }), activity("orphan")];

    expect(s.visibleTurns.value.map((item) => item.id)).toEqual(["t1", "orphan"]);
    expect(s.visibleActivity.value.map((item) => item.id)).toEqual(["a1", "orphan"]);
  });
});

describe("Activity 为空时的 Turn 兜底", () => {
  it("用 Turn 合成活动，id 带 fallback- 前缀以免与真实 id 碰撞", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    s.turns.value = [turn("t1", { explorerPlanId: "ep-1", role: "assistant", status: "RUNNING", content: "" })];

    const [合成] = s.visibleActivity.value;

    expect(合成?.id).toBe("fallback-t1");
    expect(合成?.kind).toBe("ASSISTANT_MESSAGE");
    expect(合成?.status).toBe("RUNNING");
    expect(合成?.summary).toBe("Plan Explorer 正在处理…");
  });

  it("用户消息取正文本身，助手消息走可读文本投影", () => {
    const s = setup();
    s.turns.value = [turn("u1", { role: "user", content: "你好" }), turn("a1", { role: "assistant", content: "在的" })];

    expect(s.visibleActivity.value.map((item) => item.summary)).toEqual(["你好", "在的"]);
  });

  it("失败的 Turn 把错误带进 details", () => {
    const s = setup();
    s.turns.value = [turn("t1", { role: "assistant", status: "FAILED", content: "", error: "boom" })];

    expect(s.visibleActivity.value[0]?.details).toEqual({ error: "boom" });
  });

  it("后端给了活动就用后端那份，不做兜底", () => {
    const s = setup();
    s.turns.value = [turn("t1")];
    s.activity.value = [activity("a1")];

    expect(s.visibleActivity.value.map((item) => item.id)).toEqual(["a1"]);
  });
});

describe("Plan 与活动的绑定", () => {
  it("活动上挂到 Plan 时进绑定表", () => {
    // 绑定规则（utils/planTimeline 的 planActivities）：Plan 要有 sourceTurnId，
    // 且该 turn 里要有一条 title 相同、status 为 READY 的 planProtocol 活动。
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    const bound = plan("plan-1", { explorerPlanId: "ep-1", sourceTurnId: "turn-a1" });
    s.allPlans.value = [bound];
    s.activity.value = [
      activity("a1", {
        explorerPlanId: "ep-1",
        turnId: "turn-a1",
        details: { planProtocol: true, status: "READY", title: bound.title },
      }),
    ];

    expect(s.planBindings.value.get("a1")?.id).toBe("plan-1");
    expect(s.timelineItems.value.map((item) => item.key)).toEqual(["activity:a1"]);
  });

  it("消息标题对不上 Plan 标题时不绑定", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    const bound = plan("plan-1", { explorerPlanId: "ep-1", sourceTurnId: "turn-a1" });
    s.allPlans.value = [bound];
    s.activity.value = [
      activity("a1", {
        explorerPlanId: "ep-1",
        turnId: "turn-a1",
        details: { planProtocol: true, status: "READY", title: "另一个标题" },
      }),
    ];

    expect(s.planBindings.value.size).toBe(0);
  });

  it("没有任何活动时，本需求的 Plan 不进绑定表", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    s.allPlans.value = [plan("plan-1", { explorerPlanId: "ep-1" })];

    expect(s.planBindings.value.size).toBe(0);
  });

  it("不属于激活需求的 Plan 不进绑定表", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    s.allPlans.value = [plan("plan-1", { explorerPlanId: "ep-2" })];

    expect(s.planBindings.value.size).toBe(0);
  });
});

describe("时间线条目", () => {
  it("方案不再作为时间线条目出现——方案卡挂在产出它的助手消息里", () => {
    const s = setup();
    s.activeExplorerPlan.value = explorerPlan("ep-1");
    s.allPlans.value = [plan("plan-1", { explorerPlanId: "ep-1", createdAt: "2026-09-01T10:01:00.000Z" })];
    s.activity.value = [activity("a1", { explorerPlanId: "ep-1", occurredAt: "2026-09-01T10:00:00.000Z" })];

    expect(s.timelineItems.value.map((item) => item.key)).toEqual(["activity:a1"]);
  });
});
