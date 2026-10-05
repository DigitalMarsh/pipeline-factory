/**
 * 测试职责：验证 Plan Center 查询的筛选、谱系、排序和游标稳定性。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, type PlanQuery } from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

function setup() {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
  const plans = new PlanService(store, projects);
  plans.registerThread({ id: "explorer-parent", projectId: "project-1", parentThreadId: null });
  plans.registerThread({ id: "explorer-child", projectId: "project-1", parentThreadId: "explorer-parent" });
  return { store, plans };
}

function enqueue(store: InMemoryPipelineStore, plans: PlanService, sourceExplorerThreadId: string, title: string) {
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId, title, resolvedContract: planContractFixture({ store, projectId: "project-1", title }) });
  plans.confirm(plan.id, "local-user");
  return plans.enqueue(plan.id);
}

describe("PlanService.query", () => {
  it("filters by thread lineage, keyword and queued time", () => {
    const { store, plans } = setup();
    const parentPlan = enqueue(store, plans, "explorer-parent", "Parent migration");
    enqueue(store, plans, "explorer-child", "Child cleanup");

    const query: PlanQuery = { projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: true, q: "migration", from: parentPlan.queuedAt!, to: parentPlan.queuedAt!, limit: 20, sort: "queued_at" };
    expect(plans.query(query).items.map((item) => item.title)).toEqual(["Parent migration"]);
    expect(store.listPlanQueryProjection("project-1")).toHaveLength(2);
  });

  it("每一行都带上归属需求", () => {
    // 查询投影表（plan_query_projection）没有 explorer_plan_id 这一列，必须从库里那份 plan 取。
    // 少了它，前端 belongsToExplorerPlan 会把"已派发"的方案判成不属于当前需求，
    // 于是聊天流里连方案卡都不渲染（只有 DRAFT / READY 的方案还看得见卡）。
    const { store, plans } = setup();
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-parent", explorerPlanId: "explorer-plan-1", title: "Scoped", resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Scoped" }) });
    plans.confirm(plan.id, "local-user");
    plans.enqueue(plan.id);

    const [row] = plans.query({ projectId: "project-1", includeLineage: true, limit: 20, sort: "queued_at" }).items;
    expect(row?.explorerPlanId).toBe("explorer-plan-1");
  });

  it("优先级恒为 0，翻页仍然稳定", () => {
    // 模型不提供优先级，当前形状里没有 `priority` 的容身之处——这一列实际恒为 0，
    // 排序回落到时间（同毫秒时再按 id，也就是入队顺序）。分页的正确性不受影响。
    const { store, plans } = setup();
    enqueue(store, plans, "explorer-parent", "First queued");
    enqueue(store, plans, "explorer-parent", "Second queued");
    enqueue(store, plans, "explorer-parent", "Third queued");

    const first = plans.query({ projectId: "project-1", includeLineage: true, limit: 1, sort: "priority" });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.priority).toBe(0);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = plans.query({ projectId: "project-1", includeLineage: true, cursor: first.nextCursor!, limit: 2, sort: "priority" });
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.title).sort()).toEqual(["First queued", "Second queued", "Third queued"]);
  });

  it("can exclude a thread's lineage and only returns dispatched plans", () => {
    const { store, plans } = setup();
    enqueue(store, plans, "explorer-parent", "Parent dispatched");
    const draft = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-child", title: "Child draft", resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Child draft" }) });

    expect(plans.query({ projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: false, limit: 20, sort: "last_event_at" }).items).toEqual([]);
    expect(plans.query({ projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: true, limit: 20, sort: "last_event_at" }).items.map((item) => item.title)).toEqual(["Parent dispatched"]);
    expect(draft.status).toBe("DRAFT");
  });

  it("skips a projection row whose source Plan is gone instead of failing the whole query", () => {
    // 历史脏数据只可能出现在内存实现里：SQLite 的 plan_query_projection 对 plan_id 建了外键，
    // 写不出没有源 Plan 的行（正常流程也不会产生——savePlan 的守卫与 deleteExplorerCascade
    // 的级联删除覆盖了写入和清理两侧）。这里手工写一条，锁住"一行坏数据不该让 Plan Center 500"。
    const { store, plans } = setup();
    enqueue(store, plans, "explorer-parent", "Healthy plan");
    const now = store.now();
    store.savePlanQueryProjection({ planId: "plan-orphan", projectId: "project-1", sourceExplorerThreadId: "explorer-parent", sourceTurnId: null, title: "Orphan", goal: "orphan goal", revision: 1, status: "ENQUEUED", priority: 0, createdAt: now, queuedAt: now, lastEventAt: now, runId: null, attentionReason: null });

    const result = plans.query({ projectId: "project-1", includeLineage: true, limit: 20, sort: "queued_at" });

    expect(result.items.map((item) => item.title)).toEqual(["Healthy plan"]);
  });
});
