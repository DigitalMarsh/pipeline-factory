/**
 * 测试职责：验证 planTimeline 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, Plan } from "../types";
import { detachedPlanAnchorId, findPlanForActivity, getPlanTimelineTarget, planActivityBindings, planAnchorId, planAnchorKey, planTimelineItems } from "./planTimeline";

const activity = (turnId: string, title: string, occurredAt = "2026-08-29T10:00:00.000Z", providerItemId?: string): ExplorerActivityItem => ({
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
  it("binds a generated plan to its source assistant turn", () => {
    const generated = activity("turn-2", "Personal information manager", undefined, "item-plan-1");
    const candidate = { ...plan("plan-1", "turn-2"), providerItemId: "item-plan-1" };

    expect(findPlanForActivity(generated, [candidate])).toBe(candidate);
    expect(getPlanTimelineTarget(candidate, [generated])).toBe("plan-generated-plan-1");
  });

  it("keeps plans without a source turn detached from assistant messages", () => {
    const generated = activity("turn-2", "Personal information manager");
    const legacy = plan("plan-1", null);

    expect(findPlanForActivity(generated, [legacy])).toBeNull();
    expect(getPlanTimelineTarget(legacy, [generated])).toBe("plan-created-plan-1");
  });

  it("binds one plan to the final matching provider item within a shared source turn", () => {
    const first = activity("turn-2", "Personal information manager", "2026-08-29T10:00:00.000Z", "item-draft");
    const final = activity("turn-2", "Personal information manager", "2026-08-29T10:01:00.000Z", "item-plan-1");
    const candidate = { ...plan("plan-1", "turn-2"), providerItemId: "item-plan-1" };
    const bindings = planActivityBindings([candidate], [first, final]);

    expect(bindings.size).toBe(1);
    expect(findPlanForActivity(first, [candidate], [first, final])).toBeNull();
    expect(findPlanForActivity(final, [candidate], [first, final])).toBe(candidate);
    expect(getPlanTimelineTarget(candidate, [first, final])).toBe("plan-generated-plan-1");
  });

  it("falls back to the final matching READY message when older plans lack provider item IDs", () => {
    const first = activity("turn-2", "Personal information manager", "2026-08-29T10:00:00.000Z");
    const final = activity("turn-2", "Personal information manager", "2026-08-29T10:01:00.000Z");
    const candidate = plan("plan-1", "turn-2");

    expect(findPlanForActivity(first, [candidate], [first, final])).toBeNull();
    expect(findPlanForActivity(final, [candidate], [first, final])).toBe(candidate);
  });

  it("sorts Plans rail items by stable generation time while retaining status", () => {
    const first = plan("plan-1", "turn-1", "2026-08-29T10:01:00.000Z");
    const second = { ...plan("plan-2", "turn-2", "2026-08-29T10:02:00.000Z"), status: "QUEUED" as const };

    expect(planTimelineItems([second, first], []).map((item) => item.plan.id)).toEqual(["plan-1", "plan-2"]);
    const time = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    expect(planTimelineItems([second, first], [activity("turn-1", first.title)]).map((item) => item.detail)).toEqual([
      `${time(first.createdAt!)} · Candidate · Rev 1`,
      `${time(second.createdAt!)} · Queued · Rev 1`,
    ]);
  });
});

describe("rail 条目的状态文案", () => {
  /** 行为锁定：DISCARDED 必须在 rail 上与计划卡片显示同一句话，不能裸露枚举名。 */
  it("已丢弃的 Plan 显示 Discarded，而不是 DISCARDED", () => {
    const discarded = { ...plan("plan-3", "turn-3", "2026-08-29T10:03:00.000Z"), status: "DISCARDED" as const };
    const time = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

    expect(planTimelineItems([discarded], []).map((item) => item.detail)).toEqual([`${time(discarded.createdAt!)} · Discarded · Rev 1`]);
  });
});

describe("plan DOM 锚点", () => {
  it("有卡片与无卡片分别用 generated / created 前缀", () => {
    const bound = plan("plan-1", "turn-2");

    expect(planAnchorId(bound)).toBe("plan-generated-plan-1");
    expect(detachedPlanAnchorId(bound)).toBe("plan-created-plan-1");
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

  it("导航 key 与 rail 条目的 key 同规则（点击后能对齐激活态）", () => {
    const bound = plan("plan-1", "turn-2");
    const entries = planTimelineItems([bound], []);

    expect(entries[0]?.key).toBe(planAnchorKey(bound));
    expect(planAnchorKey(bound)).toBe("plan-plan-1");
  });
});
