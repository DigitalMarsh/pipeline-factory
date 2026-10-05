/**
 * 测试职责：锁住 Plan 生命周期写操作的**分支语义**——确认、入队、启动 Run、丢弃、
 * 配置修订，以及这些动作在刷新投影和 drawer 状态上的顺序。
 *
 * 设计说明：composable 不用生命周期钩子，直接调用即可（无需组件、无需 jsdom）。
 * API / Element Plus 都 mock：这里测的是"选择哪个端点、何时刷新、如何保留失败状态"，
 * 不是网络或消息组件本身。所有状态通过 ref 注入，`openRunView` / `refreshPlanProjection`
 * 用 spy 观察组合根回调。
 *
 * 维护提示：确认 Candidate 与确认 Revision Draft 是两条协议，V1 与 V>1 的 enqueue / run
 * 也是两套端点；新增动作分支时分别补测试，不要只加一个 happy path。
 */
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import type { ExplorerPlan, ExplorerThread, Plan, PlanRevisionDraft, Project, Run } from "../types";
import { usePlanLifecycleActions } from "./usePlanLifecycleActions";

vi.mock("../api", () => ({
  api: {
    confirmPlan: vi.fn(),
    confirmRevisionDraft: vi.fn(),
    enqueuePlan: vi.fn(),
    enqueuePlanRevision: vi.fn(),
    startPlanRun: vi.fn(),
    startPlanRevisionRun: vi.fn(),
    revisePlanConfiguration: vi.fn(),
    discardPlan: vi.fn(),
    discardRevisionDraft: vi.fn(),
  },
}));
vi.mock("element-plus", () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  ElMessageBox: { confirm: vi.fn() },
}));

const plan = (id: string, overrides: Partial<Plan> = {}): Plan => ({
  id,
  title: id,
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  explorerPlanId: "requirement-1",
  queuedAt: null,
  dispatchedAt: null,
  runId: null,
  lastEventAt: "2026-09-01T10:00:00.000Z",
  attentionReason: null,
  ...overrides,
});

const draft = (overrides: Partial<PlanRevisionDraft> = {}): PlanRevisionDraft => ({
  draftId: "draft-1",
  planId: "plan-1",
  projectId: "project-1",
  basedOnRevision: 1,
  targetRevision: 2,
  status: "READY_TO_CONFIRM",
  title: "revision",
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

const run = (id: string): Run => ({
  id,
  projectId: "project-1",
  planId: "plan-1",
  planRevision: 1,
  status: "STARTING",
  branch: "run/plan-1",
  workspacePath: null,
  baseCommit: "abc",
  executionThreadId: "thread-1",
  createdAt: "2026-09-01T10:00:00.000Z",
  startedAt: null,
});

function setup(options: { candidate?: Plan | null; revisionDraft?: PlanRevisionDraft | null } = {}) {
  const projectId = ref("project-1");
  const project = ref<Project | null>({ settings: { commands: [{ commandId: "verify" }] } } as unknown as Project);
  const thread = ref<ExplorerThread | null>({ id: "explorer-1" } as unknown as ExplorerThread);
  const activeExplorerPlan = ref<ExplorerPlan | null>({ id: "requirement-1" } as unknown as ExplorerPlan);
  const selectedRequirementPlan = ref<Plan | null>(options.candidate ?? null);
  const candidate = ref<Plan | null>(options.candidate === undefined ? plan("plan-1") : options.candidate);
  const revisionDraft = ref<PlanRevisionDraft | null>(options.revisionDraft ?? null);
  const detailPlan = ref<Plan | null>(null);
  const enqueued = ref<Plan[]>([]);
  const projectRuns = ref<Run[]>([]);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const drawerOpen = ref(false);
  const drawerTab = ref<"explorer" | "plan" | "task">("explorer");
  const contextPanel = ref("candidate");
  const refreshPlanProjection = vi.fn(async () => undefined);
  const openRunView = vi.fn(async () => undefined);
  const actions = usePlanLifecycleActions({
    projectId, project, thread, activeExplorerPlan, selectedRequirementPlan, candidate, revisionDraft,
    detailPlan, enqueued, projectRuns, busy, error, drawerOpen, drawerTab, contextPanel,
    refreshPlanProjection, openRunView,
  });
  return { ...actions, projectId, project, thread, activeExplorerPlan, selectedRequirementPlan, candidate, revisionDraft, detailPlan, enqueued, projectRuns, busy, error, drawerOpen, drawerTab, contextPanel, refreshPlanProjection, openRunView };
}

beforeEach(() => {
  vi.mocked(api.confirmPlan).mockReset();
  vi.mocked(api.confirmRevisionDraft).mockReset();
  vi.mocked(api.enqueuePlan).mockReset();
  vi.mocked(api.enqueuePlanRevision).mockReset();
  vi.mocked(api.startPlanRun).mockReset();
  vi.mocked(api.startPlanRevisionRun).mockReset();
  vi.mocked(api.revisePlanConfiguration).mockReset();
  vi.mocked(api.discardPlan).mockReset();
  vi.mocked(api.discardRevisionDraft).mockReset();
  vi.mocked(ElMessage.success).mockReset();
  vi.mocked(ElMessage.error).mockReset();
  vi.mocked(ElMessage.info).mockReset();
  vi.mocked(ElMessage.warning).mockReset();
  vi.mocked(ElMessageBox.confirm).mockReset();
  vi.mocked(ElMessageBox.confirm).mockResolvedValue(undefined as never);
});

describe("confirmPlan", () => {
  it("确认 V1 Candidate 后刷新投影并打开 Plan drawer", async () => {
    const s = setup();
    const confirmed = plan("plan-1", { status: "READY" });
    vi.mocked(api.confirmPlan).mockResolvedValue({ plan: confirmed, run: null, dispatch: null, confirmation: { stage: "FROZEN", attempt: 1, retryable: false } });

    await s.confirmPlan();

    expect(api.confirmPlan).toHaveBeenCalledWith("plan-1", 1);
    expect(s.refreshPlanProjection).toHaveBeenCalledOnce();
    expect(s.drawerTab.value).toBe("plan");
    expect(s.drawerOpen.value).toBe(true);
    expect(s.detailPlan.value?.status).toBe("READY");
    expect(s.busy.value).toBe(false);
  });

  it("READY_TO_CONFIRM 的 Revision Draft 走草稿端点", async () => {
    const s = setup({ candidate: plan("plan-1"), revisionDraft: draft() });
    const confirmed = plan("plan-1", { revision: 2, status: "READY" });
    vi.mocked(api.confirmRevisionDraft).mockResolvedValue({ plan: confirmed, confirmation: { stage: "FROZEN", attempt: 1, retryable: false } });

    await s.confirmPlan();

    expect(api.confirmRevisionDraft).toHaveBeenCalledWith("plan-1", "draft-1");
    expect(api.confirmPlan).not.toHaveBeenCalled();
    expect(s.detailPlan.value?.revision).toBe(2);
  });

  it("未准备好的 Draft 不发请求，只提示继续探索或先 rebase", async () => {
    const s = setup({ candidate: plan("plan-1"), revisionDraft: draft({ status: "BASE_CHANGED" }) });

    await s.confirmPlan();

    expect(api.confirmRevisionDraft).not.toHaveBeenCalled();
    expect(ElMessage.info).toHaveBeenCalledWith("默认分支已变，确认前需要先给这份修订草稿 rebase。");
  });

  it("候选为空（已确认 Plan 上挂着草稿）时，抽屉传入的那一版仍然确认草稿", async () => {
    const s = setup({ candidate: null, revisionDraft: draft() });
    // 抽屉里显示的是草稿投影出来的 V2：id 与 revision 都来自 draft。
    const shown = plan("plan-1", { revision: 2 });
    vi.mocked(api.confirmRevisionDraft).mockResolvedValue({ plan: plan("plan-1", { revision: 2, status: "READY" }), confirmation: { stage: "FROZEN", attempt: 1, retryable: false } });

    await s.confirmPlan(shown);

    expect(api.confirmRevisionDraft).toHaveBeenCalledWith("plan-1", "draft-1");
    expect(api.confirmPlan).not.toHaveBeenCalled();
    expect(s.detailPlan.value?.revision).toBe(2);
  });

  it("候选为空且调用方没给目标时不发任何请求", async () => {
    const s = setup({ candidate: null });

    await s.confirmPlan();

    expect(api.confirmPlan).not.toHaveBeenCalled();
    expect(api.confirmRevisionDraft).not.toHaveBeenCalled();
    expect(s.busy.value).toBe(false);
  });

  it("服务端确认停在 DRAFT 时写入错误并保持忙碌状态已释放", async () => {
    const s = setup();
    vi.mocked(api.confirmPlan).mockResolvedValue({ plan: plan("plan-1", { status: "DRAFT" }), run: null, dispatch: { lastError: "missing verify" } as never, confirmation: { stage: "VALIDATION_FAILED", attempt: 1, retryable: true } });

    await s.confirmPlan();

    expect(s.error.value).toBe("确认停在 VALIDATION_FAILED：missing verify");
    expect(ElMessage.error).toHaveBeenCalledWith(s.error.value);
    expect(s.busy.value).toBe(false);
  });
});

describe("enqueuePlan", () => {
  it("V1 入队后更新列表、清候选并打开 task drawer", async () => {
    const s = setup();
    s.candidate.value = plan("plan-1", { status: "READY" });
    const queued = plan("plan-1", { status: "ENQUEUED", queuedAt: "2026-09-01T10:00:00Z" });
    vi.mocked(api.enqueuePlan).mockResolvedValue({ plan: queued });

    await s.enqueuePlan();

    expect(api.enqueuePlan).toHaveBeenCalledWith("plan-1");
    expect(s.enqueued.value[0]?.status).toBe("ENQUEUED");
    expect(s.candidate.value).toBeNull();
    expect(s.drawerTab.value).toBe("task");
    expect(s.drawerOpen.value).toBe(true);
  });

  it("V2 入队走 revision 端点", async () => {
    const s = setup();
    const input = plan("plan-1", { revision: 2, status: "READY" });
    const queued = plan("plan-1", { revision: 2, status: "ENQUEUED" });
    vi.mocked(api.enqueuePlanRevision).mockResolvedValue({ plan: queued });

    await s.enqueuePlan(input);

    expect(api.enqueuePlanRevision).toHaveBeenCalledWith("plan-1", 2);
    expect(api.enqueuePlan).not.toHaveBeenCalled();
  });

  it("对话产物在前置守卫处被拒绝", async () => {
    const s = setup();
    const conversation = plan("plan-1", { status: "READY", resolvedContract: { artifact: { mode: "CONVERSATION" } } as never });

    await s.enqueuePlan(conversation);

    expect(api.enqueuePlan).not.toHaveBeenCalled();
    expect(ElMessage.error).toHaveBeenCalledWith("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
  });

  it("服务端返回对话产物错误码时仍显示同一提示", async () => {
    const s = setup();
    const input = plan("plan-1", { status: "READY" });
    vi.mocked(api.enqueuePlan).mockRejectedValue(new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE"));

    await s.enqueuePlan(input);

    expect(ElMessage.error).toHaveBeenCalledWith("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
  });
});

describe("startPlanRun 与 revisePlanConfiguration", () => {
  it("启动 V1 Run 后更新 projectRuns 并打开 Run 视图", async () => {
    const s = setup();
    const input = plan("plan-1", { status: "ENQUEUED" });
    const started = run("run-1");
    vi.mocked(api.startPlanRun).mockResolvedValue({ plan: plan("plan-1", { status: "DISPATCHED" }), run: started, dispatch: { waitReason: null } as never });

    await s.startPlanRun(input);

    expect(api.startPlanRun).toHaveBeenCalledWith("plan-1");
    expect(s.projectRuns.value.map((item) => item.id)).toEqual(["run-1"]);
    expect(s.openRunView).toHaveBeenCalledWith("run-1", "explorer-1", "requirement-1");
  });

  it("配置缺失但命令已注册时创建新 Revision并切到 confirmed", async () => {
    const s = setup();
    const input = plan("plan-1", { status: "DISPATCHED", dispatch: { status: "WAITING", waitReason: "NEEDS_CONFIGURATION", lastError: "missing registered commands: verify" } as never });
    vi.mocked(api.revisePlanConfiguration).mockResolvedValue({ plan: input });

    await s.revisePlanConfiguration(input);

    expect(api.revisePlanConfiguration).toHaveBeenCalledWith("plan-1");
    expect(s.contextPanel.value).toBe("confirmed");
  });
});

describe("discardPlan", () => {
  it("确认普通 Candidate 后调用 discardPlan 并关闭 drawer", async () => {
    const s = setup();
    s.candidate.value = plan("plan-1", { status: "DRAFT" });
    vi.mocked(api.discardPlan).mockResolvedValue({ plan: plan("plan-1", { status: "DISCARDED" }) });

    await s.discardPlan();

    expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
    expect(api.discardPlan).toHaveBeenCalledWith("plan-1");
    expect(s.candidate.value).toBeNull();
    expect(s.drawerOpen.value).toBe(false);
  });

  it("Revision Draft 走 discardRevisionDraft 且不走普通 Plan 端点", async () => {
    const s = setup({ candidate: plan("plan-1"), revisionDraft: draft() });
    vi.mocked(api.discardRevisionDraft).mockResolvedValue({ draft: draft({ status: "DISCARDED" }) });

    await s.discardPlan();

    expect(api.discardRevisionDraft).toHaveBeenCalledWith("plan-1", "draft-1");
    expect(api.discardPlan).not.toHaveBeenCalled();
  });

  it("候选为空时，丢弃抽屉传入的那一版草稿仍然走 discardRevisionDraft", async () => {
    const s = setup({ candidate: null, revisionDraft: draft() });
    vi.mocked(api.discardRevisionDraft).mockResolvedValue({ draft: draft({ status: "DISCARDED" }) });

    await s.discardPlan(plan("plan-1", { revision: 2 }));

    expect(api.discardRevisionDraft).toHaveBeenCalledWith("plan-1", "draft-1");
    expect(api.discardPlan).not.toHaveBeenCalled();
  });

  it("用户取消确认时不发删除请求", async () => {
    const s = setup();
    vi.mocked(ElMessageBox.confirm).mockRejectedValue(new Error("cancel"));

    await s.discardPlan();

    expect(api.discardPlan).not.toHaveBeenCalled();
  });
});
