/**
 * 测试职责：验证 planProjection 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { normalizePlanProjection, planFromRevisionDraft } from "./planProjection";
import type { ExplorerThread, Plan, PlanRevisionDraft } from "../types";

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
  exploration: { status: "READY", missing: [], completed: [], diagnostics: [], candidatePlanId: "plan-1", lastAssessedTurnId: "turn-1" },
};

const plan = (id: string, status: Plan["status"]): Plan => ({
  id,
  title: id,
  revision: 1,
  status,
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  queuedAt: status === "ENQUEUED" ? "2026-08-29T10:01:00.000Z" : null,
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

const draft = (overrides: Partial<PlanRevisionDraft> = {}): PlanRevisionDraft => ({
  draftId: "draft-1",
  planId: "plan-9",
  projectId: "project-1",
  basedOnRevision: 2,
  targetRevision: 3,
  status: "EDITING",
  title: "Revised plan",
  sourceExplorerThreadId: "explorer-1",
  sourceTurnId: null,
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  providerItemId: null,
  baseBranch: "main",
  baseCommit: "abc1234",
  createdAt: "2026-08-29T10:04:00.000Z",
  updatedAt: "2026-08-29T10:05:00.000Z",
  confirmedAt: null,
  ...overrides,
});

describe("修订草稿投影成 Plan 卡片", () => {
  it("把草稿的目标 Revision 当作卡片 Revision，状态固定为 DRAFT", () => {
    const plan = planFromRevisionDraft(draft(), null);

    expect(plan.planId).toBe("plan-9");
    expect(plan.revision).toBe(3);
    expect(plan.status).toBe("DRAFT");
    expect(plan.runId).toBeNull();
  });

  it("草稿没带走属时挂到当前激活需求上", () => {
    expect(planFromRevisionDraft(draft(), "explorer-plan-5").explorerPlanId).toBe("explorer-plan-5");
  });

  it("草稿自己带的归属优先于回退值", () => {
    expect(planFromRevisionDraft(draft({ explorerPlanId: "explorer-plan-1" }), "explorer-plan-5").explorerPlanId).toBe("explorer-plan-1");
  });

  it("没有激活需求时草稿不归属任何需求", () => {
    expect(planFromRevisionDraft(draft(), null).explorerPlanId).toBeUndefined();
  });

  it("基底分支变化时给出 rebase 提示，其余状态不给", () => {
    expect(planFromRevisionDraft(draft({ status: "BASE_CHANGED" }), null).attentionReason).toContain("rebase");
    expect(planFromRevisionDraft(draft(), null).attentionReason).toBeNull();
  });
});
