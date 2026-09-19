import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExplorerDeleteBlockedError, ExplorerService, InMemoryPipelineStore, PlanService, ProjectService, SqlitePipelineStore, type PipelineStore } from "./index.js";

const sqliteStores: SqlitePipelineStore[] = [];
const sqliteDirectories: string[] = [];

afterEach(() => {
  for (const store of sqliteStores.splice(0)) store.close();
  for (const directory of sqliteDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(kind: "memory" | "sqlite"): PipelineStore {
  if (kind === "memory") return new InMemoryPipelineStore();
  const directory = mkdtempSync(join(tmpdir(), "pipeline-explorer-delete-"));
  sqliteDirectories.push(directory);
  const store = new SqlitePipelineStore(join(directory, "factory.sqlite"));
  sqliteStores.push(store);
  return store;
}

function seedThread(store: PipelineStore, title = "Delete me") {
  const projects = new ProjectService(store);
  const project = projects.create({ id: "project-delete", name: "Delete Project", repoRoot: "/repo/delete", defaultBranch: "main", worktreeRoot: "/tmp/delete-worktrees" });
  const explorers = new ExplorerService(store);
  const explorer = explorers.create({ projectId: project.id, title });
  return { project, explorer, explorers, plans: new PlanService(store, projects) };
}

describe("ExplorerService.delete", () => {
  it.each(["memory", "sqlite"] as const)("cascades thread business data and keeps audit events in %s storage", (kind) => {
    const store = createStore(kind);
    const { project, explorer, explorers, plans } = seedThread(store);
    const replacement = explorers.create({ projectId: project.id, title: "Keep me" });
    const explorerPlanId = store.listExplorerPlans(explorer.id)[0]!.id;
    const candidate = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "Delete plan" });
    const turn = store.saveTurn({ id: "delete-turn", threadId: explorer.id, role: "user", content: "delete this", status: "COMPLETED", createdAt: store.now(), sequence: 1, explorerPlanId });
    store.saveInputRequest({ id: "delete-input", threadId: explorer.id, explorerPlanId, localTurnId: turn.id, providerRequestId: "request-1", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", itemId: "item-1", questions: [], isBlocking: false, autoResolutionMs: null, status: "ANSWERED", createdAt: store.now(), answeredAt: store.now(), answeredBy: "test", redactedAnswerSummary: null });
    const executionThreadId = "delete-execution-thread";
    store.saveExecutionThread({ id: executionThreadId, runId: "delete-run", state: "COMPLETED", journal: [] });
    store.saveRun({ id: "delete-run", projectId: project.id, planId: candidate.id, planRevision: 1, status: "CANCELLED", branch: "factory/delete-run", workspacePath: "/tmp/left-behind-worktree", baseCommit: "HEAD", executionThreadId, createdAt: store.now(), startedAt: store.now() });
    store.saveAgentLoop({ id: "delete-loop", ownerType: "explorer-turn", ownerId: turn.id, role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 4, startedAt: store.now(), completedAt: store.now(), providerThreadId: null, providerTurnId: null, checkpointJson: null });

    const result = explorers.delete(explorer.id);

    expect(result.replacementExplorer.id).toBe(replacement.id);
    expect(result.deleted).toEqual({ taskCount: 1, planCount: 1, runCount: 1 });
    expect(store.getThread(explorer.id)).toBeUndefined();
    expect(store.listExplorerPlans(explorer.id)).toEqual([]);
    expect(store.getPlan(candidate.id)).toBeUndefined();
    expect(store.listTurns(explorer.id)).toEqual([]);
    expect(store.listInputRequests(explorer.id)).toEqual([]);
    expect(store.getRun("delete-run")).toBeUndefined();
    expect(store.getExecutionThread(executionThreadId)).toBeUndefined();
    expect(store.getAgentLoop("delete-loop")).toBeUndefined();
    expect(store.getProject(project.id)?.currentExplorerThreadId).toBe(replacement.id);
    expect(store.listEvents({ aggregateId: explorer.id }).some((event) => event.type === "explorer.deleted")).toBe(true);
  });

  it("creates a replacement Explorer when deleting the last active thread", () => {
    const store = new InMemoryPipelineStore();
    const { project, explorer, explorers } = seedThread(store, "Last thread");

    const result = explorers.delete(explorer.id);

    expect(result.replacementExplorer.id).not.toBe(explorer.id);
    expect(result.replacementExplorer.contextMode).toBe("FRESH");
    expect(store.getProject(project.id)?.currentExplorerThreadId).toBe(result.replacementExplorer.id);
    expect(store.listThreads().map((item) => item.id)).toEqual([result.replacementExplorer.id]);
  });

  it("rejects an active Run or Explorer Loop before deleting anything", () => {
    const store = new InMemoryPipelineStore();
    const { project, explorer, explorers, plans } = seedThread(store);
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, title: "Active plan" });
    store.saveRun({ id: "active-run", projectId: project.id, planId: plan.id, planRevision: 1, status: "IN_PROGRESS", branch: "factory/active-run", workspacePath: "/tmp/active-worktree", baseCommit: "HEAD", executionThreadId: "active-execution-thread", createdAt: store.now(), startedAt: store.now() });

    expect(() => explorers.delete(explorer.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getThread(explorer.id)).toBeDefined();
    expect(store.getPlan(plan.id)).toBeDefined();
    expect(store.getRun("active-run")).toBeDefined();

    store.saveRun({ ...store.getRun("active-run")!, status: "CANCELLED" });
    const turn = store.saveTurn({ id: "active-turn", threadId: explorer.id, role: "user", content: "wait", status: "RUNNING", createdAt: store.now(), sequence: 1 });
    store.saveAgentLoop({ id: "active-loop", ownerType: "explorer-turn", ownerId: turn.id, role: "explorer", mode: "provider-controlled", state: "PAUSED", stepCount: 1, maxSteps: 4, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });

    expect(() => explorers.delete(explorer.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getThread(explorer.id)).toBeDefined();
    expect(store.getAgentLoop("active-loop")).toBeDefined();
  });
});
