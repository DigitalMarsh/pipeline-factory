/**
 * 测试职责：锁住 Explorer SSE 的**传输编排**——三条通道的 URL / 生命周期、回调竞态门、
 * Turn delta 即时合并、结构化输入按 requestId 落位、需求状态与 Agent Loop 刷新节流。
 *
 * 设计说明：不需要 jsdom；用最小 EventSource 形状桩记录 URL、handler 与 close，
 * composable 直接调用。API / scroll / nextTick 之外的业务都通过 ref 与 callback 注入。
 * 本文件测的是"事件到状态回调的路由"，投影与输入状态机各自有配对测试。
 *
 * 维护提示：`closeEvents` 与 `closeRequirementStatusEvents` 故意分开；续传游标只读自
 * `usePlanProjection`；`turn.input_required` 必须走 adoptInputRequest，不能回到裸 ref 写入。
 */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AgentLoop, ExplorerInputRequest, ExplorerPlan, ExplorerThread, ExplorerTurn } from "../types";
import { useExplorerSse } from "./useExplorerSse";

vi.mock("../api", () => ({
  api: {
    explorerEventsUrl: vi.fn(
      (projectId: string, threadId: string, planId: string, after?: number) =>
        `explorer://${projectId}/${threadId}/${planId}?after=${after ?? "none"}`,
    ),
    explorerRequirementStatusEventsUrl: vi.fn(
      (projectId: string, threadId: string, after?: number) => `requirement://${projectId}/${threadId}?after=${after ?? "none"}`,
    ),
    agentLoopEventsUrl: vi.fn((loopId: string) => `loop://${loopId}`),
    getExplorerTurns: vi.fn(),
    inputRequests: vi.fn(),
    agentLoop: vi.fn(),
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

const thread = (id = "explorer-1") => ({ id, title: "旧标题", titleStatus: "PLACEHOLDER" }) as unknown as ExplorerThread;
const explorerPlan = (id: string, runtimeStatus?: ExplorerPlan["runtimeStatus"]) =>
  ({ id, explorerThreadId: "explorer-1", runtimeStatus }) as unknown as ExplorerPlan;
const turn = (id: string, content = "原文"): ExplorerTurn => ({ id, content }) as unknown as ExplorerTurn;
const request = (id: string): ExplorerInputRequest => ({ id }) as unknown as ExplorerInputRequest;

function setup(options: { withLoop?: boolean; sequence?: number | null } = {}) {
  const projectId = ref("project-1");
  const currentThread = ref<ExplorerThread | null>(thread());
  const explorers = ref<ExplorerThread[]>([thread()]);
  const activeExplorerPlan = ref<ExplorerPlan | null>(explorerPlan("plan-1"));
  const explorerPlans = ref<ExplorerPlan[]>([explorerPlan("plan-1")]);
  const turns = ref<ExplorerTurn[]>([turn("turn-1")]);
  const agentLoop = ref<AgentLoop | null>(options.withLoop ? ({ id: "loop-1", state: "RUNNING" } as unknown as AgentLoop) : null);
  const explorerPaused = ref(false);
  const explorerEventSequence = ref<number | null>(options.sequence ?? null);
  const timeline = ref<HTMLElement | null>(null);
  const refreshActivity = vi.fn(async () => undefined);
  const refreshPlanProjection = vi.fn(async () => undefined);
  const scheduleProjectionRefresh = vi.fn();
  const cancelProjectionRefresh = vi.fn();
  const adoptInputRequest = vi.fn();
  const load = vi.fn(async () => true);
  let token = 1;
  const isCurrentProjectScope = vi.fn(() => true);
  const sse = useExplorerSse({
    projectId,
    thread: currentThread,
    explorers,
    activeExplorerPlan,
    explorerPlans,
    turns,
    agentLoop,
    explorerPaused,
    explorerEventSequence,
    timeline,
    projectScopeToken: () => token,
    isCurrentProjectScope,
    refreshActivity,
    refreshPlanProjection,
    scheduleProjectionRefresh,
    cancelProjectionRefresh,
    adoptInputRequest,
    load,
  });
  return {
    ...sse,
    projectId,
    thread: currentThread,
    explorers,
    activeExplorerPlan,
    explorerPlans,
    turns,
    agentLoop,
    explorerPaused,
    explorerEventSequence,
    refreshActivity,
    refreshPlanProjection,
    scheduleProjectionRefresh,
    cancelProjectionRefresh,
    adoptInputRequest,
    load,
    isCurrentProjectScope,
    setToken: (next: number) => {
      token = next;
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.mocked(api.getExplorerTurns).mockReset();
  vi.mocked(api.inputRequests).mockReset();
  vi.mocked(api.agentLoop).mockReset();
  vi.mocked(api.getExplorerTurns).mockResolvedValue({ items: [], lastEventSequence: 0 });
  vi.mocked(api.inputRequests).mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("需求 Turn 通道", () => {
  it("用投影游标建连、即时合并 delta，并把终态刷新交给回调", async () => {
    const s = setup({ sequence: 7 });
    vi.mocked(api.getExplorerTurns).mockResolvedValue({ items: [turn("turn-1", "服务端")], lastEventSequence: 8 });
    vi.mocked(api.inputRequests).mockResolvedValue({ items: [] });

    s.connectEvents();

    expect(FakeEventSource.instances.map((item) => item.url)).toEqual([
      "requirement://project-1/explorer-1?after=7",
      "explorer://project-1/explorer-1/plan-1?after=7",
    ]);
    const main = FakeEventSource.instances[1]!;
    await main.emit("turn.text.delta", { turnId: "turn-1", text: "增量" });
    expect(s.turns.value[0]?.content).toBe("原文增量");
    expect(s.scheduleProjectionRefresh).toHaveBeenCalledOnce();

    await main.emit("turn.completed");
    await vi.waitFor(() => expect(s.adoptInputRequest).toHaveBeenCalledWith(null, []));
    expect(api.getExplorerTurns).toHaveBeenCalledWith("project-1", "explorer-1", "plan-1");
    expect(s.refreshActivity).toHaveBeenCalled();
    expect(s.refreshPlanProjection).toHaveBeenCalled();
  });

  it("turn.input_required 按 payload requestId 通过 adoptInputRequest 落位", async () => {
    const s = setup();
    vi.mocked(api.inputRequests).mockResolvedValue({ items: [request("first"), request("target")] });
    s.connectEvents();

    await FakeEventSource.instances[1]!.emit("stream.ready");
    await FakeEventSource.instances[1]!.emit("turn.input_required", { requestId: "target" });

    expect(s.adoptInputRequest).toHaveBeenCalledWith("target", expect.arrayContaining([expect.objectContaining({ id: "target" })]));
    expect(s.refreshPlanProjection).toHaveBeenCalled();
  });

  it("title.updated 同步线程与目录投影", async () => {
    const s = setup();
    s.connectEvents();

    await FakeEventSource.instances[1]!.emit("stream.ready");
    await FakeEventSource.instances[1]!.emit("title.updated", { explorerId: "explorer-1", title: "新标题", titleStatus: "GENERATED" });

    expect(s.thread.value?.title).toBe("新标题");
    expect(s.explorers.value[0]?.title).toBe("新标题");
  });
});

describe("需求状态通道与生命周期", () => {
  it("只更新当前线程中存在的需求，并保持两种 close 生命周期分离", async () => {
    const s = setup({ sequence: 3 });
    s.connectRequirementStatusEvents();
    const source = FakeEventSource.instances[0]!;
    await source.emit("requirement.status", {
      explorerPlanId: "plan-1",
      status: "RUNNING",
      occurredAt: "2026-09-01T10:00:00Z",
      turnId: null,
    });
    expect(s.explorerPlans.value[0]?.runtimeStatus).toBe("RUNNING");

    s.connectEvents();
    const main = FakeEventSource.instances.at(-1)!;
    s.closeEvents();
    expect(main.closed).toBe(true);
    expect(source.closed).toBe(false);
    s.closeRequirementStatusEvents();
    expect(source.closed).toBe(true);
  });
});

describe("Agent Loop 通道", () => {
  it("终态事件立即回查 Loop，步骤事件合并到 400ms 后再回查", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ withLoop: true });
      vi.mocked(api.agentLoop).mockResolvedValue({ loop: { id: "loop-1", state: "PAUSED" } as unknown as AgentLoop });
      s.connectEvents();
      const loop = FakeEventSource.instances.find((item) => item.url === "loop://loop-1")!;

      await loop.emit("stream.ready");
      await loop.emit("agent.loop.paused");
      await vi.waitFor(() => expect(api.agentLoop).toHaveBeenCalledWith("loop-1"));
      expect(s.explorerPaused.value).toBe(true);

      vi.mocked(api.agentLoop).mockClear();
      await loop.emit("agent.step.started");
      expect(api.agentLoop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      expect(api.agentLoop).toHaveBeenCalledWith("loop-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
