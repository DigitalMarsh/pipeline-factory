import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExplorerDeleteBlockedError,
  ExplorerService,
  InMemoryPipelineStore,
  PlanService,
  ProjectService,
  SqlitePipelineStore,
  type PipelineStore,
  type Run,
} from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

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
  const project = projects.create({
    id: "project-delete",
    name: "Delete Project",
    repoRoot: "/repo/delete",
    defaultBranch: "main",
    worktreeRoot: "/tmp/delete-worktrees",
  });
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
    const candidate = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: explorer.id,
      explorerPlanId,
      title: "Delete plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Delete plan" }),
    });
    const turn = store.saveTurn({
      id: "delete-turn",
      threadId: explorer.id,
      role: "user",
      content: "delete this",
      status: "COMPLETED",
      createdAt: store.now(),
      sequence: 1,
      explorerPlanId,
    });
    store.saveInputRequest({
      id: "delete-input",
      threadId: explorer.id,
      explorerPlanId,
      localTurnId: turn.id,
      providerRequestId: "request-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      itemId: "item-1",
      questions: [],
      isBlocking: false,
      status: "ANSWERED",
      createdAt: store.now(),
      answeredAt: store.now(),
      answeredBy: "test",
      redactedAnswerSummary: null,
    });
    const executionThreadId = "delete-execution-thread";
    store.saveExecutionThread({ id: executionThreadId, runId: "delete-run", state: "COMPLETED", journal: [] });
    store.saveRun({
      id: "delete-run",
      projectId: project.id,
      planId: candidate.id,
      planRevision: 1,
      status: "CANCELLED",
      branch: "factory/delete-run",
      workspacePath: "/tmp/left-behind-worktree",
      baseCommit: "HEAD",
      executionThreadId,
      createdAt: store.now(),
      startedAt: store.now(),
    });
    store.saveAgentLoop({
      id: "delete-loop",
      ownerType: "explorer-turn",
      ownerId: turn.id,
      role: "explorer",
      mode: "provider-controlled",
      state: "COMPLETED",
      stepCount: 1,
      maxSteps: 4,
      startedAt: store.now(),
      completedAt: store.now(),
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });

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
    const plan = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: explorer.id,
      title: "Active plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Active plan" }),
    });
    store.saveRun({
      id: "active-run",
      projectId: project.id,
      planId: plan.id,
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/active-run",
      workspacePath: "/tmp/active-worktree",
      baseCommit: "HEAD",
      executionThreadId: "active-execution-thread",
      createdAt: store.now(),
      startedAt: store.now(),
    });

    expect(() => explorers.delete(explorer.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getThread(explorer.id)).toBeDefined();
    expect(store.getPlan(plan.id)).toBeDefined();
    expect(store.getRun("active-run")).toBeDefined();

    store.saveRun({ ...store.getRun("active-run")!, status: "CANCELLED" });
    const turn = store.saveTurn({
      id: "active-turn",
      threadId: explorer.id,
      role: "user",
      content: "wait",
      status: "RUNNING",
      createdAt: store.now(),
      sequence: 1,
    });
    store.saveAgentLoop({
      id: "active-loop",
      ownerType: "explorer-turn",
      ownerId: turn.id,
      role: "explorer",
      mode: "provider-controlled",
      state: "PAUSED",
      stepCount: 1,
      maxSteps: 4,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });

    expect(() => explorers.delete(explorer.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getThread(explorer.id)).toBeDefined();
    expect(store.getAgentLoop("active-loop")).toBeDefined();
  });
});

/** 一条线程 + 三条需求（第一条是 saveThread 自带的，后两条显式新建）。 */
function seedRequirementThread(store: PipelineStore) {
  const { project, explorer, explorers, plans } = seedThread(store, "Shared thread");
  const first = store.listExplorerPlans(explorer.id)[0]!;
  const second = explorers.createPlan(explorer.id);
  const third = explorers.createPlan(explorer.id);
  return { project, explorer: explorers.get(explorer.id), explorers, plans, first, second, third };
}

/** 给一条需求摆上"跑过一次"的痕迹：回合 + 候选方案 + Run + 执行线程 + loop。 */
function seedExecutedRequirement(
  store: PipelineStore,
  input: { projectId: string; explorerId: string; explorerPlanId: string; name: string; sequence: number; runStatus?: Run["status"] },
) {
  const turn = store.saveTurn({
    id: `${input.name}-turn`,
    threadId: input.explorerId,
    role: "user",
    content: input.name,
    status: "COMPLETED",
    createdAt: store.now(),
    sequence: input.sequence,
    explorerPlanId: input.explorerPlanId,
  });
  const plan = new PlanService(store).createCandidatePlan({
    projectId: input.projectId,
    sourceExplorerThreadId: input.explorerId,
    explorerPlanId: input.explorerPlanId,
    title: `${input.name} plan`,
    resolvedContract: planContractFixture({ store, projectId: input.projectId, title: `${input.name} plan` }),
  });
  const executionThreadId = `${input.name}-execution-thread`;
  store.saveExecutionThread({ id: executionThreadId, runId: `${input.name}-run`, state: "COMPLETED", journal: [] });
  const run = store.saveRun({
    id: `${input.name}-run`,
    projectId: input.projectId,
    planId: plan.id,
    planRevision: 1,
    status: input.runStatus ?? "CANCELLED",
    branch: `factory/${input.name}`,
    workspacePath: `/tmp/${input.name}-worktree`,
    baseCommit: "HEAD",
    executionThreadId,
    createdAt: store.now(),
    startedAt: store.now(),
  });
  store.saveAgentLoop({
    id: `${input.name}-loop`,
    ownerType: "explorer-turn",
    ownerId: turn.id,
    role: "explorer",
    mode: "provider-controlled",
    state: "COMPLETED",
    stepCount: 1,
    maxSteps: 4,
    startedAt: store.now(),
    completedAt: store.now(),
    providerThreadId: null,
    providerTurnId: null,
    checkpointJson: null,
  });
  return { turn, plan, run, executionThreadId };
}

describe("ExplorerService.deletePlan", () => {
  it.each(["memory", "sqlite"] as const)(
    "**只删那一条**：同线程其他需求的回合、方案、事件一条不少，线程行的指针落到剩下的最后一条（%s）",
    (kind) => {
      const store = createStore(kind);
      const { project, explorer, explorers, first, second, third } = seedRequirementThread(store);
      const middle = seedExecutedRequirement(store, {
        projectId: project.id,
        explorerId: explorer.id,
        explorerPlanId: second.id,
        name: "middle",
        sequence: 1,
      });
      const kept = seedExecutedRequirement(store, {
        projectId: project.id,
        explorerId: explorer.id,
        explorerPlanId: third.id,
        name: "kept",
        sequence: 2,
      });
      // 线程行先摆成"最后评估过中间那条"（thread-service 每轮就是这么写的）。
      const thread = store.getThread(explorer.id)!;
      store.updateExplorerPlan({ ...store.getExplorerPlan(third.id)!, candidatePlanId: kept.plan.id, lastAssessedTurnId: kept.turn.id });
      store.updateThread({
        ...thread,
        messageCount: 2,
        exploration: { ...thread.exploration, candidatePlanId: middle.plan.id, lastAssessedTurnId: middle.turn.id },
        contextSummary: {
          ...thread.contextSummary!,
          openPlanIds: [first.id, second.id, third.id],
          completedPlans: [
            {
              explorerPlanId: second.id,
              title: "middle",
              status: "READY",
              goal: null,
              keyConstraints: [],
              latestUserMessageSummary: "middle",
            },
            { explorerPlanId: third.id, title: "kept", status: "READY", goal: null, keyConstraints: [], latestUserMessageSummary: "kept" },
          ],
        },
      });

      const result = explorers.deletePlan(explorer.id, second.id);

      expect(result.deleted).toEqual({ taskCount: 1, planCount: 1, runCount: 1 });
      expect(result.explorerPlans.map((plan) => plan.id)).toEqual([first.id, third.id]);
      // 那条需求名下的东西全没了
      expect(store.getExplorerPlan(second.id)).toBeUndefined();
      expect(store.getPlan(middle.plan.id)).toBeUndefined();
      expect(store.getRun("middle-run")).toBeUndefined();
      expect(store.getExecutionThread(middle.executionThreadId)).toBeUndefined();
      expect(store.getAgentLoop("middle-loop")).toBeUndefined();
      expect(store.listTurns(explorer.id).map((turn) => turn.id)).toEqual([kept.turn.id]);
      // 同线程其他需求一条不少，线程本身也还在
      expect(store.getPlan(kept.plan.id)).toBeDefined();
      expect(store.getRun("kept-run")).toBeDefined();
      expect(store.getAgentLoop("kept-loop")).toBeDefined();
      expect(store.getThread(explorer.id)).toBeDefined();
      // 落点：镜像剩下的最后一条需求，而不是置空
      const updated = store.getThread(explorer.id)!;
      expect(updated.exploration.candidatePlanId).toBe(kept.plan.id);
      expect(updated.exploration.lastAssessedTurnId).toBe(kept.turn.id);
      expect(updated.messageCount).toBe(1);
      expect(updated.activeExplorerPlanId).toBe(third.id);
      expect(updated.contextSummary?.openPlanIds).toEqual([first.id, third.id]);
      expect(updated.contextSummary?.completedPlans.map((item) => item.explorerPlanId)).toEqual([third.id]);
      expect(store.listEvents({ aggregateId: explorer.id }).some((event) => event.type === "explorer.plan.deleted")).toBe(true);
    },
  );

  it.each(["memory", "sqlite"] as const)("删掉当前选中的那条时，活动需求落到剩下的最后一条上（%s）", (kind) => {
    const store = createStore(kind);
    const { explorer, explorers, second, third } = seedRequirementThread(store);
    explorers.activatePlan(explorer.id, third.id);

    const result = explorers.deletePlan(explorer.id, third.id);

    // 剩下的按 ordinal 是"第一条"与"第二条"，取最后一条（序号最大的那条需求）。
    expect(result.explorer.activeExplorerPlanId).toBe(second.id);
    expect(store.getThread(explorer.id)?.activeExplorerPlanId).toBe(second.id);
  });

  it.each(["memory", "sqlite"] as const)("有在跑的 Run / Loop 就拒，且**一行都没删**（%s）", (kind) => {
    const store = createStore(kind);
    const { project, explorer, explorers, second } = seedRequirementThread(store);
    const before = store.listExplorerPlans(explorer.id).map((plan) => plan.id);
    const running = seedExecutedRequirement(store, {
      projectId: project.id,
      explorerId: explorer.id,
      explorerPlanId: second.id,
      name: "running",
      sequence: 1,
      runStatus: "IN_PROGRESS",
    });

    expect(() => explorers.deletePlan(explorer.id, second.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getExplorerPlan(second.id)).toBeDefined();
    expect(store.getPlan(running.plan.id)).toBeDefined();
    expect(store.getRun("running-run")).toBeDefined();
    expect(store.listExplorerPlans(explorer.id).map((plan) => plan.id)).toEqual(before);
    expect(store.listEvents({ aggregateId: explorer.id }).some((event) => event.type === "explorer.plan.deleted")).toBe(false);

    // Loop 那一侧同样拦得住：Run 停了，但回合上的探索 loop 还 PAUSED。
    store.saveRun({ ...store.getRun("running-run")!, status: "CANCELLED" });
    store.saveAgentLoop({ ...store.getAgentLoop("running-loop")!, state: "PAUSED" });
    expect(() => explorers.deletePlan(explorer.id, second.id)).toThrow(ExplorerDeleteBlockedError);
    expect(store.getExplorerPlan(second.id)).toBeDefined();
  });

  /**
   * 放行的是"跑过但已经停了"的那些。
   * **`MERGED` 不在这一串里**：它是 Plan 的状态，Run 上不存在（合并后 Plan 变 MERGED，
   * Run 停在 `MERGE_READY`）——所以"已合并的需求"在这里就是 `MERGE_READY` + 已合并的 Plan，
   * 允许删，代价由确认框写明。
   */
  it.each(["MERGE_READY", "CANCELLED", "BLOCKED", "STALE", "NEEDS_PLAN_CHANGE"] as const)(
    "**跑过但已经停了的都放行**（与「删除线程」同一把尺）：%s",
    (status) => {
      const store = createStore("memory");
      const { project, explorer, explorers, second } = seedRequirementThread(store);
      const done = seedExecutedRequirement(store, {
        projectId: project.id,
        explorerId: explorer.id,
        explorerPlanId: second.id,
        name: "done",
        sequence: 1,
        runStatus: status,
      });

      explorers.deletePlan(explorer.id, second.id);

      expect(store.getExplorerPlan(second.id)).toBeUndefined();
      expect(store.getRun(done.run.id)).toBeUndefined();
      expect(store.getPlan(done.plan.id)).toBeUndefined();
    },
  );

  it("**最后一条需求不给删**：删了线程就没有需求，listPlans() 会当场补一条空的，用户看到的是「删了但没变」", () => {
    const store = new InMemoryPipelineStore();
    const { explorer, explorers, first, second, third } = seedRequirementThread(store);
    explorers.deletePlan(explorer.id, first.id);
    explorers.deletePlan(explorer.id, second.id);

    expect(store.listExplorerPlans(explorer.id).map((plan) => plan.id)).toEqual([third.id]);
    expect(() => explorers.deletePlan(explorer.id, third.id)).toThrow(/last ExplorerPlan/i);
    expect(store.listExplorerPlans(explorer.id).map((plan) => plan.id)).toEqual([third.id]);
  });

  it("别的线程的需求删不动：归属校验在服务层", () => {
    const store = new InMemoryPipelineStore();
    const { explorer, explorers } = seedRequirementThread(store);
    const other = explorers.create({ projectId: store.getThread(explorer.id)!.projectId, title: "Another thread" });
    const foreign = store.listExplorerPlans(other.id)[0]!;

    expect(() => explorers.deletePlan(explorer.id, foreign.id)).toThrow(/does not belong/i);
    expect(store.getExplorerPlan(foreign.id)).toBeDefined();
  });
});
