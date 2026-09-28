/**
 * 测试职责：锁住 Plan 生命周期投影的**读取复杂度**，以及"列表路径共享一次索引"这条约束。
 *
 * 为什么复杂度也需要测试：`decoratePlanRows` 原先对每一行调一次 `planProjection`，而后者内部
 *   每个 Plan 都读一遍 `listRuns()` 与 `listMergeRequests()`（全表 SELECT *）。这在单 Plan 时
 *   看不出来，Plan Center 的 limit 上限是 100，于是列表请求变成 200 次全表读——
 *   而且**结果完全正确**，只是慢，所以功能测试永远抓不住它。这里用调用计数把复杂度钉死：
 *   表读次数必须与行数无关。
 *
 * 维护提示：断言的是**调用次数**而不是耗时，所以它不会因机器快慢而抖动。
 *   新增投影时若确实需要按 Plan 读表，请在这里把该表登记为"允许随行数增长"，不要直接放宽整个断言。
 */
import { describe, expect, it } from "vitest";
import { ExplorerService, InMemoryPipelineStore, PlanService, ProjectService, type CandidatePlan, type PipelineStore } from "@pipeline-factory/domain";
import { decoratePlanRows, planProjection } from "./plan-lifecycle.js";

/** 记录三张"按 Plan 反复读就会爆"的表被读了几次。 */
class CountingStore extends InMemoryPipelineStore {
  listRunsCalls = 0;
  listMergeRequestsCalls = 0;
  listChangeProposalsCalls = 0;
  override listRuns() { this.listRunsCalls += 1; return super.listRuns(); }
  override listMergeRequests() { this.listMergeRequestsCalls += 1; return super.listMergeRequests(); }
  override listChangeProposals(runId?: string) { this.listChangeProposalsCalls += 1; return super.listChangeProposals(runId); }
  resetCounts() { this.listRunsCalls = 0; this.listMergeRequestsCalls = 0; this.listChangeProposalsCalls = 0; }
}

function seedPlans(store: PipelineStore, count: number): Array<{ planId: string; revision: number; projectId: string }> {
  const projects = new ProjectService(store);
  const project = projects.create({ id: "project-lifecycle", name: "Lifecycle Project", repoRoot: "/repo/lifecycle", defaultBranch: "main", worktreeRoot: "/tmp/lifecycle-worktrees" });
  const explorer = new ExplorerService(store).create({ projectId: project.id, title: "Lifecycle Explorer" });
  const plans = new PlanService(store, projects);
  const rows: Array<{ planId: string; revision: number; projectId: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, title: `Plan ${index}` });
    rows.push({ planId: plan.id, revision: plan.revision, projectId: project.id });
  }
  return rows;
}

describe("decoratePlanRows 的读取复杂度", () => {
  it("reads each Plan-scoped table once per request regardless of how many rows are decorated", () => {
    const store = new CountingStore();
    const rows = seedPlans(store, 5);
    store.resetCounts();

    const decorated = decoratePlanRows(store, rows);

    expect(decorated).toHaveLength(5);
    // 每张表恰好一次：与行数无关。改回"每个 Plan 各读一遍"会让这三个数变成 5。
    expect(store.listRunsCalls).toBe(1);
    expect(store.listMergeRequestsCalls).toBe(1);
    expect(store.listChangeProposalsCalls).toBe(1);
  });

  it("produces the same lifecycle entries whether the index is shared or built per call", () => {
    // index 只是把同一批表读提前做掉，不能改变结果——否则"优化"就变成了行为变更。
    const store = new CountingStore();
    const rows = seedPlans(store, 3);
    const plans = rows.map((row) => store.getPlan(row.planId)!) as CandidatePlan[];

    const fromRows = decoratePlanRows(store, rows).map((row) => row.lifecycle);
    const perPlan = plans.map((plan) => planProjection(store, plan).lifecycle);

    expect(fromRows).toEqual(perPlan);
  });
});
