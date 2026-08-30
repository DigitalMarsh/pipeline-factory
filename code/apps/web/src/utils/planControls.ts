import type { PlanStatus } from "../types";

export function canDiscardPlan(status: PlanStatus | null | undefined): boolean {
  return status === "DRAFT";
}
