import { describe, expect, it } from "vitest";
import { isTimelineAtLatest, scrollTimelineToLatest } from "./scrollTimeline";

describe("scrollTimelineToLatest", () => {
  it("moves the timeline to its latest message", () => {
    const timeline = { scrollHeight: 1200, scrollTop: 64, clientHeight: 600 };

    scrollTimelineToLatest(timeline);

    expect(timeline.scrollTop).toBe(1200);
  });

  it("recognizes when the timeline is close enough to the latest message", () => {
    expect(isTimelineAtLatest({ scrollHeight: 1200, scrollTop: 576, clientHeight: 600 })).toBe(true);
    expect(isTimelineAtLatest({ scrollHeight: 1200, scrollTop: 500, clientHeight: 600 })).toBe(false);
  });
});
