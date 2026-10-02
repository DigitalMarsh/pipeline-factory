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

/** 返回持久化身份；没有 `planId` / `id` 时返回 null，让调用方显式选择 fallback 语义。 */
export function planIdentityOrNull(plan: Plan): string | null {
  return plan.planId ?? plan.id ?? null;
}

/** 使用 Plan 的持久化 ID 作为跨活动、列表和聊天锚点的稳定身份。 */
export function planIdentity(plan: Plan): string {
  return planIdentityOrNull(plan) ?? plan.title;
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

/**
 * 某条 Activity 行上挂着哪张 Plan 卡片（P7-4 从 `ExplorerView.vue` 下沉）。
 * 绑定表由 `planActivityBindings` 产出，这里只做查找。
 */
export function planForActivity(item: Pick<ExplorerActivityItem, "id">, bindings: Map<string, Plan>): Plan | null {
  return bindings.get(item.id) ?? null;
}

/** 从统一绑定结果读取当前消息承载的 Plan，避免同一 turn 的多个文本片段重复渲染。 */
export function findPlanForActivity(activity: ExplorerActivityItem, plans: Plan[], activities: ExplorerActivityItem[] = [activity]): Plan | null {
  return planActivityBindings(plans, activities).get(activity.id) ?? null;
}

/**
 * 优先返回聊天中真实计划卡片的 DOM anchor，而不是讨论起始消息。
 *
 * **绑定不上时返回 `plan-created-…`，但那个 id 现在没有渲染方**：曾经它对应一条独立的
 * PLAN CREATED 卡片，而现代代码里"计划绑不到消息"是不可能的（标题与 sourceTurnId 出自同一次
 * 协议解析），那条卡片已删除——见 docs/消息类型及事件状态机流程图.md。这里的两个前缀保留，
 * 是因为它同时被 `planTimelineItems` 与 `taskTree` 使用，且两者目前都没有实际调用方；
 * 真要收，得连它们一起收，不要只改这一处。
 */
export function getPlanTimelineTarget(plan: Plan, activities: ExplorerActivityItem[], allPlans: Plan[] = [plan], bindings = planActivityBindings(allPlans, activities)): string {
  const isBound = [...bindings.values()].some((candidate) => planIdentity(candidate) === planIdentity(plan));
  return isBound ? `plan-generated-${planIdentity(plan)}` : `plan-created-${planIdentity(plan)}`;
}

/**
 * 聊天流里"计划卡片"的 DOM 锚点。**必须用 Plan 身份而不是消息起始点**：右侧 Plans 面板点一条
 * 计划，要定位到聊天中真正承载该计划的那张卡片，而不是引出它的那段讨论文字。
 */
export function planAnchorId(plan: Plan | null): string {
  return plan ? `plan-generated-${planIdentity(plan)}` : "";
}

/** 时间线导航项的 key。 */
export function planAnchorKey(plan: Plan | null): string {
  return plan ? `plan-${planIdentity(plan)}` : "";
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
