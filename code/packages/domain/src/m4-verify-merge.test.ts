import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, MergeService, PlanService, VerificationService, type Run } from "./index.js";

function makeRun(planId: string): Run {
  return { id: "run-1", projectId: "project-1", planId, planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-1", workspacePath: "/tmp/run-1", baseCommit: "abc", executionThreadId: "thread-run-1", createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
}

describe("Verifier and MergeService", () => {
  it("repairs a failed verification within the revision limit and creates merge evidence", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Verify and merge" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    let attempts = 0;
    const verification = await new VerificationService().verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: ++attempts === 1 ? 1 : 0, stdout: "", stderr: "" }), async () => true);
    expect(verification.status).toBe("PASSED");
    expect(verification.repairAttempts).toBe(1);
    expect(run.status).toBe("MERGE_READY");
    const merge = new MergeService(store);
    const request = merge.createRequest(run, verification, "def456");
    expect(() => merge.confirmMerged(request.id, "wrong-commit")).toThrow(/target commit/i);
    expect(merge.confirmMerged(request.id, "def456").status).toBe("MERGED");
    expect(plans.get(plan.id).status).toBe("MERGED");
  });

  it("blocks verification after the configured repair limit", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Stay blocked" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    const verification = await new VerificationService().verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 1, stdout: "", stderr: "still failing" }), async () => false);
    expect(verification).toMatchObject({ status: "BLOCKED", repairAttempts: 2 });
    expect(run.status).toBe("BLOCKED");
  });

  it("uses the frozen plan base branch as the merge target", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Use project branch" });
    store.updatePlan({ ...plan, contract: { ...plan.contract, baseBranch: "trunk" } });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = { id: "verification-1", runId: run.id, status: "PASSED" as const, repairAttempts: 0, commandResults: [], completedAt: new Date().toISOString() };
    const request = new MergeService(store).createRequest(run, verification, "def456");
    expect(request.targetBranch).toBe("trunk");
  });
});
