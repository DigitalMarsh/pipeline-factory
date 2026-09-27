/**
 * 测试职责：验证 planControls 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { canDiscardPlan, isCandidatePlan } from "./planControls";
import type { Plan } from "../types";

describe("plan controls", () => {
  it("allows discard only for draft plans", () => {
    expect(canDiscardPlan("DRAFT")).toBe(true);
    expect(canDiscardPlan("DISCARDED")).toBe(false);
    expect(canDiscardPlan("READY")).toBe(false);
    expect(canDiscardPlan(null)).toBe(false);
  });
});

const plan = (id: string, overrides: Partial<Plan> = {}): Plan => ({ id, title: id, revision: 1, status: "DRAFT", projectId: "project-1", sourceExplorerThreadId: "explorer-1", queuedAt: null, runId: null, lastEventAt: "2026-08-29T10:00:00.000Z", attentionReason: null, ...overrides });

describe("候选判定", () => {
  it("用身份比较，刷新后对象引用变了也仍然认出候选", () => {
    const candidate = plan("plan-1");
    const refreshed = plan("plan-1");

    expect(refreshed).not.toBe(candidate);
    expect(isCandidatePlan(refreshed, candidate)).toBe(true);
  });

  it("候选态用 id、派发态用 planId 时仍然对得上", () => {
    expect(isCandidatePlan(plan("plan-1"), plan("plan-1", { planId: "plan-1" }))).toBe(true);
  });

  it("没有候选或没有卡片时一律 false", () => {
    expect(isCandidatePlan(plan("plan-1"), null)).toBe(false);
    expect(isCandidatePlan(null, plan("plan-1"))).toBe(false);
    expect(isCandidatePlan(null, null)).toBe(false);
    expect(isCandidatePlan(plan("plan-2"), plan("plan-1"))).toBe(false);
  });
});
