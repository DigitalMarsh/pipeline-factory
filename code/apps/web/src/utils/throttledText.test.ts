/**
 * 测试职责：验证流式文本节流的前缘、尾缘与结束同步语义。
 * 设计说明：使用假定时器推进时间，避免依赖真实等待。
 * 维护提示：节流间隔或 flush 语义变化时，应同步调整这些场景。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { useThrottledText } from "./throttledText";

describe("useThrottledText", () => {
  afterEach(() => vi.useRealTimers());

  it("applies the first streaming update immediately", async () => {
    vi.useFakeTimers();
    const source = ref("a");
    const streaming = ref(true);
    const displayed = useThrottledText(source, streaming, 150);

    source.value = "b";
    await nextTick();

    expect(displayed.value).toBe("b");
  });

  it("coalesces rapid updates and keeps the latest text", async () => {
    vi.useFakeTimers();
    const source = ref("a");
    const streaming = ref(true);
    const displayed = useThrottledText(source, streaming, 150);
    source.value = "b";
    await nextTick();

    source.value = "c";
    await nextTick();
    source.value = "d";
    await nextTick();

    expect(displayed.value).toBe("b");
    vi.advanceTimersByTime(150);
    await nextTick();
    expect(displayed.value).toBe("d");
  });

  it("flushes the final text as soon as streaming ends", async () => {
    vi.useFakeTimers();
    const source = ref("a");
    const streaming = ref(true);
    const displayed = useThrottledText(source, streaming, 150);
    source.value = "b";
    await nextTick();
    source.value = "c";
    await nextTick();
    expect(displayed.value).toBe("b");

    streaming.value = false;
    await nextTick();

    expect(displayed.value).toBe("c");
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(displayed.value).toBe("c");
  });

  it("passes through immediately when not streaming", async () => {
    vi.useFakeTimers();
    const source = ref("a");
    const streaming = ref(false);
    const displayed = useThrottledText(source, streaming, 150);

    source.value = "b";
    await nextTick();
    source.value = "c";
    await nextTick();

    expect(displayed.value).toBe("c");
  });
});
