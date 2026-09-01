/**
 * 模块职责：把 Explorer 活动和结构化输入请求投影成单一、稳定的消息时间线。
 *
 * 结构化输入本身就是对话事件：它在 createdAt 产生，答案在 answeredAt 完成。
 * 因此不能在模板里把待处理项固定放到顶部、已回答项统一追加到末尾。
 */
import type { ExplorerActivityItem, ExplorerInputRequest } from "../types";

export type ExplorerTimelineItem =
  | { key: string; kind: "activity"; activity: ExplorerActivityItem; occurredAt: string }
  | { key: string; kind: "input"; request: ExplorerInputRequest; occurredAt: string };

const inputLifecycleKinds = new Set<ExplorerActivityItem["kind"]>(["INPUT_REQUIRED", "INPUT_RESOLVED"]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/**
 * 用 input request 取代同一事件的低信息量生命周期行，避免问题和回答在流中重复出现。
 * 同一时间点保持输入数组/活动数组的原始顺序，保证渲染不会抖动。
 */
export function buildExplorerTimeline(activities: ExplorerActivityItem[], inputRequests: ExplorerInputRequest[]): ExplorerTimelineItem[] {
  const items: Array<ExplorerTimelineItem & { index: number }> = [];
  const hasInputRequest = inputRequests.length > 0;

  activities.forEach((activity, index) => {
    if (hasInputRequest && inputLifecycleKinds.has(activity.kind)) return;
    items.push({ key: `activity:${activity.id}`, kind: "activity", activity, occurredAt: activity.occurredAt, index });
  });

  inputRequests.forEach((request, index) => {
    items.push({ key: `input:${request.id}`, kind: "input", request, occurredAt: request.createdAt, index: activities.length + index });
  });

  return items
    .sort((left, right) => timestamp(left.occurredAt) - timestamp(right.occurredAt) || left.index - right.index)
    .map(({ index: _index, ...item }) => item);
}
