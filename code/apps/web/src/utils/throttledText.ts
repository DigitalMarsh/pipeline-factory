/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";

/** 流式文本的默认合并间隔；消息越长，单位时间内的 Markdown 重解析次数越少。 */
export const STREAM_RENDER_INTERVAL_MS = 150;

type TextSource = Ref<string> | Readonly<Ref<string>>;
type FlagSource = Ref<boolean> | Readonly<Ref<boolean>>;

/**
 * 把高频变化的流式文本节流为展示值：前缘立即生效，尾缘最多每 intervalMs 合并一次。
 * streaming 变为 false 时立刻同步最终值，保证消息结束时排版稳定。
 */
export function useThrottledText(source: TextSource, streaming: FlagSource, intervalMs = STREAM_RENDER_INTERVAL_MS): Ref<string> {
  const displayed = ref(source.value);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAppliedAt = 0;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const apply = () => {
    lastAppliedAt = Date.now();
    displayed.value = source.value;
  };
  const applyNow = () => {
    clearTimer();
    apply();
  };

  watch(source, () => {
    if (!streaming.value) {
      applyNow();
      return;
    }
    const elapsed = Date.now() - lastAppliedAt;
    if (elapsed >= intervalMs) {
      applyNow();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      apply();
    }, intervalMs - elapsed);
  });

  watch(streaming, (isStreaming) => {
    if (!isStreaming) applyNow();
  });

  if (getCurrentScope()) onScopeDispose(clearTimer);
  return displayed;
}
