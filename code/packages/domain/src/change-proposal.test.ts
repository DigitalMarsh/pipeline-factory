import { describe, expect, it } from "vitest";
import { ChangeProposalService, InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler } from "./index.js";

describe("ChangeProposalService", () => {
  it("approves a scope change as a new immutable revision and starts a new run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Original plan" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/change-proposal", branch: "factory/change-proposal", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const run = await scheduler.start(plan.id);
    const revisedContract = { ...plan.contract, include: [...plan.contract.include, "docs/*"] };
    const proposals = new ChangeProposalService(store);
    const proposal = proposals.create({ runId: run.id, reason: "The acceptance scope includes documentation", requestedChanges: ["Add docs to include scope"], contract: revisedContract });

    expect(store.getRun(run.id)?.status).toBe("NEEDS_PLAN_CHANGE");
    const approved = await proposals.approve(proposal.id, "user-2", (planId) => scheduler.start(planId));

    expect(approved.proposal.status).toBe("APPROVED");
    expect(approved.revision.revision).toBe(2);
    expect(approved.revision.contract.include).toContain("docs/*");
    expect(approved.plan.status).toBe("IN_PROGRESS");
    expect(approved.run).toMatchObject({ planId: plan.id, planRevision: 2 });
    expect(store.getRun(run.id)?.planRevision).toBe(1);
  });

  it("does not mutate an approved proposal or create a second run on retry", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Retry proposal" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const run = store.saveRun({ id: "run-1", projectId: "project-1", planId: plan.id, planRevision: 1, status: "NEEDS_PLAN_CHANGE", branch: "factory/run-1", workspacePath: "/tmp/run-1", baseCommit: "abc", executionThreadId: "thread-run-1", createdAt: store.now(), startedAt: store.now() });
    const proposals = new ChangeProposalService(store);
    const proposal = proposals.create({ runId: run.id, reason: "Need another task", requestedChanges: ["Add task"], contract: { ...plan.contract, tasks: [...plan.contract.tasks, { id: "task-2", title: "Another task", dependencies: ["task-1"], status: "PENDING" }] } });
    const first = await proposals.approve(proposal.id, "user-2");
    const second = await proposals.approve(proposal.id, "user-2");

    expect(second).toEqual(first);
    expect(store.listAgentLoops()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(1);
  });
});
