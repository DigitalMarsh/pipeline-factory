import type { ExplorerThread, Plan } from "../types";

export type PlanProjection = {
  thread: ExplorerThread;
  candidate: Plan | null;
  dispatched: Plan[];
};

function planIdentity(plan: Plan): string {
  return plan.planId ?? plan.id ?? plan.title;
}

export function normalizePlanProjection(thread: ExplorerThread, candidate: Plan | null, dispatched: Plan[]): PlanProjection {
  const candidateId = candidate ? planIdentity(candidate) : null;
  return {
    thread,
    candidate,
    dispatched: dispatched.filter((plan) => planIdentity(plan) !== candidateId),
  };
}
