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

/** 规范化候选和已派发 Plan，保证当前候选不会同时出现在两个列表中。 */
export function normalizePlanProjection(thread: ExplorerThread, candidate: Plan | null, dispatched: Plan[]): PlanProjection {
  const readyCandidate = candidate ?? dispatched.find((plan) => plan.status === "READY" && plan.queuedAt === null) ?? null;
  const candidateId = readyCandidate ? planIdentity(readyCandidate) : null;
  return {
    thread,
    candidate: readyCandidate,
    dispatched: dispatched.filter((plan) => planIdentity(plan) !== candidateId),
  };
}
