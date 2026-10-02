/**
 * 测试职责：锁住 Plan Explorer 的**需求投影**——激活需求解析、Plan 分组、workspace / activity
 * 刷新、乱序响应守卫、续传游标和线程级复位。
 *
 * 设计说明：composable 不用生命周期钩子，直接调用即可（无需组件、无需 jsdom）。
 * 所有会话状态都以 `ref` 注入；fixture 只给被测路径真正会读的字段，其余用形状桩，
 * 避免为了构造一个响应式容器复制整份 API DTO。
 *
 * 维护提示：
 * 1. `projectScopeToken` / `isCurrentProjectScope` 与 `planProjectionVersion` 是两道独立守卫：
 *    前者防项目切换，后者防同一线程内两次投影刷新乱序。两者都必须有竞态用例。
 * 2. `explorerEventSequence` 的写侧归本 composable；SSE 连接只读它，等 `useExplorerSse`
 *    抽出时不要复制一份游标。workspace / activity 都只能单调推进游标。
 * 3. `activePlans` 留在视图，因为它还读 `projectRuns`；本文件只测需求投影自己的 `allPlans`。
 */
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AgentLoop, ExplorerActivityItem, ExplorerPlan, ExplorerThread, ExplorerTurn, Plan, PlanRevisionDraft } from "../types";
import { usePlanProjection } from "./usePlanProjection";

vi.mock("../api", () => ({
  api: {
    explorer: vi.fn(),
    explorerPlanGroups: vi.fn(),
    explorerPlans: vi.fn(),
    explorerConfirmedPlans: vi.fn(),
    explorerThreadPlans: vi.fn(),
    explorerPlanWorkspace: vi.fn(),
    explorerActivity: vi.fn(),
  },
}));

const thread = (id = "explorer-1", overrides: Partial<ExplorerThread> = {}) => ({ id, ...overrides } as unknown as ExplorerThread);
const explorerPlan = (id: string, overrides: Partial<ExplorerPlan> = {}) => ({ id, ...overrides } as unknown as ExplorerPlan);
const turn = (id: string): ExplorerTurn => ({ id } as unknown as ExplorerTurn);
const activity = (id: string): ExplorerActivityItem => ({ id } as unknown as ExplorerActivityItem);

const plan = (id: string, overrides: Partial<Plan> = {}): Plan => ({
  id,
  title: id,
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  queuedAt: null,
  dispatchedAt: null,
  runId: null,
  lastEventAt: "2026-09-01T10:00:00.000Z",
  attentionReason: null,
  ...overrides,
});

const draft = (overrides: Partial<PlanRevisionDraft> = {}): PlanRevisionDraft => ({
  draftId: "draft-1",
  planId: "plan-draft",
  projectId: "project-1",
  basedOnRevision: 1,
  targetRevision: 2,
  status: "READY_TO_CONFIRM",
  title: "Draft plan",
  sourceExplorerThreadId: "explorer-1",
  sourceTurnId: null,
  providerThreadId: null,
  providerTurnId: null,
  providerItemId: null,
  baseBranch: "main",
  baseCommit: "abc",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:01:00.000Z",
  confirmedAt: null,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(options: { projectId?: string; threadId?: string | null; activePlanId?: string | null } = {}) {
  const projectId = ref(options.projectId ?? "project-1");
  const sessionThread = ref<ExplorerThread | null>(options.threadId === null ? null : thread(options.threadId ?? "explorer-1"));
  const turns = ref<ExplorerTurn[]>([]);
  const activity = ref<ExplorerActivityItem[]>([]);
  const agentLoop = ref<AgentLoop | null>(null);
  const explorerPaused = ref(false);
  const inputDialogOpen = ref(false);
  const pendingInput = ref<{ isBlocking?: boolean } | null>(null);
  const inputRequests: unknown[][] = [];
  const setInputRequests = vi.fn((items: unknown[]) => { inputRequests.push(items); });
  let token = 1;
  const isCurrentProjectScope = vi.fn(() => true);
  const projection = usePlanProjection({
    projectId,
    thread: sessionThread,
    turns,
    activity,
    agentLoop,
    explorerPaused,
    inputDialogOpen,
    pendingInput: pendingInput as never,
    setInputRequests,
    projectScopeToken: () => token,
    isCurrentProjectScope,
    routeExplorerPlanId: () => options.activePlanId ?? null,
  });
  return { ...projection, projectId, thread: sessionThread, turns, activity, agentLoop, explorerPaused, inputDialogOpen, pendingInput, inputRequests, setInputRequests, isCurrentProjectScope, setToken: (next: number) => { token = next; } };
}

beforeEach(() => {
  vi.mocked(api.explorer).mockReset();
  vi.mocked(api.explorerPlanGroups).mockReset();
  vi.mocked(api.explorerPlans).mockReset();
  vi.mocked(api.explorerConfirmedPlans).mockReset();
  vi.mocked(api.explorerThreadPlans).mockReset();
  vi.mocked(api.explorerPlanWorkspace).mockReset();
  vi.mocked(api.explorerActivity).mockReset();
});

describe("当前需求解析与 allPlans", () => {
  it("按显式 id、线程 id、分组第一项的顺序解析 activeExplorerPlan", () => {
    const s = setup();
    s.explorerPlans.value = [explorerPlan("ep-1"), explorerPlan("ep-2")];
    expect(s.activeExplorerPlan.value?.id).toBe("ep-1");

    s.activeExplorerPlanId.value = "ep-2";
    expect(s.activeExplorerPlan.value?.id).toBe("ep-2");
    s.activeExplorerPlanId.value = "missing";
    expect(s.activeExplorerPlan.value?.id).toBe("ep-1");
  });

  it("把候选、已确认、已入队、已派发按身份去重并保留最后一份", () => {
    const s = setup();
    s.candidate.value = plan("same", { status: "DRAFT" });
    s.confirmedPlans.value = [plan("same", { status: "READY" }), plan("confirmed-2", { status: "READY" })];
    s.enqueued.value = [plan("queued-1", { status: "ENQUEUED" })];
    s.dispatched.value = [plan("dispatched-1", { dispatchedAt: "2026-09-01T10:00:00Z" })];

    expect(s.allPlans.value.map((item) => item.id)).toEqual(["same", "confirmed-2", "queued-1", "dispatched-1"]);
    expect(s.allPlans.value.find((item) => item.id === "same")?.status).toBe("READY");
  });
});

describe("applyPlanProjection 与 workspace", () => {
  it("只把 READY / ENQUEUED / 已派发 Plan 分别落到对应投影", () => {
    const s = setup();
    const ready = plan("ready", { status: "READY" });
    const queued = plan("queued", { status: "ENQUEUED" });
    const dispatched = plan("dispatched", { status: "IN_PROGRESS", dispatchedAt: "2026-09-01T10:00:00Z" });
    const projection = { thread: thread(), candidate: plan("candidate"), dispatched: [ready, queued, dispatched] };

    s.applyPlanProjection(projection, [ready, plan("not-ready", { status: "DRAFT" })]);

    expect(s.thread.value).toEqual(projection.thread);
    expect(s.candidate.value?.id).toBe("candidate");
    expect(s.confirmedPlans.value.map((item) => item.id)).toEqual(["ready"]);
    expect(s.enqueued.value.map((item) => item.id)).toEqual(["queued"]);
    expect(s.dispatched.value.map((item) => item.id)).toEqual(["dispatched"]);
  });

  it("修订草稿投影成候选，并优先使用草稿自己的 explorerPlanId", () => {
    const s = setup();
    s.activeExplorerPlanId.value = "active-plan";
    s.applyPlanProjection({ thread: thread(), candidate: null, dispatched: [] }, [], draft({ explorerPlanId: "draft-plan" }));

    expect(s.candidate.value?.id).toBe("plan-draft");
    expect(s.candidate.value?.explorerPlanId).toBe("draft-plan");
    expect(s.revisionDraft.value?.draftId).toBe("draft-1");
  });

  it("workspace 成功后写会话状态、输入请求、暂停状态，并单调推进游标", async () => {
    const s = setup();
    s.thread.value = thread();
    vi.mocked(api.explorerPlanWorkspace).mockResolvedValue({
      explorerPlan: explorerPlan("ep-1"),
      turns: [turn("turn-1")],
      activity: [activity("activity-1")],
      inputRequests: [],
      candidate: plan("candidate"),
      revisionDraft: draft(),
      loops: [{ startedAt: "2026-09-01T10:00:00Z", state: "PAUSED" } as AgentLoop],
      lastEventSequence: 8,
    });

    expect(await s.loadActivePlanWorkspace("explorer-1", "ep-1", "project-1", 1)).toBe(true);
    expect(s.turns.value.map((item) => item.id)).toEqual(["turn-1"]);
    expect(s.activity.value.map((item) => item.id)).toEqual(["activity-1"]);
    expect(s.setInputRequests).toHaveBeenCalledWith([]);
    expect(s.candidate.value?.id).toBe("candidate");
    expect(s.revisionDraft.value?.draftId).toBe("draft-1");
    expect(s.agentLoop.value?.state).toBe("PAUSED");
    expect(s.explorerPaused.value).toBe(true);
    expect(s.explorerEventSequence.value).toBe(8);

    vi.mocked(api.explorerPlanWorkspace).mockResolvedValue({
      explorerPlan: explorerPlan("ep-1"), turns: [], activity: [], inputRequests: [], candidate: null, revisionDraft: null, loops: [], lastEventSequence: 3,
    });
    await s.loadActivePlanWorkspace("explorer-1", "ep-1", "project-1", 1);
    expect(s.explorerEventSequence.value).toBe(8);
  });

  it("没有激活需求时不请求 workspace", async () => {
    const s = setup();
    await expect(s.loadActivePlanWorkspace("explorer-1", null, "project-1", 1)).resolves.toBe(true);
    expect(api.explorerPlanWorkspace).not.toHaveBeenCalled();
  });
});

describe("refreshPlanProjection 的竞态与路由回退", () => {
  it("按当前 id、路由 id、服务端 id、第一项回退选择激活需求", async () => {
    const s = setup({ activePlanId: "ep-route" });
    s.thread.value = thread();
    vi.mocked(api.explorer).mockResolvedValue({ explorer: thread("explorer-1", { activeExplorerPlanId: "ep-server" }) });
    vi.mocked(api.explorerPlanGroups).mockResolvedValue({ items: [explorerPlan("ep-first"), explorerPlan("ep-route"), explorerPlan("ep-server")] });
    vi.mocked(api.explorerPlans).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(api.explorerConfirmedPlans).mockResolvedValue({ items: [] });
    vi.mocked(api.explorerThreadPlans).mockResolvedValue({ items: [] });
    vi.mocked(api.explorerPlanWorkspace).mockResolvedValue({ explorerPlan: explorerPlan("ep-route"), turns: [], activity: [], inputRequests: [], candidate: null, revisionDraft: null, loops: [], lastEventSequence: 2 });

    await s.refreshPlanProjection();

    expect(s.activeExplorerPlanId.value).toBe("ep-route");
    expect(api.explorerPlanWorkspace).toHaveBeenCalledWith("project-1", "explorer-1", "ep-route");
  });

  it("同一线程的旧刷新响应返回后不覆盖新投影", async () => {
    const s = setup();
    s.thread.value = thread();
    const first = deferred<{ explorer: ExplorerThread }>();
    const second = deferred<{ explorer: ExplorerThread }>();
    vi.mocked(api.explorer).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.mocked(api.explorerPlanGroups).mockResolvedValue({ items: [explorerPlan("ep-new")] });
    vi.mocked(api.explorerPlans).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(api.explorerConfirmedPlans).mockResolvedValue({ items: [] });
    vi.mocked(api.explorerThreadPlans).mockResolvedValue({ items: [] });

    const oldRefresh = s.refreshPlanProjection();
    const newRefresh = s.refreshPlanProjection();
    second.resolve({ explorer: thread("explorer-1", { activeExplorerPlanId: "ep-new" }) });
    await newRefresh;
    first.resolve({ explorer: thread("explorer-1", { activeExplorerPlanId: "ep-old" }) });
    await oldRefresh;

    expect(s.activeExplorerPlanId.value).toBe("ep-new");
    expect(s.thread.value?.activeExplorerPlanId).toBe("ep-new");
  });

  it("项目令牌失效后丢弃响应", async () => {
    const s = setup();
    s.thread.value = thread();
    const response = deferred<{ explorer: ExplorerThread }>();
    vi.mocked(api.explorer).mockReturnValue(response.promise);
    const refresh = s.refreshPlanProjection();
    s.isCurrentProjectScope.mockReturnValue(false);
    response.resolve({ explorer: thread("explorer-1", { activeExplorerPlanId: "ep-stale" }) });
    await refresh;

    expect(s.explorerPlans.value).toEqual([]);
    expect(s.activeExplorerPlanId.value).toBeNull();
  });
});

describe("activity、刷新计时器与复位", () => {
  it("activity 刷新只接受仍属于当前需求的响应", async () => {
    const s = setup();
    s.thread.value = thread();
    s.explorerPlans.value = [explorerPlan("ep-1")];
    s.activeExplorerPlanId.value = "ep-1";
    vi.mocked(api.explorerActivity).mockResolvedValue({ items: [activity("a1")], lastEventSequence: 5 });

    await s.refreshActivity();

    expect(s.activity.value.map((item) => item.id)).toEqual(["a1"]);
    expect(s.explorerEventSequence.value).toBe(5);
  });

  it("scheduleProjectionRefresh 合并重复触发，cancel 会取消待执行任务", () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.thread.value = thread();
      vi.spyOn(s, "refreshActivity").mockResolvedValue(undefined);
      vi.spyOn(s, "refreshPlanProjection").mockResolvedValue(undefined);

      s.scheduleProjectionRefresh();
      s.scheduleProjectionRefresh();
      s.cancelProjectionRefresh();
      vi.advanceTimersByTime(400);

      expect(s.refreshActivity).not.toHaveBeenCalled();
      expect(s.refreshPlanProjection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("复位清空投影与续传游标，并让此前世代失效", () => {
    const s = setup();
    s.explorerPlans.value = [explorerPlan("ep-1")];
    s.activeExplorerPlanId.value = "ep-1";
    s.candidate.value = plan("candidate");
    s.explorerEventSequence.value = 9;
    const before = s.beginPlanProjection();

    s.resetPlanProjection();

    expect(s.explorerPlans.value).toEqual([]);
    expect(s.activeExplorerPlanId.value).toBeNull();
    expect(s.candidate.value).toBeNull();
    expect(s.explorerEventSequence.value).toBeNull();
    expect(s.isCurrentPlanProjection(before)).toBe(false);
  });
});
