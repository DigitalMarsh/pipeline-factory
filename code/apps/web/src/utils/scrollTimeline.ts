/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type TimelineScrollContainer = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

/** 将消息流滚到最新位置；调用方负责决定用户是否仍处于跟随模式。 */
export function scrollTimelineToLatest(timeline: TimelineScrollContainer): void {
  timeline.scrollTop = timeline.scrollHeight;
}

/** 用容差判断是否接近底部，避免增量消息造成滚动抖动。 */
export function isTimelineAtLatest(timeline: TimelineScrollContainer, threshold = 24): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= threshold;
}
