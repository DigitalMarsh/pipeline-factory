/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type SseReplayGate = {
  ready: boolean;
  accept(eventName: string): boolean;
  markReady(): void;
};

/** 忽略 stream.ready 之前的重复/历史事件，避免首次加载与 SSE 回放双重追加。 */
export function createSseReplayGate(): SseReplayGate {
  let ready = false;
  return {
    get ready() { return ready; },
    accept(eventName: string): boolean {
      if (eventName === "stream.ready") {
        ready = true;
        return false;
      }
      return ready;
    },
    markReady() { ready = true; },
  };
}
