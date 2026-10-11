/**
 * 测试职责：验证 planTimeline 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, Plan } from "../types";
import { planActivityBindings, planAnchorId, planAnchorKey, planForActivity, planIdentity, planIdentityOrNull } from "./planTimeline";

const activity = (
  turnId: string,
  title: string,
  occurredAt = "2026-08-29T10:00:00.000Z",
  providerItemId?: string,
): ExplorerActivityItem => ({
  id: `activity-${turnId}-${providerItemId ?? occurredAt}`,
  explorerId: "explorer-1",
  turnId,
  sequence: 1,
  kind: "ASSISTANT_MESSAGE",
  status: "COMPLETED",
  title: "Plan Explorer",
  summary: "方案已整理完成。",
  details: { planProtocol: true, status: "READY", title, ...(providerItemId ? { providerItemId } : {}) },
  occurredAt,
});

const plan = (id: string, sourceTurnId: string | null, createdAt = "2026-08-29T10:01:00.000Z"): Plan => ({
  id,
  title: "Personal information manager",
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  sourceTurnId,
  createdAt,
  queuedAt: null,
  runId: null,
  lastEventAt: createdAt,
  attentionReason: null,
});

describe("plan timeline bindings", () => {
  // 判据是 `planActivityBindings` 本身——`findPlanForActivity` / `getPlanTimelineTarget` 那两个
  // 只有测试在用的读取器已删，这里直接查绑定表，少绕一层。
  const boundTo = (planToBind: Plan, activities: ExplorerActivityItem[]) =>
    planActivityBindings([planToBind], activities).get(activities.at(-1)!.id) ?? null;

  it("binds a generated plan to its source assistant turn", () => {
    const generated = activity("turn-2", "Personal information manager", undefined, "item-plan-1");
    const candidate = { ...plan("plan-1", "turn-2"), providerItemId: "item-plan-1" };

    expect(boundTo(candidate, [generated])).toBe(candidate);
  });

  it("keeps plans without a source turn detached from assistant messages", () => {
    const generated = activity("turn-2", "Personal information manager");
    const legacy = plan("plan-1", null);

    expect(boundTo(legacy, [generated])).toBeNull();
  });

  it("binds one plan to the final matching provider item within a shared source turn", () => {
    const first = activity("turn-2", "Personal information manager", "2026-08-29T10:00:00.000Z", "item-draft");
    const final = activity("turn-2", "Personal information manager", "2026-08-29T10:01:00.000Z", "item-plan-1");
    const candidate = { ...plan("plan-1", "turn-2"), providerItemId: "item-plan-1" };
    const bindings = planActivityBindings([candidate], [first, final]);

    expect(bindings.size).toBe(1);
    expect(bindings.get(first.id)).toBeUndefined();
    expect(bindings.get(final.id)).toBe(candidate);
  });

  it("falls back to the final matching READY message when older plans lack provider item IDs", () => {
    const first = activity("turn-2", "Personal information manager", "2026-08-29T10:00:00.000Z");
    const final = activity("turn-2", "Personal information manager", "2026-08-29T10:01:00.000Z");
    const candidate = plan("plan-1", "turn-2");
    const bindings = planActivityBindings([candidate], [first, final]);

    expect(bindings.get(first.id)).toBeUndefined();
    expect(bindings.get(final.id)).toBe(candidate);
  });
});

describe("plan DOM 锚点", () => {
  it("聊天气泡里的卡片用 generated 前缀", () => {
    const bound = plan("plan-1", "turn-2");

    expect(planAnchorId(bound)).toBe("plan-generated-plan-1");
  });

  it("身份缺 planId 时退到 id", () => {
    // 老数据只有 id，没有 planId；锚点必须仍然稳定，否则刷新后定位会丢。
    const legacy = { ...plan("", "turn-2"), id: "plan-7" };

    expect(planAnchorId(legacy)).toBe("plan-generated-plan-7");
  });

  it("没有 Plan 时锚点为字符串，调用方不必再判空", () => {
    expect(planAnchorId(null)).toBe("");
    expect(planAnchorKey(null)).toBe("");
  });

  it("rail 条目的 key 与导航 key 同规则（点击后能对齐激活态）", () => {
    // 两边都从 `planAnchorKey` 生成；`planTimelineItems` 已删，这条规则现在只剩一个来源，
    // 断言直接锁住它，免得将来又出现第二处自己拼 key 的地方。
    expect(planAnchorKey(plan("plan-1", "turn-2"))).toBe("plan-plan-1");
    expect(planAnchorId(plan("plan-1", "turn-2"))).toBe("plan-generated-plan-1");
  });
});

describe("Activity 上的 Plan 卡片查找", () => {
  it("命中绑定的活动 id 就返回那张 Plan", () => {
    const bound = plan("plan-1", "turn-1");
    const bindings = planActivityBindings([bound], [activity("turn-1", bound.title, undefined, "item-plan-1")]);
    const [activityId] = [...bindings.keys()];

    expect(planForActivity({ id: activityId! }, bindings)).toBe(bound);
  });

  it("没绑定的活动一律返回 null，不抛错", () => {
    expect(planForActivity({ id: "activity-nope" }, new Map())).toBeNull();
  });
});

describe("Plan 身份的回退顺序（P8.3 行为锁定）", () => {
  const bare = (overrides: Partial<Plan>): Plan => ({ ...plan("plan-1", "turn-1"), ...overrides });

  it("planId 优先于 id", () => {
    expect(planIdentity(bare({ planId: "dispatched-1" }))).toBe("dispatched-1");
    expect(planIdentity(bare({}))).toBe("plan-1");
  });

  it("空串不算缺失——?? 只对 null/undefined 退化", () => {
    // 这条锁的是"空串会原样当身份用"，所以 planTimeline 的 key 可能是 `plan-`。
    // 不是因为这里对，而是因为它与 explorerRequirementRows 那份（退化到 ""）是
    // 两种真实语义，统一任何一侧都是行为变更。见方案 P8.3。
    expect(planIdentity(bare({ id: "" }))).toBe("");
  });

  it("planIdentityOrNull exposes missing identity instead of choosing a title", () => {
    const untyped = { ...plan("plan-1", "turn-1"), id: undefined, planId: undefined, title: "只有标题" } as unknown as Plan;
    expect(planIdentityOrNull(untyped)).toBeNull();
    expect(planIdentity(untyped)).toBe("只有标题");
  });
  it("id 整个缺失（运行时未类型化的数据）才退化到 title，绝不产出 undefined", () => {
    const untyped = { ...plan("plan-1", "turn-1"), id: undefined, planId: undefined, title: "只有标题" } as unknown as Plan;

    expect(planIdentity(untyped)).toBe("只有标题");
  });
});
