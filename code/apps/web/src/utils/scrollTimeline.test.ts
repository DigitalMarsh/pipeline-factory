import { describe, expect, it } from "vitest";
import { scrollTimelineToLatest } from "./scrollTimeline";

describe("scrollTimelineToLatest", () => {
  it("moves the timeline to its latest message", () => {
    const timeline = { scrollHeight: 1200, scrollTop: 64 };

    scrollTimelineToLatest(timeline);

    expect(timeline.scrollTop).toBe(1200);
  });
});
