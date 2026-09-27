/**
 * 模块职责：把 ExplorerPlan、Plan 和 Run 投影成 Explorer 页面中的需求行。
 * 维护提示：状态映射只读取现有服务端状态，不推断或推进后端生命周期。
 */
import type { ExplorerPlan, Plan, Run } from "../types";
import { planIdentityOrNull } from "./planTimeline";
import { taskDisplayTitle } from "./taskTree";

export type RequirementStatusTone = "neutral" | "progress" | "attention" | "success" | "danger";
export type RequirementStatus = { label: string; tone: RequirementStatusTone };

export type ExplorerRequirementRow = {
  explorerPlan: ExplorerPlan;
  title: string;
  plan: Plan | null;
  run: Run | null;
  planStatus: RequirementStatus;
  taskStatus: RequirementStatus;
};

const CONFIRMED_PLAN_STATUSES = new Set([
  "READY", "ENQUEUED", "DISPATCHED", "QUEUED", "IN_PROGRESS", "VERIFYING",
  "MERGE_READY", "MERGED", "BLOCKED", "NEEDS_PLAN_CHANGE",
]);

function planIdentity(plan: Plan): string {
  return planIdentityOrNull(plan) ?? "";
}

export function isConversationArtifactPlan(plan: Plan | null | undefined): boolean {
  return plan?.contract?.artifactMode === "CONVERSATION"
    || plan?.resolvedContract?.artifact?.mode === "CONVERSATION"
    || plan?.generatedSpec?.artifact?.mode === "CONVERSATION";
}

function planBelongsToRequirement(plan: Plan, requirement: ExplorerPlan): boolean {
  if (plan.explorerPlanId) return plan.explorerPlanId === requirement.id;
  const identity = planIdentity(plan);
  return Boolean(identity && (identity === requirement.candidatePlanId || identity === requirement.exploration.candidatePlanId));
}

function currentPlanFor(requirement: ExplorerPlan, plans: Plan[]): Plan | null {
  return plans
    .filter((plan) => planBelongsToRequirement(plan, requirement))
    .sort((left, right) => right.revision - left.revision || right.lastEventAt.localeCompare(left.lastEventAt))[0] ?? null;
}

function runFor(plan: Plan | null, runs: Run[]): Run | null {
  if (!plan) return null;
  const identity = planIdentity(plan);
  const linkedRunId = plan.runId ?? plan.dispatch?.runId ?? null;
  return runs
    .filter((run) => (linkedRunId && run.id === linkedRunId)
      || (run.planId === identity && run.planRevision === plan.revision))
    .sort((left, right) => (right.startedAt ?? right.createdAt).localeCompare(left.startedAt ?? left.createdAt))[0] ?? null;
}

function planStatusFor(requirement: ExplorerPlan, plan: Plan | null): RequirementStatus {
  const runtimeStatus = requirement.runtimeStatus;
  if (runtimeStatus === "WAITING_FOR_INPUT") return { label: "待回答问题", tone: "attention" };
  if (plan?.status === "DRAFT") return { label: "待确认", tone: "attention" };
  if (plan?.status === "DISCARDED") return { label: "已丢弃", tone: "neutral" };
  if (plan && CONFIRMED_PLAN_STATUSES.has(plan.status)) return { label: "已确认", tone: "success" };
  if (plan) return { label: `未知状态：${plan.status}`, tone: "neutral" };
  if (requirement.candidatePlanId || requirement.exploration.candidatePlanId || requirement.exploration.status === "READY") {
    return { label: "待确认", tone: "attention" };
  }
  if (runtimeStatus === "FAILED") return { label: "探索失败", tone: "danger" };
  if (runtimeStatus === "CANCELLED") return { label: "已取消", tone: "neutral" };
  if (runtimeStatus === "PAUSED") return { label: "已暂停", tone: "attention" };
  if (runtimeStatus === "QUEUED" || runtimeStatus === "RUNNING" || runtimeStatus === "COMPLETED" || !runtimeStatus) {
    return { label: "探索中", tone: "progress" };
  }
  return { label: `未知状态：${runtimeStatus}`, tone: "neutral" };
}

function taskStatusFor(plan: Plan | null, run: Run | null): RequirementStatus {
  if (!plan || plan.status === "DRAFT" || plan.status === "DISCARDED") return { label: "—", tone: "neutral" };
  if (run) {
    if (["STARTING", "QUEUED", "RUNNING", "IN_PROGRESS", "VERIFYING"].includes(run.status)) return { label: "运行中", tone: "progress" };
    if (["COMPLETED", "MERGED"].includes(run.status)) return { label: "运行完", tone: "success" };
    if (run.status === "MERGE_READY") return { label: "待处理", tone: "attention" };
    if (["FAILED", "CANCELLED", "BLOCKED"].includes(run.status)) return { label: "待处理", tone: "attention" };
    return { label: `未知状态：${run.status}`, tone: "neutral" };
  }
  if (isConversationArtifactPlan(plan)) return { label: "待处理", tone: "attention" };
  const dispatch = plan.dispatch;
  if (plan.status === "MERGED" || dispatch?.status === "COMPLETED") return { label: "运行完", tone: "success" };
  if (["MERGE_READY", "BLOCKED", "NEEDS_PLAN_CHANGE"].includes(plan.status)
    || dispatch?.status === "NEEDS_REVIEW" || dispatch?.status === "BLOCKED"
    || dispatch?.waitReason === "NEEDS_CONFIGURATION") return { label: "待处理", tone: "attention" };
  if (plan.status === "READY") return { label: "待入队", tone: "neutral" };
  if (["ENQUEUED", "DISPATCHED", "QUEUED"].includes(plan.status)
    || ["QUEUED", "WAITING", "DISPATCHING"].includes(dispatch?.status ?? "")) {
    return { label: "已入队/已派发", tone: "progress" };
  }
  if (["IN_PROGRESS", "VERIFYING"].includes(plan.status)
    || ["RUNNING", "VERIFYING"].includes(dispatch?.status ?? "")) return { label: "运行中", tone: "progress" };
  return { label: `未知状态：${plan.status}`, tone: "neutral" };
}

/** 每个 ExplorerPlan 保留一行，需求序号是稳定排序依据。 */
export function projectExplorerRequirementRows(
  explorerPlans: ExplorerPlan[],
  plans: Plan[],
  runs: Run[],
): ExplorerRequirementRow[] {
  return [...explorerPlans]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((explorerPlan) => {
      const plan = currentPlanFor(explorerPlan, plans);
      const run = runFor(plan, runs);
      return {
        explorerPlan,
        title: taskDisplayTitle(explorerPlan),
        plan,
        run,
        planStatus: planStatusFor(explorerPlan, plan),
        taskStatus: taskStatusFor(plan, run),
      };
    });
}
