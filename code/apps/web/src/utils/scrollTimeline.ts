export type TimelineScrollContainer = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

export function scrollTimelineToLatest(timeline: TimelineScrollContainer): void {
  timeline.scrollTop = timeline.scrollHeight;
}

export function isTimelineAtLatest(timeline: TimelineScrollContainer, threshold = 24): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= threshold;
}
