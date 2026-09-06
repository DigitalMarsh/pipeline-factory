/**
 * 模块职责：把 Explorer 活动和结构化输入请求投影成单一、稳定的消息时间线。
 *
 * 结构化输入本身就是对话事件：它在 createdAt 产生，答案在 answeredAt 完成。
 * 因此不能在模板里把待处理项固定放到顶部、已回答项统一追加到末尾。
 */
import type { ExplorerActivityItem, ExplorerInputRequest, Plan } from "../types";

export type ExplorerTimelineItem =
  | { key: string; kind: "activity"; activity: ExplorerActivityItem; occurredAt: string }
  | { key: string; kind: "input"; request: ExplorerInputRequest; occurredAt: string }
  | { key: string; kind: "plan"; plan: Plan; occurredAt: string };

/** 左侧消息导航的最小投影：只保留时间、类型与定位信息。 */
export type ExplorerMessageTimelineItem = {
  key: string;
  activationKey: string;
  label: "消息" | "提问" | "回答";
  occurredAt: string;
  target: string;
};

const inputLifecycleKinds = new Set<ExplorerActivityItem["kind"]>(["INPUT_REQUIRED", "INPUT_RESOLVED"]);

export function explorerTimelineTarget(item: ExplorerActivityItem, index: number): string {
  if (item.kind === "USER_MESSAGE" || item.kind === "ASSISTANT_MESSAGE") {
    return `message-${item.id}`;
  }
  return `activity-${item.id}-${index}`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

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
    const planId = plan.planId ?? plan.id ?? plan.title;
    items.push({ key: `plan:${planId}`, kind: "plan", plan, occurredAt: plan.createdAt ?? plan.lastEventAt ?? plan.queuedAt ?? "", index: activities.length + inputRequests.length + index });
  });

  return items
    .sort((left, right) => timestamp(left.occurredAt) - timestamp(right.occurredAt) || left.index - right.index)
    .map(({ index: _index, ...item }) => item);
}

/**
 * 将结构化输入的提出与回答拆为独立导航时点；两者仍指向同一张输入卡片。
 * 常规用户与助手消息保持去身份化，统一投影为“消息”。
 */
export function buildExplorerMessageTimeline(activities: ExplorerActivityItem[], inputRequests: ExplorerInputRequest[]): ExplorerMessageTimelineItem[] {
  const entries: Array<ExplorerMessageTimelineItem & { order: number }> = [];

  buildExplorerTimeline(activities, inputRequests).forEach((item, index) => {
    if (item.kind === "activity") {
      if (item.activity.kind !== "USER_MESSAGE" && item.activity.kind !== "ASSISTANT_MESSAGE") return;
      const target = explorerTimelineTarget(item.activity, 0);
      entries.push({ key: `message:${item.activity.id}`, activationKey: target, label: "消息", occurredAt: item.activity.occurredAt, target, order: index * 2 });
      return;
    }

    if (item.kind === "plan") return;

    const target = `input-request-${item.request.id}`;
    const activationKey = `input:${item.request.id}`;
    entries.push({ key: `${activationKey}:question`, activationKey, label: "提问", occurredAt: item.request.createdAt, target, order: index * 2 });
    if (item.request.answeredAt && (item.request.status === "ANSWERED" || item.request.status === "AUTO_RESOLVED")) {
      entries.push({ key: `${activationKey}:answer`, activationKey, label: "回答", occurredAt: item.request.answeredAt, target, order: index * 2 + 1 });
    }
  });

  return entries
    .sort((left, right) => timestamp(left.occurredAt) - timestamp(right.occurredAt) || left.order - right.order)
    .map(({ order: _order, ...item }) => item);
}
