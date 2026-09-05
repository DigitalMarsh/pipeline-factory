/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerThread, Plan } from "../types";

export type PlanProjection = {
  thread: ExplorerThread;
  candidate: Plan | null;
  dispatched: Plan[];
};

function planIdentity(plan: Plan): string {
  return plan.planId ?? plan.id ?? plan.title;
}

/** 规范化候选和生命周期 Plan，保证只有 DRAFT 能作为 Candidate 显示。 */
export function normalizePlanProjection(thread: ExplorerThread, candidate: Plan | null, dispatched: Plan[]): PlanProjection {
  const draftCandidate = candidate?.status === "DRAFT" ? candidate : null;
  const candidateId = draftCandidate ? planIdentity(draftCandidate) : null;
  return {
    thread,
    candidate: draftCandidate,
    dispatched: dispatched.filter((plan) => planIdentity(plan) !== candidateId),
  };
}
