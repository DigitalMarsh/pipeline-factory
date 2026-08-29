import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore, MergeService, PlanService, SqlitePipelineStore, VerificationService, type Run } from "./index.js";

function makeRun(planId: string): Run {
  return { id: "run-1", projectId: "project-1", planId, planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-1", workspacePath: "/tmp/run-1", baseCommit: "abc", executionThreadId: "thread-run-1", createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
}

describe("Verifier and MergeService", () => {
  it("does not verify a blocked or cancelled run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Invalid verification" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "BLOCKED";
    await expect(new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "", stderr: "" }))).rejects.toThrow(/cannot be verified/i);
    expect(store.getRun(run.id)).toBeUndefined();
  });

  it("requires verification evidence to belong to the same run before review", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Review binding" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = { id: "verification-1", runId: "other-run", status: "PASSED" as const, repairAttempts: 0, commandResults: [], completedAt: new Date().toISOString() };
    expect(() => new MergeService(store).createRequest(run, verification, "def456")).toThrow(/same run/i);
  });

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

  it("persists verification evidence in the pipeline store", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Persist verification" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    store.saveRun(run);
    const verification = await new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    expect(store.getVerificationRun(run.id)).toEqual(verification);
    expect(store.listVerificationRuns(run.id)).toHaveLength(1);
  });

  it("restores verification evidence from SQLite after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-verification-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const firstStore = new SqlitePipelineStore(databasePath);
      const plans = new PlanService(firstStore);
      const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "SQLite verification" });
      plans.confirm(plan.id, "user-1");
      const run = makeRun(plan.id);
      firstStore.saveRun(run);
      const verification = await new VerificationService(firstStore).verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
      firstStore.close();
      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getVerificationRun(run.id)).toEqual(verification);
      expect(reopened.listVerificationRuns(run.id)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("restores a merge request from the pipeline store", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Persist merge request" });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = { id: "verification-1", runId: run.id, status: "PASSED" as const, repairAttempts: 0, commandResults: [], completedAt: new Date().toISOString() };
    const request = new MergeService(store).createRequest(run, verification, "def456");
    const reopenedService = new MergeService(store);
    expect(reopenedService.findByRun(run.id)).toEqual(request);
    expect(reopenedService.confirmMerged(request.id, "def456").status).toBe("MERGED");
  });
});
