/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerActivityItem, Plan } from "../types";

export type PlanTimelineItem = {
  plan: Plan;
  key: string;
  label: string;
  detail: string;
  target: string;
};

/** 使用 planId@revision 作为跨活动、列表和聊天锚点的稳定身份。 */
export function planIdentity(plan: Plan): string {
  return plan.planId ?? plan.id ?? plan.title;
}

function readyPlanTitle(activity: ExplorerActivityItem): string | null {
  if (activity.kind !== "ASSISTANT_MESSAGE" || activity.details?.planProtocol !== true || activity.details.status !== "READY") return null;
  return typeof activity.details.title === "string" ? activity.details.title : null;
}

function generationTime(plan: Plan): string {
  return plan.createdAt ?? plan.lastEventAt ?? plan.queuedAt ?? "";
}

function statusLabel(status: string): string {
  return ({
    DRAFT: "Candidate",
    READY: "Confirmed",
    QUEUED: "Queued",
    IN_PROGRESS: "Running",
    VERIFYING: "Verifying",
    MERGE_READY: "Ready for review",
    MERGED: "Merged",
    NEEDS_PLAN_CHANGE: "Plan change required",
    BLOCKED: "Blocked",
  } as Record<string, string>)[status] ?? status;
}

function timeLabel(value: string): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** 从活动的 planId/turnId/providerItemId 中解析对应 Plan，支持旧数据降级。 */
export function findPlanForActivity(activity: ExplorerActivityItem, plans: Plan[]): Plan | null {
  const title = readyPlanTitle(activity);
  if (!title) return null;
  const direct = plans.find((plan) => plan.sourceTurnId === activity.turnId);
  if (direct) return direct;
  const legacyMatches = plans.filter((plan) => !plan.sourceTurnId && plan.title === title);
  return legacyMatches.length === 1 ? legacyMatches[0]! : null;
}

/** 优先返回聊天中真实计划卡片的 DOM anchor，而不是讨论起始消息。 */
export function getPlanTimelineTarget(plan: Plan, activities: ExplorerActivityItem[], allPlans: Plan[] = [plan]): string {
  const generatedPlanTarget = `plan-generated-${planIdentity(plan)}`;
  if (plan.sourceTurnId) return generatedPlanTarget;
  const matches = activities.filter((activity) => readyPlanTitle(activity) === plan.title);
  const matchingLegacyPlans = allPlans.filter((candidate) => !candidate.sourceTurnId && candidate.title === plan.title);
  return matches.length === 1 && matchingLegacyPlans.length === 1 ? generatedPlanTarget : `plan-created-${planIdentity(plan)}`;
}

export function planTimelineItems(plans: Plan[], activities: ExplorerActivityItem[]): PlanTimelineItem[] {
  const unique = new Map<string, Plan>();
  for (const plan of plans) unique.set(planIdentity(plan), plan);
  return [...unique.values()]
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => generationTime(a.plan).localeCompare(generationTime(b.plan)) || a.index - b.index)
    .map(({ plan }) => ({
      plan,
      key: `plan-${planIdentity(plan)}`,
      label: plan.title,
      detail: `${timeLabel(generationTime(plan))} · ${statusLabel(plan.status)} · Rev ${plan.revision}`,
      target: getPlanTimelineTarget(plan, activities, [...unique.values()]),
    }));
}
