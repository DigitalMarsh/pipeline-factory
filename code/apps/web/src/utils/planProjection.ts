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
  const readyCandidate = candidate ?? dispatched.find((plan) => plan.status === "READY" && plan.queuedAt === null) ?? null;
  const candidateId = readyCandidate ? planIdentity(readyCandidate) : null;
  return {
    thread,
    candidate: readyCandidate,
    dispatched: dispatched.filter((plan) => planIdentity(plan) !== candidateId),
  };
}
