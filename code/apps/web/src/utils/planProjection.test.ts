/**
 * 测试职责：验证 planProjection 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { normalizePlanProjection } from "./planProjection";
import type { ExplorerThread, Plan } from "../types";

const explorer: ExplorerThread = {
  id: "explorer-1",
  projectId: "project-1",
  title: "New exploration",
  createdAt: "2026-08-29T05:45:15.000Z",
  titleSource: "AUTO",
  titleStatus: "PLACEHOLDER",
  contextMode: "FRESH",
  originThreadId: null,
  parentThreadId: null,
  state: "ACTIVE",
  messageCount: 2,
  summaryRef: null,
  lastActivityAt: "2026-08-29T10:00:00.000Z",
  exploration: { status: "READY", missing: [], completed: [], candidatePlanId: "plan-1", lastAssessedTurnId: "turn-1" },
};

const plan = (id: string, status: Plan["status"]): Plan => ({
  id,
  title: id,
  revision: 1,
  status,
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  queuedAt: status === "QUEUED" || status === "ENQUEUED" ? "2026-08-29T10:01:00.000Z" : null,
  runId: null,
  lastEventAt: "2026-08-29T10:00:00.000Z",
  attentionReason: null,
});

describe("plan projection", () => {
  it("keeps a DRAFT candidate visible and removes duplicate lifecycle entries", () => {
    const projection = normalizePlanProjection(explorer, plan("plan-1", "DRAFT"), [plan("plan-1", "ENQUEUED"), plan("plan-2", "MERGED")]);

    expect(projection.candidate?.id).toBe("plan-1");
    expect(projection.dispatched.map((item) => item.id)).toEqual(["plan-2"]);
  });

  it("does not promote READY plans back into Candidate after refresh", () => {
    const projection = normalizePlanProjection(explorer, null, [plan("plan-1", "READY"), plan("plan-2", "ENQUEUED")]);

    expect(projection.candidate).toBeNull();
    expect(projection.dispatched.map((item) => item.id)).toEqual(["plan-1", "plan-2"]);
  });
});
