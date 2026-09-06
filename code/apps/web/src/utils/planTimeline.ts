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

/** 使用 Plan 的持久化 ID 作为跨活动、列表和聊天锚点的稳定身份。 */
export function planIdentity(plan: Plan): string {
  return plan.planId ?? plan.id ?? plan.title;
}

function readyPlanTitle(activity: ExplorerActivityItem): string | null {
  if (activity.kind !== "ASSISTANT_MESSAGE" || activity.details?.planProtocol !== true || activity.details.status !== "READY") return null;
  return typeof activity.details.title === "string" ? activity.details.title : null;
}

function providerItemId(activity: ExplorerActivityItem): string | null {
  return typeof activity.details?.providerItemId === "string" ? activity.details.providerItemId : null;
}

function generationTime(plan: Plan): string {
  return plan.createdAt ?? plan.lastEventAt ?? plan.queuedAt ?? "";
}

function statusLabel(status: string): string {
  return ({
    DRAFT: "Candidate",
    READY: "Confirmed",
    ENQUEUED: "Enqueued",
    DISPATCHED: "Dispatched",
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

function planActivities(plan: Plan, activities: ExplorerActivityItem[]): ExplorerActivityItem[] {
  if (!plan.sourceTurnId) return [];
  return activities.filter((activity) => activity.turnId === plan.sourceTurnId && readyPlanTitle(activity) === plan.title);
}

/**
 * 每个 Plan 只绑定一条真正输出 READY 协议的 assistant 消息。
 * providerItemId 是首选事实；旧数据降级为同一 sourceTurnId 内最后一条同标题 READY 消息。
 */
export function planActivityBindings(plans: Plan[], activities: ExplorerActivityItem[]): Map<string, Plan> {
  const bindings = new Map<string, Plan>();
  const uniquePlans = new Map<string, Plan>();
  for (const plan of plans) uniquePlans.set(planIdentity(plan), plan);

  for (const plan of uniquePlans.values()) {
    const candidates = planActivities(plan, activities);
    const exact = plan.providerItemId ? candidates.find((activity) => providerItemId(activity) === plan.providerItemId) : undefined;
    const target = exact ?? candidates.at(-1);
    if (target && !bindings.has(target.id)) bindings.set(target.id, plan);
  }
  return bindings;
}

/** 从统一绑定结果读取当前消息承载的 Plan，避免同一 turn 的多个文本片段重复渲染。 */
export function findPlanForActivity(activity: ExplorerActivityItem, plans: Plan[], activities: ExplorerActivityItem[] = [activity]): Plan | null {
  return planActivityBindings(plans, activities).get(activity.id) ?? null;
}

/** 优先返回聊天中真实计划卡片的 DOM anchor，而不是讨论起始消息。 */
export function getPlanTimelineTarget(plan: Plan, activities: ExplorerActivityItem[], allPlans: Plan[] = [plan], bindings = planActivityBindings(allPlans, activities)): string {
  const isBound = [...bindings.values()].some((candidate) => planIdentity(candidate) === planIdentity(plan));
  return isBound ? `plan-generated-${planIdentity(plan)}` : `plan-created-${planIdentity(plan)}`;
}

export function planTimelineItems(plans: Plan[], activities: ExplorerActivityItem[], bindings = planActivityBindings(plans, activities)): PlanTimelineItem[] {
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
      target: getPlanTimelineTarget(plan, activities, [...unique.values()], bindings),
    }));
}
