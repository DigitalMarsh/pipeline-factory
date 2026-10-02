/**
 * 模块职责：把 Explorer 活动和结构化输入请求投影成单一、稳定的消息时间线。
 *
 * 结构化输入本身就是对话事件：它在 createdAt 产生，答案在 answeredAt 完成。
 * 因此不能在模板里把待处理项固定放到顶部、已回答项统一追加到末尾。
 */
import type { ExplorerActivityItem, ExplorerInputRequest, Plan } from "../types";
import { planIdentity } from "./planTimeline";
import type { ExplorerMessageType } from "./explorerPresentation";

export type ExplorerTimelineItem =
  | { key: string; kind: "activity"; activity: ExplorerActivityItem; occurredAt: string }
  | { key: string; kind: "input"; request: ExplorerInputRequest; occurredAt: string }
  | { key: string; kind: "plan"; plan: Plan; occurredAt: string };

/**
 * 时间线条目 → 消息类型。视图拿它去查 `EXPLORER_DISPLAY_MODES`
 * （见 `explorerPresentation.ts`），于是"这一类要不要显示"只由那张表决定。
 *
 * 只做类型翻译，不认识任何场景：条目是活动就原样交出它的 `kind`，
 * 是输入卡 / 游离 Plan 就翻成表里的那两个非活动类型。
 */
export function explorerTimelineMessageType(item: ExplorerTimelineItem): ExplorerMessageType {
  if (item.kind === "input") return "input-request";
  if (item.kind === "plan") return "plan-created";
  return item.activity.kind;
}

/** 消息与活动的 DOM 锚点：用**活动 id** 拼，同一回合里的多条助手活动因此各有各的锚点。 */
export function explorerTimelineTarget(item: ExplorerActivityItem, index: number): string {
  if (item.kind === "USER_MESSAGE" || item.kind === "ASSISTANT_MESSAGE") {
    return `message-${item.id}`;
  }
  return `activity-${item.id}-${index}`;
}

/** 输入卡片的 DOM 锚点。单点定义在这里，视图直接引它当 `id`。 */
export function inputRequestTarget(request: Pick<ExplorerInputRequest, "id">): string {
  return `input-request-${request.id}`;
}

/** Explorer Plan（需求）区块的 DOM 锚点。 */
export function explorerPlanAnchorId(explorerPlanId: string): string {
  return `explorer-plan-${explorerPlanId}`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

const inputLifecycleKinds = new Set<ExplorerActivityItem["kind"]>(["INPUT_REQUIRED", "INPUT_RESOLVED"]);

/**
 * 用 input request 取代同一事件的低信息量生命周期行，避免问题和回答在流中重复出现。
 * 同一时间点保持输入数组/活动数组的原始顺序，保证渲染不会抖动。
 */
export function buildExplorerTimeline(activities: ExplorerActivityItem[], inputRequests: ExplorerInputRequest[], detachedPlans: Plan[] = []): ExplorerTimelineItem[] {
  const items: Array<ExplorerTimelineItem & { index: number }> = [];
  const hasInputRequest = inputRequests.length > 0;

  activities.forEach((activity, index) => {
    if (hasInputRequest && inputLifecycleKinds.has(activity.kind)) return;
    items.push({ key: `activity:${activity.id}`, kind: "activity", activity, occurredAt: activity.occurredAt, index });
  });

  inputRequests.forEach((request, index) => {
    items.push({ key: `input:${request.id}`, kind: "input", request, occurredAt: request.createdAt, index: activities.length + index });
  });

  detachedPlans.forEach((plan, index) => {
    items.push({ key: `plan:${planIdentity(plan)}`, kind: "plan", plan, occurredAt: plan.createdAt ?? plan.lastEventAt ?? plan.queuedAt ?? "", index: activities.length + inputRequests.length + index });
  });

  return items
    .sort((left, right) => timestamp(left.occurredAt) - timestamp(right.occurredAt) || left.index - right.index)
    .map(({ index: _index, ...item }) => item);
}
