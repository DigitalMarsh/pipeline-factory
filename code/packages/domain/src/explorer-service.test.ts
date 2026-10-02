/**
 * 测试职责：验证 explorer-service 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { ExplorerService, ExplorerThreadService, InMemoryPipelineStore, PlanService, ProjectService, StubModelGateway } from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

describe("ExplorerService", () => {
  it("creates a fresh business Explorer without inheriting old turns or plans", () => {
    const store = new InMemoryPipelineStore();
    const explorers = new ExplorerService(store);
    const plans = new PlanService(store);
    const oldExplorer = explorers.create({ projectId: "project-1", title: "Old design" });
    store.saveTurn({ id: "old-turn", threadId: oldExplorer.id, role: "user", content: "old requirement", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    const oldPlan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: oldExplorer.id, title: "Old plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Old plan" }) });
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

  it("names a new Explorer with its creation timestamp and lets an explicit title win", () => {
    const store = new InMemoryPipelineStore();
    const explorers = new ExplorerService(store);

    // 默认标题**本来就带创建时刻**（"探索-YYYYMMDD-HH:MM:SS"，见 explorer-title.ts 的
    // placeholderExplorerTitle）：线程按天分组、按时间找人靠的就是它。首条消息之后模型会把它
    // 升级成"时间-内容摘要"，那是增强而不是改名。
    const explorer = explorers.create({ projectId: "project-1" });
    expect(explorer.title).toMatch(/^探索-\d{8}-\d{2}:\d{2}:\d{2}$/);
    // 项目存在时前缀会换成项目简称（"P1-20261001-…"），这里没建项目，所以是通用前缀。
    expect(explorer).toMatchObject({ titleSource: "AUTO", titleStatus: "GENERATED" });

    // 显式标题优先（用户手填或从别的线程继承）。
    expect(explorers.create({ projectId: "project-1", title: "  手填标题  " }).title).toBe("手填标题");
  });

  it("keeps multiple active Explorers and updates only the selected Explorer", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
    const explorers = new ExplorerService(store);

    const first = explorers.create({ projectId: "project-1", title: "First" });
    const second = explorers.create({ projectId: "project-1", title: "Second" });

    expect(store.getThread(first.id)?.state).toBe("ACTIVE");
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

  it("rejects archiving the Project's current Explorer", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: "project-1", title: "Current Explorer" });

    expect(() => explorers.archive(explorer.id)).toThrow("Current Explorer cannot be archived");
    expect(store.getThread(explorer.id)?.state).toBe("ACTIVE");
  });

  it("rejects new turns for an archived Explorer", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1", title: "Archived Explorer" });
    store.updateThread({ ...explorer, state: "ARCHIVED" });
    const service = new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "explorer" }, executor: { model: "executor" } }));

    await expect(service.startTurn({ threadId: explorer.id, explorerPlanId: store.listExplorerPlans(explorer.id)[0]!.id, content: "继续探索", clientTurnId: "archived-turn" })).rejects.toThrow("ExplorerThread " + explorer.id + " is archived");
    expect(store.listTurns(explorer.id)).toEqual([]);
  });
});
