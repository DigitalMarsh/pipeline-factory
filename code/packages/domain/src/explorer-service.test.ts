/**
 * 测试职责：验证 explorer-service 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { ExplorerService, InMemoryPipelineStore, PlanService, ProjectService } from "./index.js";

describe("ExplorerService", () => {
  it("creates a fresh business Explorer without inheriting old turns or plans", () => {
    const store = new InMemoryPipelineStore();
    const explorers = new ExplorerService(store);
    const plans = new PlanService(store);
    const oldExplorer = explorers.create({ projectId: "project-1", title: "Old design" });
    store.saveTurn({ id: "old-turn", threadId: oldExplorer.id, role: "user", content: "old requirement", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    const oldPlan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: oldExplorer.id, title: "Old plan" });
    plans.confirm(oldPlan.id, "user-1");
    plans.enqueue(oldPlan.id);

    const fresh = explorers.create({ projectId: "project-1" });

    expect(fresh.id).not.toBe(oldExplorer.id);
    expect(fresh.contextMode).toBe("FRESH");
    expect(fresh.providerThreadId).toBeNull();
    expect(store.listTurns(fresh.id)).toEqual([]);
    expect(plans.listThreadPlans(fresh.id)).toEqual([]);
    expect(explorers.list("project-1").map((item) => item.id)).toEqual([fresh.id, oldExplorer.id]);
  });

  it("keeps exactly one active Explorer per Project and updates the selected Explorer", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
    const explorers = new ExplorerService(store);

    const first = explorers.create({ projectId: "project-1", title: "First" });
    const second = explorers.create({ projectId: "project-1", title: "Second" });

    expect(store.getThread(first.id)?.state).toBe("ARCHIVED");
    expect(store.getThread(second.id)?.state).toBe("ACTIVE");
    expect(projects.get("project-1").currentExplorerThreadId).toBe(second.id);
  });

  it("archives an Explorer without deleting its history", () => {
    const store = new InMemoryPipelineStore();
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: "project-1", title: "Archive me" });
    store.saveTurn({ id: "turn-1", threadId: explorer.id, role: "user", content: "keep this", status: "COMPLETED", createdAt: store.now(), sequence: 1 });

    const archived = explorers.archive(explorer.id);

    expect(archived.state).toBe("ARCHIVED");
    expect(store.listTurns(explorer.id)[0]?.content).toBe("keep this");
    expect(explorers.get(explorer.id).state).toBe("ARCHIVED");
  });
});
