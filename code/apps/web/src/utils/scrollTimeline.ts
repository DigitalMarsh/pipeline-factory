export type TimelineScrollContainer = Pick<HTMLElement, "scrollHeight" | "scrollTop">;

export function scrollTimelineToLatest(timeline: TimelineScrollContainer): void {
  timeline.scrollTop = timeline.scrollHeight;
}
