/**
 * 测试职责：验证 change-proposal 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeProposalService, InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, SqlitePipelineStore } from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

describe("ChangeProposalService", () => {
  it("approves a scope change as a new immutable revision that requires manual dispatch", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Original plan",
      resolvedContract: planContractFixture({ title: "Original plan" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    plans.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/change-proposal", branch: "factory/change-proposal", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const run = await scheduler.start(plan.id);
    const revisedContract = {
      ...plan.resolvedContract,
      scope: { ...plan.resolvedContract.scope, includePaths: [...plan.resolvedContract.scope.includePaths, "docs/*"] },
    };
    const proposals = new ChangeProposalService(store);
    const proposal = proposals.create({
      runId: run.id,
      reason: "The acceptance scope includes documentation",
      requestedChanges: ["Add docs to include scope"],
      resolvedContract: revisedContract,
    });

    expect(store.getRun(run.id)?.status).toBe("NEEDS_PLAN_CHANGE");
    const approved = await proposals.approve(proposal.id, "user-2");

    expect(approved.proposal.status).toBe("APPROVED");
    expect(approved.revision.revision).toBe(2);
    expect(approved.revision.resolvedContract.scope.includePaths).toContain("docs/*");
    expect(approved.plan).toMatchObject({ status: "ENQUEUED", dispatchedAt: null, runId: null });
    expect(approved.run).toBeNull();
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun(run.id)?.planRevision).toBe(1);

    expect(
      store
        .listEvents({ afterSequence: 0 })
        .filter((event) => event.type === "plan.status.changed")
        .map((event) => event.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromStatus: "DRAFT", toStatus: "READY", revision: 1 }),
        expect.objectContaining({ fromStatus: "READY", toStatus: "ENQUEUED", revision: 1 }),
        expect.objectContaining({ fromStatus: "ENQUEUED", toStatus: "DISPATCHED", revision: 1 }),
        expect.objectContaining({ fromStatus: "DISPATCHED", toStatus: "IN_PROGRESS", revision: 1 }),
        expect.objectContaining({
          fromStatus: "IN_PROGRESS",
          toStatus: "NEEDS_PLAN_CHANGE",
          reason: "The acceptance scope includes documentation",
        }),
        expect.objectContaining({ fromStatus: "NEEDS_PLAN_CHANGE", toStatus: "ENQUEUED", revision: 2 }),
      ]),
    );
  });

  it("does not mutate an approved proposal or create a second run on retry", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Retry proposal",
      resolvedContract: planContractFixture({ title: "Retry proposal" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    plans.dispatch(plan.id);
    const run = store.saveRun({
      id: "run-1",
      projectId: "project-1",
      planId: plan.id,
      planRevision: 1,
      status: "NEEDS_PLAN_CHANGE",
      branch: "factory/run-1",
      workspacePath: "/tmp/run-1",
      baseCommit: "abc",
      executionThreadId: "thread-run-1",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    const proposals = new ChangeProposalService(store);
    const proposal = proposals.create({
      runId: run.id,
      reason: "Need another task",
      requestedChanges: ["Add task"],
      resolvedContract: {
        ...plan.resolvedContract,
        tasks: [...plan.resolvedContract.tasks, { id: "task-2", title: "Another task", dependencies: ["task-1"], status: "PENDING" }],
      },
    });
    const first = await proposals.approve(proposal.id, "user-2");
    const second = await proposals.approve(proposal.id, "user-2");

    expect(second).toEqual(first);
    expect(store.listAgentLoops()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(1);
  });
});

/**
 * 内存实现只是"形状对"，落库才是提案真正被消费的路径。这一组存在的原因很具体：
 * 提案的契约此前存的是 V1 镜像列 `contract_json`，改成 `resolved_contract_json` 时**漏了建表**，
 * 而内存实现不经过 SQL 列，所有用例照样绿——只有真开一个 SQLite 库才暴露得出来。
 */
describe("ChangeProposalService（SQLite）", () => {
  it("提案的契约经落库往返后一字不差", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-change-proposal-"));
    try {
      const store = new SqlitePipelineStore(join(directory, "factory.sqlite"));
      try {
        const plans = new PlanService(store);
        const plan = plans.createCandidatePlan({
          projectId: "project-1",
          sourceExplorerThreadId: "thread-1",
          title: "Persisted proposal",
          resolvedContract: planContractFixture({ title: "Persisted proposal" }),
        });
        plans.confirm(plan.id, "user-1");
        plans.enqueue(plan.id);
        plans.dispatch(plan.id);
        const run = store.saveRun({
          id: "run-1",
          projectId: "project-1",
          planId: plan.id,
          planRevision: 1,
          status: "NEEDS_PLAN_CHANGE",
          branch: "factory/run-1",
          workspacePath: "/tmp/run-1",
          baseCommit: "abc",
          executionThreadId: "thread-run-1",
          createdAt: store.now(),
          startedAt: store.now(),
        });
        const proposals = new ChangeProposalService(store);

        const created = proposals.create({
          runId: run.id,
          reason: "Scope grew",
          requestedChanges: ["Include docs"],
          resolvedContract: { ...plan.resolvedContract, dependsOnPlanIds: [] },
        });

        expect(store.getChangeProposal(created.id)?.resolvedContract).toEqual(created.resolvedContract);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
