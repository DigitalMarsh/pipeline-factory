/**
 * 测试职责：验证 Plan Center 查询的筛选、谱系、排序和游标稳定性。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, type PlanContract, type PlanQuery } from "./index.js";

function contract(title: string, priority: number): PlanContract {
  return {
    goal: `${title} goal`,
    acceptanceCriteria: ["works"],
    include: ["src"],
    exclude: [".env*"],
    baseBranch: "main",
    baseCommit: "HEAD",
    tasks: [{ id: "task-1", title, dependencies: [], status: "READY" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test"],
    maxRepairAttempts: 1,
    mergeStrategy: "manual",
    requireHumanMerge: true,
    priority,
  };
}

function setup() {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
  const plans = new PlanService(store, projects);
  plans.registerThread({ id: "explorer-parent", projectId: "project-1", parentThreadId: null });
  plans.registerThread({ id: "explorer-child", projectId: "project-1", parentThreadId: "explorer-parent" });
  return { store, plans };
}

function enqueue(plans: PlanService, sourceExplorerThreadId: string, title: string, priority: number) {
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId, title, contract: contract(title, priority) });
  plans.confirm(plan.id, "local-user");
  return plans.enqueue(plan.id);
}

describe("PlanService.query", () => {
  it("filters by thread lineage, keyword and queued time", () => {
    const { store, plans } = setup();
    const parentPlan = enqueue(plans, "explorer-parent", "Parent migration", 1);
    enqueue(plans, "explorer-child", "Child cleanup", 2);

    const query: PlanQuery = { projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: true, q: "migration", from: parentPlan.queuedAt!, to: parentPlan.queuedAt!, limit: 20, sort: "queued_at" };
    expect(plans.query(query).items.map((item) => item.title)).toEqual(["Parent migration"]);
    expect(store.listPlanQueryProjection("project-1")).toHaveLength(2);
  });

  it("sorts by priority and returns an opaque cursor for the next page", () => {
    const { plans } = setup();
    enqueue(plans, "explorer-parent", "Low priority", 1);
    enqueue(plans, "explorer-parent", "High priority", 10);
    enqueue(plans, "explorer-parent", "Medium priority", 5);

    const first = plans.query({ projectId: "project-1", includeLineage: true, limit: 1, sort: "priority" });
    expect(first.items.map((item) => item.title)).toEqual(["High priority"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = plans.query({ projectId: "project-1", includeLineage: true, cursor: first.nextCursor!, limit: 2, sort: "priority" });
    expect(second.items.map((item) => item.title)).toEqual(["Medium priority", "Low priority"]);
    expect(second.nextCursor).toBeNull();
  });

  it("can exclude a thread's lineage and only returns dispatched plans", () => {
    const { plans } = setup();
    enqueue(plans, "explorer-parent", "Parent dispatched", 1);
    const draft = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-child", title: "Child draft" });

    expect(plans.query({ projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: false, limit: 20, sort: "last_event_at" }).items).toEqual([]);
    expect(plans.query({ projectId: "project-1", explorerThreadId: "explorer-child", includeLineage: true, limit: 20, sort: "last_event_at" }).items.map((item) => item.title)).toEqual(["Parent dispatched"]);
    expect(draft.status).toBe("DRAFT");
  });
});
