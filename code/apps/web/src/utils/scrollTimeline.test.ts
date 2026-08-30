/**
 * 测试职责：验证 scrollTimeline 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
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
