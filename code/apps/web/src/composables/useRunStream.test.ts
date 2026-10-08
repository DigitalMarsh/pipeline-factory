/**
 * 测试职责：锁住 Run 执行会话 SSE 的**传输编排**——建连 URL 与游标、事件并进 ExecutionThread、
 * 重复事件丢弃、终态收流、以及"跟不跟到底部"这个判据测在哪一刻。
 *
 * 设计说明：不需要 jsdom；用最小 EventSource 形状桩记录 URL、handler 与 close，composable 直接调用。
 * 会话分组另有配对测试（`utils/executionConversation.test.ts`），本文件只测"事件到状态的路由"。
 *
 * 维护提示：`MERGE_READY` 不是终态这条有回归用例（它曾经关掉事件流，页面从此一动不动）；
 * `follow` 必须是**并入之前**测的，下面有一条用例专门钉住这一点。
 */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionThread, Run, RunJournalEvent } from "../types";
import { useRunStream } from "./useRunStream";

vi.mock("../api", () => ({
  api: {
    runEventsUrl: vi.fn((runId: string, after?: number) => `run://${runId}?after=${after ?? "none"}`),
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  async emit(name: string, payload: unknown = {}) {
    for (const listener of this.listeners.get(name) ?? []) await listener({ data: JSON.stringify(payload) });
  }
}

const run = (status = "IN_PROGRESS"): Run => ({ id: "run-1", status, planId: "plan-1", planRevision: 1 }) as unknown as Run;
const thread = (sequence?: number): ExecutionThread =>
  ({
    id: "thread-1",
    state: "ACTIVE",
    journal: sequence === undefined ? [] : [{ sequence, type: "MODEL_OUTPUT", occurredAt: "2026-10-08T00:00:00.000Z", payload: {} }],
  }) as unknown as ExecutionThread;
const journalEvent = (sequence: number, patch: Partial<RunJournalEvent> = {}): RunJournalEvent =>
  ({
    runId: "run-1",
    runStatus: null,
    threadState: null,
    sequence,
    type: "MODEL_OUTPUT",
    occurredAt: "2026-10-08T00:01:00.000Z",
    payload: {},
    ...patch,
  }) as RunJournalEvent;

function setup(options: { runStatus?: string; initialSequence?: number; atLatest?: boolean } = {}) {
  const runRef = ref<Run | null>(run(options.runStatus));
  const threadRef = ref<ExecutionThread | null>(thread(options.initialSequence));
  const applied: Array<{ sequence: number; follow: boolean }> = [];
  let atLatest = options.atLatest ?? true;
  /** `follow` 是在并入**之前**测的吗——测的那一刻 journal 里已经有多少条。 */
  const journalLengthWhenMeasuring: number[] = [];

  const stream = useRunStream({
    run: runRef,
    thread: threadRef,
    isAtLatest: () => {
      journalLengthWhenMeasuring.push(threadRef.value?.journal.length ?? -1);
      return atLatest;
    },
    onJournalApplied: (event, context) => {
      applied.push({ sequence: event.sequence, follow: context.follow });
    },
  });

  return {
    stream,
    runRef,
    threadRef,
    applied,
    journalLengthWhenMeasuring,
    setAtLatest: (value: boolean) => {
      atLatest = value;
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useRunStream", () => {
  it("建连 URL 带上当前游标；open / error 只管连接状态", async () => {
    const { stream } = setup();

    stream.connect();
    const source = FakeEventSource.instances[0]!;
    // 游标从 0 起——"已加载到第几条"由视图在 journal 重建后经 `resumeFrom` 告诉它。
    expect(source.url).toBe("run://run-1?after=0");
    expect(stream.connected.value).toBe(false);

    await source.emit("open");
    expect(stream.connected.value).toBe(true);

    await source.emit("error");
    expect(stream.connected.value).toBe(false);
  });

  it("`journal.entry` 并进线程：追加日志、更新线程状态与 Run 状态", async () => {
    const { stream, runRef, threadRef, applied } = setup();
    stream.connect();
    const source = FakeEventSource.instances[0]!;

    await source.emit("journal.entry", journalEvent(1, { threadState: "PAUSED", runStatus: "VERIFYING" }));

    expect(threadRef.value?.journal.map((entry) => entry.sequence)).toEqual([1]);
    expect(threadRef.value?.state).toBe("PAUSED");
    expect(runRef.value?.status).toBe("VERIFYING");
    expect(applied).toEqual([{ sequence: 1, follow: true }]);
  });

  it("**重复 sequence 直接忽略**（重连会把一批事实再放一遍）", async () => {
    const { stream, threadRef, applied } = setup({ initialSequence: 3 });
    stream.resumeFrom(3);
    stream.connect();
    const source = FakeEventSource.instances[0]!;

    await source.emit("journal.entry", journalEvent(3));
    await source.emit("journal.entry", journalEvent(2));

    expect(threadRef.value?.journal).toHaveLength(1);
    expect(applied).toEqual([]);
  });

  it("`resumeFrom` 推进游标，重连从这里继续而不是从头再来", async () => {
    const { stream } = setup();

    stream.resumeFrom(12);
    stream.connect();

    expect(FakeEventSource.instances[0]!.url).toBe("run://run-1?after=12");
    // 只增不减：服务端给回一个更小的值不会把游标退回去。
    stream.resumeFrom(4);
    stream.connect();
    expect(FakeEventSource.instances[1]!.url).toBe("run://run-1?after=12");
  });

  it("**终态收流**；`MERGE_READY` 不是终态——它还能被补充要求推回重新跑一轮", async () => {
    const { stream } = setup();
    stream.connect();
    const source = FakeEventSource.instances[0]!;

    await source.emit("journal.entry", journalEvent(1, { runStatus: "MERGE_READY" }));
    expect(source.closed).toBe(false);

    await source.emit("journal.entry", journalEvent(2, { runStatus: "MERGED" }));
    expect(source.closed).toBe(true);
    expect(stream.connected.value).toBe(false);
  });

  it("终态的 Run 不建连（它不会再有新事实，开流只是白轮询）", () => {
    const { stream } = setup({ runStatus: "CANCELLED" });

    stream.connect();

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("**`follow` 在并入之前测**——并入之后 `scrollHeight` 已经变了，答不准", async () => {
    const { stream, journalLengthWhenMeasuring, applied } = setup({ atLatest: false });
    stream.connect();

    await FakeEventSource.instances[0]!.emit("journal.entry", journalEvent(1));

    expect(journalLengthWhenMeasuring).toEqual([0]);
    expect(applied).toEqual([{ sequence: 1, follow: false }]);
  });

  it("遥测快照写回线程（`stream.ready` 与 `telemetry.updated` 同一个口）", async () => {
    const { stream, threadRef } = setup();
    stream.connect();
    const source = FakeEventSource.instances[0]!;
    const threadTelemetry = { model: "gpt-5.6-luna" } as ExecutionThread["telemetry"];

    await source.emit("stream.ready", { threadTelemetry });
    expect(threadRef.value?.telemetry).toEqual(threadTelemetry);

    await source.emit("telemetry.updated", { threadTelemetry: null });
    expect(threadRef.value?.telemetry).toBeNull();
  });

  it("坏载荷不会把流打断（下一次重连会从最后接受的游标重放）", async () => {
    const { stream, applied } = setup();
    stream.connect();
    const source = FakeEventSource.instances[0]!;

    // 原样喂一段不是 JSON 的 data：解析会抛，但必须被 handler 吃掉。
    for (const listener of source.listeners.get("journal.entry") ?? []) listener({ data: "{" });
    await source.emit("journal.entry", journalEvent(2));

    expect(applied.map((entry) => entry.sequence)).toEqual([2]);
    expect(source.closed).toBe(false);
  });
});
