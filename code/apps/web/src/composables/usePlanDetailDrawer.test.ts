/**
 * 测试职责：锁住 `refreshDetailPlan` 的**边界**——它只把抽屉里那份快照换成当前事实，不越界。
 *
 * 设计说明：这里只测这一个函数，不重测 `openPlanDetail` 的加载流程（那部分由
 *   ExplorerView.test.ts 的源码断言与浏览器实测覆盖）。API 与 ElMessage 都 mock。
 *
 * 维护提示：`detailPlan` 是快照（见本文件对应 composable 的维护提示 5）。新增"并回哪些字段"
 *   时要同时想清楚"哪些字段不该被并回"——下面第二条用例就是为这个存在的。
 */
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Plan, PlanRevisionDraft } from "../types";
import { usePlanDetailDrawer } from "./usePlanDetailDrawer";

vi.mock("../api", () => ({
  api: { getPlan: vi.fn(), candidatePlanVersions: vi.fn() },
}));
vi.mock("element-plus", () => ({ ElMessage: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "plan-1",
  planId: "plan-1",
  title: "Snapshot",
  revision: 1,
  status: "DRAFT",
  projectId: "project-1",
  sourceExplorerThreadId: "thread-1",
  explorerPlanId: "requirement-1",
  queuedAt: null,
  dispatchedAt: null,
  runId: null,
  lastEventAt: "2026-10-01T00:00:00.000Z",
  attentionReason: null,
  ...overrides,
});

/** `api.getPlan` 的返回：一份当前事实。 */
const detail = (overrides: Partial<Plan> = {}, dispatch: unknown = null) =>
  ({ plan: plan(overrides), revision: null, dispatch, mergeRequest: null }) as never;

function setup() {
  const projectId = ref("project-1");
  const revisionDraft = ref<PlanRevisionDraft | null>(null);
  const drawer = usePlanDetailDrawer({
    projectId,
    projectScopeToken: () => 1,
    revisionDraft,
    planFromRevisionDraft: () => plan(),
    onOpened: vi.fn(),
  });
  return { ...drawer, projectId };
}

beforeEach(() => {
  vi.mocked(api.getPlan).mockReset();
  vi.mocked(api.candidatePlanVersions).mockReset();
  vi.mocked(api.candidatePlanVersions).mockResolvedValue({ planId: "plan-1", latestRevision: 1, items: [] } as never);
});

describe("refreshDetailPlan", () => {
  it("把状态、Run 与调度状态换成当前事实——这一条就是「Run 已经在跑，卡片还写着已派发」", async () => {
    const s = setup();
    vi.mocked(api.getPlan).mockResolvedValue(detail({ status: "DRAFT" }));
    await s.openPlanDetail(plan());
    expect(s.detailPlan.value?.status).toBe("DRAFT");

    vi.mocked(api.getPlan).mockResolvedValue(
      detail({ status: "IN_PROGRESS", runId: "run-1" }, { planId: "plan-1", status: "RUNNING", phase: "RUN_STARTED" }),
    );
    await s.refreshDetailPlan();

    expect(s.detailPlan.value).toMatchObject({ status: "IN_PROGRESS", runId: "run-1" });
    expect(s.detailPlan.value?.dispatch).toMatchObject({ status: "RUNNING" });
  });

  it("用户停在历史版本上时，不拿当前版本的事实去覆盖它", async () => {
    const s = setup();
    vi.mocked(api.getPlan).mockResolvedValue(detail({ revision: 1, status: "DRAFT" }));
    await s.openPlanDetail(plan());

    // 这条 Plan 已经走到 V2 了，而抽屉里显示的是 V1：V1 的状态该原样留着。
    vi.mocked(api.getPlan).mockResolvedValue(detail({ revision: 2, status: "IN_PROGRESS" }));
    await s.refreshDetailPlan();

    expect(s.detailPlan.value?.revision).toBe(1);
    expect(s.detailPlan.value?.status).toBe("DRAFT");
  });

  it("抽屉里没有 Plan 时不发请求", async () => {
    const s = setup();

    await s.refreshDetailPlan();

    expect(api.getPlan).not.toHaveBeenCalled();
  });
});
