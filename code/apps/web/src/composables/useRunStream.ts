/**
 * 模块职责：Run 执行会话的 SSE 通道——建连 / 断连、**续传游标**、把 `journal.entry` 并进
 * ExecutionThread、把遥测快照写回线程。它只负责传输与合并，不知道会话怎么分组、页面怎么滚动：
 * 那两件事通过 `onJournalApplied` 交回视图。
 *
 * 为什么单独抽出来：这一簇原先住在 `RunDetailView.vue` 里（1133 行，同时装着加载、控制动作、
 * 输入框、抽屉），而它自己有完整的生命周期与两条容易写错的规则（见维护提示）。
 * 分法与探索侧一致（`composables/useExplorerSse.ts`）。
 *
 * 维护提示：
 * 1. **游标（`sequence`）归本文件**：它是"重连从哪继续"的唯一依据，写侧只有两处——
 *    服务端 journal 重建后由视图调 `resumeFrom`，以及每接受一条事件推进一次。视图不再持有它。
 *    重复 sequence 的事件直接忽略，否则重连会把同一批事实并两遍。
 * 2. **`follow` 必须在并入事件之前测**：并入之后 `scrollHeight` 已经变了，"用户原本贴着底部吗"
 *    这个问题就再也答不准——实测会表现为"跑着的时候页面不再自动跟底"。
 * 3. `MERGE_READY` **不是终态**，判据是 `RUN_STREAM_TERMINAL_STATUSES`（utils/runControls.ts），
 *    建连与收流两处共用它同一份。
 */
import { ref, type Ref } from "vue";
import { api } from "../api";
import type { ExecutionThread, Run, RunJournalEvent } from "../types";
import { RUN_STREAM_TERMINAL_STATUSES } from "../utils/runControls";
import type { ExecutionJournalEntry } from "../utils/executionStream";

export type RunStreamDeps = {
  run: Ref<Run | null>;
  thread: Ref<ExecutionThread | null>;
  /** 用户此刻是不是贴着会话底部（并入之前测）。 */
  isAtLatest: () => boolean;
  /**
   * 一条事件已经并入线程与 Run 之后调。视图在这里重算会话，并按 `follow` 决定
   * 是"滚到最新"还是"亮出『跳到最新』那颗按钮"。
   */
  onJournalApplied: (event: RunJournalEvent, context: { follow: boolean }) => void;
};

export function useRunStream(deps: RunStreamDeps) {
  const connected = ref(false);
  let eventSource: EventSource | null = null;
  let sequence = 0;

  /**
   * 把游标推到**至少**这个序号。服务端 journal 重建（首次加载 / 切 Run）后调用——
   * 事件流要接着已加载的那一批往后放，而不是从头再放一遍。
   */
  function resumeFrom(next: number): void {
    sequence = Math.max(sequence, next);
  }

  /** 遥测快照（`stream.ready` / `telemetry.updated` / journal 事件里带的那份）写回线程。 */
  function applyTelemetry(snapshot: { threadTelemetry?: ExecutionThread["telemetry"] }): void {
    if (!deps.thread.value || snapshot.threadTelemetry === undefined) return;
    deps.thread.value = { ...deps.thread.value, telemetry: snapshot.threadTelemetry };
  }

  /** 接收单条 Run SSE；重复 sequence 直接忽略，避免重连导致消息重复。 */
  function appendJournalEvent(event: RunJournalEvent): void {
    const currentThread = deps.thread.value;
    if (!currentThread || event.sequence <= sequence) return;
    const follow = deps.isAtLatest();
    const entry: ExecutionJournalEntry = {
      sequence: event.sequence,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
    };
    deps.thread.value = {
      ...currentThread,
      state: event.threadState ?? currentThread.state,
      journal: [...currentThread.journal, entry],
      ...(event.threadTelemetry === undefined ? {} : { telemetry: event.threadTelemetry }),
    };
    sequence = event.sequence;
    if (event.runStatus && deps.run.value) deps.run.value = { ...deps.run.value, status: event.runStatus };
    deps.onJournalApplied(event, { follow });
    if (event.runStatus && RUN_STREAM_TERMINAL_STATUSES.includes(event.runStatus)) close();
  }

  function close(): void {
    eventSource?.close();
    eventSource = null;
    connected.value = false;
  }

  /**
   * 为**仍可能产生事实**的 Run 建立 SSE；真正的终态 Run 依赖已加载的持久化 journal
   * （它们不会再有新事实，开流只会白轮询）。判据见维护提示 3。
   */
  function connect(): void {
    const run = deps.run.value;
    if (!run || typeof EventSource === "undefined" || RUN_STREAM_TERMINAL_STATUSES.includes(run.status)) return;
    eventSource?.close();
    eventSource = new EventSource(api.runEventsUrl(run.id, sequence));
    eventSource.addEventListener("open", () => {
      connected.value = true;
    });
    eventSource.addEventListener("stream.ready", (raw) => {
      connected.value = true;
      try {
        applyTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] });
      } catch {
        /* Initial GET remains the source of truth. */
      }
    });
    eventSource.addEventListener("telemetry.updated", (raw) => {
      try {
        applyTelemetry(JSON.parse((raw as MessageEvent).data) as { threadTelemetry?: ExecutionThread["telemetry"] });
      } catch {
        /* The next poll or reconnect will recover the latest snapshot. */
      }
    });
    eventSource.addEventListener("journal.entry", (raw) => {
      try {
        appendJournalEvent(JSON.parse((raw as MessageEvent).data) as RunJournalEvent);
      } catch {
        /* The next reconnect will replay from the last accepted sequence. */
      }
    });
    eventSource.addEventListener("error", () => {
      connected.value = false;
    });
  }

  return { connected, connect, close, resumeFrom };
}
