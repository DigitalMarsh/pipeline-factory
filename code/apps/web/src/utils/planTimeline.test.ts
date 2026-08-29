import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, Plan } from "../types";
import { findPlanForActivity, getPlanTimelineTarget, planTimelineItems } from "./planTimeline";

const activity = (turnId: string, title: string, occurredAt = "2026-08-29T10:00:00.000Z"): ExplorerActivityItem => ({
  id: `activity-${turnId}`,
  explorerId: "explorer-1",
  turnId,
  sequence: 1,
  kind: "ASSISTANT_MESSAGE",
  status: "COMPLETED",
  title: "Plan Explorer",
  summary: "方案已整理完成。",
  details: { planProtocol: true, status: "READY", title },
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
    const generated = activity("turn-2", "Personal information manager");
    const candidate = plan("plan-1", "turn-2");

    expect(findPlanForActivity(generated, [candidate])).toBe(candidate);
    expect(getPlanTimelineTarget(candidate, [generated])).toBe("message-turn-2");
  });

  it("uses a unique title match for legacy plans without a source turn", () => {
    const generated = activity("turn-2", "Personal information manager");
    const legacy = plan("plan-1", null);

    expect(findPlanForActivity(generated, [legacy])).toBe(legacy);
    expect(getPlanTimelineTarget(legacy, [generated])).toBe("message-turn-2");
  });

  it("does not guess an anchor when legacy title matching is ambiguous", () => {
    const generated = activity("turn-2", "Personal information manager");
    const sameTitle = [plan("plan-1", null), plan("plan-2", null)];

    expect(findPlanForActivity(generated, sameTitle)).toBeNull();
    expect(getPlanTimelineTarget(sameTitle[0]!, [generated], sameTitle)).toBe("plan-created-plan-1");
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
