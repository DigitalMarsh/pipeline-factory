/**
 * 测试职责：验证 Explorer 聊天区 Task → Plan 树的归属、去重和定位目标。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerPlan, Plan } from "../types";
import { buildTaskTree, taskDisplayTitle, taskRuntimeLabel } from "./taskTree";

const task = (id: string, ordinal: number, title = `Plan ${ordinal} / 待探索`): ExplorerPlan => ({
  id,
  explorerThreadId: "explorer-1",
  projectId: "project-1",
  ordinal,
  title,
  titleSource: "AUTO",
  titleStatus: "PLACEHOLDER",
  messageCount: 0,
  latestUserMessageSummary: null,
  exploration: { status: "INCOMPLETE", missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null },
  candidatePlanId: null,
  lastAssessedTurnId: null,
  createdAt: `2026-09-17T10:0${ordinal}:00.000Z`,
  lastActivityAt: `2026-09-17T10:0${ordinal}:00.000Z`,
});

const plan = (id: string, explorerPlanId: string, sourceTurnId: string | null = null): Plan => ({
  id,
  explorerPlanId,
  title: "A generated plan",
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  sourceTurnId,
  createdAt: "2026-09-17T10:05:00.000Z",
  queuedAt: null,
  runId: null,
  lastEventAt: "2026-09-17T10:05:00.000Z",
  attentionReason: null,
});

const generatedActivity: ExplorerActivityItem = {
  id: "activity-plan-1",
  explorerId: "explorer-1",
  turnId: "turn-1",
  sequence: 1,
  kind: "ASSISTANT_MESSAGE",
  status: "COMPLETED",
  title: "Plan Explorer",
  summary: "方案已生成",
  details: { planProtocol: true, status: "READY", title: "A generated plan" },
  occurredAt: "2026-09-17T10:05:00.000Z",
  explorerPlanId: "task-1",
};

describe("task tree", () => {
  it("groups one current Plan beneath its owning Task and sorts Tasks by ordinal", () => {
    const items = buildTaskTree([task("task-2", 2), task("task-1", 1)], [plan("plan-1", "task-1", "turn-1")], [generatedActivity]);

    expect(items.map((item) => item.task.id)).toEqual(["task-1", "task-2"]);
    expect(items[0]!.plan?.id).toBe("plan-1");
    expect(items[0]!.planTarget).toBe("plan-generated-plan-1");
    expect(items[1]!.plan).toBeNull();
  });

  it("deduplicates lifecycle projections and never guesses an unassociated Plan", () => {
    const items = buildTaskTree([task("task-1", 1)], [plan("plan-1", "task-1"), plan("plan-1-copy", "task-1"), { ...plan("orphan", ""), id: "orphan" }], []);

    expect(items).toHaveLength(1);
    expect(items[0]!.plan?.explorerPlanId).toBe("task-1");
  });

  it("uses Task terminology only for placeholder display titles", () => {
    expect(taskDisplayTitle(task("task-1", 1))).toBe("Task 1 / 待探索");
    expect(taskDisplayTitle(task("task-2", 2, "Write onboarding plan"))).toBe("Write onboarding plan");
    expect(taskRuntimeLabel({ ...task("task-1", 1), runtimeStatus: "RUNNING" })).toBe("运行中");
  });
});
