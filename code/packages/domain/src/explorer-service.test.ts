import { describe, expect, it } from "vitest";
import { ExplorerService, InMemoryPipelineStore, PlanService } from "./index.js";

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
