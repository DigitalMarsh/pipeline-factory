/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 * 状态文案**不在这里**——它统一来自 `./planStatus`。本文件此前自带一份私有 `statusLabel`，
 * 成员比共用那份少 `DISCARDED` / `STARTING`，导致同一个 `DISCARDED` 在 rail 上显示成
 * `DISCARDED`、在计划卡片上显示成 `Discarded`。新增状态请改 `planStatus.ts`。
 */
import type { ExplorerActivityItem, Plan } from "../types";
import { planStatusLabel } from "./planStatus";

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

/**
 * 聊天流里"计划卡片"的 DOM 锚点。**必须用 Plan 身份而不是消息起始点**：右侧 Plans 面板点一条
 * 计划，要定位到聊天中真正承载该计划的那张卡片，而不是引出它的那段讨论文字。
 * 与 `getPlanTimelineTarget` 的关系：那个函数**按绑定结果自己选** generated / created 两套前缀；
 * 这里的两个是**调用方已判定**的版本，用于明确知道"这条计划在流里有没有卡片"的场景。
 */
export function planAnchorId(plan: Plan | null): string {
  return plan ? `plan-generated-${planIdentity(plan)}` : "";
}

/** 左侧时间线导航项的 key，与 `planTimelineItems` 产出的 `key` 同规则。 */
export function planAnchorKey(plan: Plan | null): string {
  return plan ? `plan-${planIdentity(plan)}` : "";
}

/** 流里没有对应卡片、需要单独渲染一条计划条目的情况。 */
export function detachedPlanAnchorId(plan: Plan): string {
  return `plan-created-${planIdentity(plan)}`;
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
      detail: `${timeLabel(generationTime(plan))} · ${planStatusLabel(plan.status)} · Rev ${plan.revision}`,
      target: getPlanTimelineTarget(plan, activities, [...unique.values()], bindings),
    }));
}
