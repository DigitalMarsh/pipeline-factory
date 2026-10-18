/**
 * 测试职责：验证 m4-verify-merge 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryPipelineStore,
  MergeService,
  PlanService,
  ProjectService,
  SqlitePipelineStore,
  VerificationService,
  type ExecutionThread,
  type Run,
} from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

/**
 * 布置前置条件：把 Plan 直接摆成"已验证、等人合并"。
 *
 * **故意走 `store.updatePlan` 而不是 `updatePlanStatus`**：后者现在有转换守卫（非法转换抛错），
 * 而这里要的只是"先把状态摆好"，不是"验证一次转换"——真跑一遍
 * `enqueue → dispatch → IN_PROGRESS → VERIFYING` 与本用例要考的东西无关。
 * 同文件下面那条"同步 Plan 投影"的用例本来就是这个写法。
 */
function arrangeMergeReadyPlan(store: InMemoryPipelineStore, planId: string, runId: string): void {
  const plan = store.getPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found`);
  store.updatePlan({ ...plan, status: "MERGE_READY", runId, attentionReason: null });
}

function makeRun(planId: string): Run {
  return {
    id: "run-1",
    projectId: "project-1",
    planId,
    planRevision: 1,
    status: "IN_PROGRESS",
    branch: "factory/run-1",
    workspacePath: "/tmp/run-1",
    baseCommit: "abc",
    executionThreadId: "thread-run-1",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
}

describe("Verifier and MergeService", () => {
  it("does not verify a blocked or cancelled run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Invalid verification",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Invalid verification" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "BLOCKED";
    await expect(
      new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    ).rejects.toThrow(/cannot be verified/i);
    expect(store.getRun(run.id)).toBeUndefined();
  });

  /**
   * **成功收尾之前先把工作区提交到分支上。** 不提交的话 `MERGE_READY` 就是一句空话：分支上一个
   * 提交都没有，人照界面的提示点「确认合并」，合并过去什么都没有——实测踩过（`run-b7cd26ff-c11`
   * 的修复一直躺在工作区里，分支 tip 等于 main tip）。
   */
  describe("成功收尾前提交工作区", () => {
    const arrange = () => {
      const store = new InMemoryPipelineStore();
      const plans = new PlanService(store);
      const plan = plans.createCandidatePlan({
        projectId: "project-1",
        sourceExplorerThreadId: "thread-1",
        title: "Commit before merge",
        resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Commit before merge" }),
      });
      plans.confirm(plan.id, "user-1");
      const run = makeRun(plan.id);
      // Plan 只在 `plan.runId === run.id` 时才跟着走（见 verification.ts 维护提示 3），夹具里补上。
      store.updatePlan({ ...store.getPlan(plan.id)!, status: "VERIFYING", runId: run.id });
      return { store, plans, plan, run };
    };

    it("提交发生在 MERGE_READY **之前**（提交那一刻 Run 还在 VERIFYING）", async () => {
      const { store, plans, plan, run } = arrange();
      const seen: Array<{ runId: string; revision: number; statusAtCommit: string }> = [];
      const verifier = new VerificationService(store, {
        commitWorkspace: async (committingRun, revision) => {
          seen.push({ runId: committingRun.id, revision: revision.revision, statusAtCommit: committingRun.status });
        },
      });

      const verification = await verifier.verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "", stderr: "" }));

      expect(verification.status).toBe("PASSED");
      expect(seen).toEqual([{ runId: run.id, revision: 1, statusAtCommit: "VERIFYING" }]);
      expect(store.getRun(run.id)?.status).toBe("MERGE_READY");
    });

    it("没有验证命令（SKIPPED）也要提交——那也是成功收尾", async () => {
      const store = new InMemoryPipelineStore();
      const plans = new PlanService(store);
      const plan = plans.createCandidatePlan({
        projectId: "project-1",
        sourceExplorerThreadId: "thread-1",
        title: "No commands",
        resolvedContract: planContractFixture({ store, projectId: "project-1", title: "No commands" }),
      });
      store.updatePlan({
        ...plan,
        resolvedContract: { ...plan.resolvedContract, verification: { mode: "NONE", commandIds: [] } },
      });
      plans.confirm(plan.id, "user-1");
      const run = makeRun(plan.id);
      let commits = 0;
      const verifier = new VerificationService(store, { commitWorkspace: async () => void (commits += 1) });

      const verification = await verifier.verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "", stderr: "" }));

      expect(verification).toMatchObject({ status: "SKIPPED", reason: "NO_PROJECT_VERIFICATION_COMMANDS" });
      expect(commits).toBe(1);
      expect(store.getRun(run.id)?.status).toBe("MERGE_READY");
    });

    it("提交失败就把 Run 打成 BLOCKED，理由原样说出来（最常见的：仓库没配 git 身份）", async () => {
      const { store, plans, plan, run } = arrange();
      const verifier = new VerificationService(store, {
        commitWorkspace: async () => {
          throw new Error("Git commit failed in /tmp/run-1: fatal: unable to auto-detect email address");
        },
      });

      const verification = await verifier.verify(run, plans.getRevision(plan.id, 1), async () => ({ exitCode: 0, stdout: "", stderr: "" }));

      expect(verification.status).toBe("BLOCKED");
      expect(store.getRun(run.id)?.status).toBe("BLOCKED");
      expect(store.getPlan(plan.id)?.attentionReason).toContain("工作区提交失败");
      expect(store.getPlan(plan.id)?.attentionReason).toContain("auto-detect email address");
    });

    it("没配这个端口就整步跳过（测试与无 Git 环境走这条）", async () => {
      const { store, plans, plan, run } = arrange();

      const verification = await new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }));

      expect(verification.status).toBe("PASSED");
      expect(store.getRun(run.id)?.status).toBe("MERGE_READY");
    });
  });

  it("requires verification evidence to belong to the same run before review", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Review binding",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Review binding" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = {
      id: "verification-1",
      runId: "other-run",
      status: "PASSED" as const,
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    };
    expect(() => new MergeService(store).createRequest(run, verification, "def456")).toThrow(/same run/i);
  });

  it("repairs a failed verification within the revision limit and creates merge evidence", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Verify and merge",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Verify and merge" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    let attempts = 0;
    const verification = await new VerificationService().verify(
      run,
      plans.getRevision(plan.id, 1),
      async () => ({ exitCode: ++attempts === 1 ? 1 : 0, stdout: "", stderr: "" }),
      async () => true,
    );
    expect(verification.status).toBe("PASSED");
    expect(verification.repairAttempts).toBe(1);
    expect(run.status).toBe("MERGE_READY");
    arrangeMergeReadyPlan(store, plan.id, run.id);
    const merge = new MergeService(store);
    const request = merge.createRequest(run, verification, "def456");
    expect(() => merge.confirmMerged(request.id, "wrong-commit")).toThrow(/target commit/i);
    expect(merge.confirmMerged(request.id, "def456").status).toBe("MERGED");
    expect(plans.get(plan.id).status).toBe("MERGED");
  });

  it("requires Git evidence that the reviewed source is contained by the target branch", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-worktrees",
    });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Git evidence",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Git evidence" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = {
      id: "verification-1",
      runId: run.id,
      status: "PASSED" as const,
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    };
    const merge = new MergeService(store, {
      git: {
        commitExists: (_repoRoot, commit) => commit === "source" || commit === "target",
        resolveCommit: (_repoRoot, ref) => (ref === "main" ? "target" : null),
        isAncestor: (_repoRoot, source, target) => source === "source" && target === "target",
        branchContains: () => true,
      },
    });

    arrangeMergeReadyPlan(store, plan.id, run.id);
    expect(() => merge.createRequest(run, verification, "missing")).toThrow(/source commit/i);
    const request = merge.createRequest(run, verification, "source");
    expect(() => merge.confirmMerged(request.id, "target")).not.toThrow();
  });

  it("persists verification evidence in the pipeline store", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Persist verification",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Persist verification" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    store.saveRun(run);
    const verification = await new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    expect(store.getVerificationRun(run.id)).toEqual(verification);
    expect(store.listVerificationRuns(run.id)).toHaveLength(1);
  });

  it("restores verification evidence from SQLite after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-verification-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const firstStore = new SqlitePipelineStore(databasePath);
      const plans = new PlanService(firstStore);
      const plan = plans.createCandidatePlan({
        projectId: "project-1",
        sourceExplorerThreadId: "thread-1",
        title: "SQLite verification",
        resolvedContract: planContractFixture({ store: firstStore, projectId: "project-1", title: "SQLite verification" }),
      });
      plans.confirm(plan.id, "user-1");
      const run = makeRun(plan.id);
      firstStore.saveRun(run);
      const verification = await new VerificationService(firstStore).verify(run, plans.getRevision(plan.id, 1), async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }));
      firstStore.close();
      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getVerificationRun(run.id)).toEqual(verification);
      expect(reopened.listVerificationRuns(run.id)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills legacy verification evidence from the execution journal", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-legacy-verification-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const store = new SqlitePipelineStore(databasePath);
      const plans = new PlanService(store);
      const plan = plans.createCandidatePlan({
        projectId: "project-1",
        sourceExplorerThreadId: "thread-1",
        title: "Legacy verification",
        resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Legacy verification" }),
      });
      plans.confirm(plan.id, "user-1");
      const run = makeRun(plan.id);
      run.status = "MERGE_READY";
      store.saveRun(run);
      const verification = {
        id: "verification-legacy",
        runId: run.id,
        status: "PASSED" as const,
        repairAttempts: 0,
        commandResults: [],
        completedAt: new Date().toISOString(),
      };
      const thread: ExecutionThread = {
        id: run.executionThreadId,
        runId: run.id,
        state: "COMPLETED",
        journal: [{ sequence: 1, type: "VERIFICATION", occurredAt: verification.completedAt, payload: verification }],
      };
      store.saveExecutionThread(thread);
      store.close();

      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getVerificationRun(run.id)).toEqual(verification);
      expect(reopened.listVerificationRuns(run.id)).toEqual([verification]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks verification after the configured repair limit", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Stay blocked",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Stay blocked" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    const verification = await new VerificationService().verify(
      run,
      plans.getRevision(plan.id, 1),
      async () => ({ exitCode: 1, stdout: "", stderr: "still failing" }),
      async () => false,
    );
    expect(verification).toMatchObject({ status: "BLOCKED", repairAttempts: 2 });
    expect(run.status).toBe("BLOCKED");
  });

  it("synchronizes the Plan projection when verification blocks a Run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Sync blocked plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Sync blocked plan" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    store.saveRun(run);
    store.updatePlan({ ...plan, status: "IN_PROGRESS", runId: run.id });

    await new VerificationService(store).verify(run, plans.getRevision(plan.id, 1), async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "failed",
    }));

    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Verification failed" });
  });

  it("uses the frozen plan base branch as the merge target", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Use project branch",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Use project branch" }),
    });
    store.updatePlan({
      ...plan,
      resolvedContract: { ...plan.resolvedContract, repository: { ...plan.resolvedContract.repository, baseBranch: "trunk" } },
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = {
      id: "verification-1",
      runId: run.id,
      status: "PASSED" as const,
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    };
    const request = new MergeService(store).createRequest(run, verification, "def456");
    expect(request.targetBranch).toBe("trunk");
  });

  it("restores a merge request from the pipeline store", () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Persist merge request",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Persist merge request" }),
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    const verification = {
      id: "verification-1",
      runId: run.id,
      status: "PASSED" as const,
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    };
    arrangeMergeReadyPlan(store, plan.id, run.id);
    const request = new MergeService(store).createRequest(run, verification, "def456");
    const reopenedService = new MergeService(store);
    expect(reopenedService.findByRun(run.id)).toEqual(request);
    expect(reopenedService.confirmMerged(request.id, "def456").status).toBe("MERGED");
  });

  it("reconciles an externally merged run without changing Plan status", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-worktrees",
    });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Reconcile external merge",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Reconcile external merge" }),
    });
    const configuredPlan = store.updatePlan({
      ...plan,
      resolvedContract: {
        ...plan.resolvedContract,
        repository: { ...plan.resolvedContract.repository, baseBranch: "main", baseCommit: "base" },
      },
    });
    plans.confirm(configuredPlan.id, "user-1");
    const run = makeRun(plan.id);
    run.status = "MERGE_READY";
    store.saveRun(run);
    store.updatePlan({ ...store.getPlan(plan.id)!, status: "MERGE_READY", runId: run.id });
    store.saveVerificationRun({
      id: "verification-1",
      runId: run.id,
      status: "PASSED",
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    });
    const merge = new MergeService(store, {
      git: {
        commitExists: (_repoRoot, commit) => commit === "source" || commit === "target",
        resolveCommit: (_repoRoot, ref) => (ref === "HEAD" ? "source" : ref === "main" ? "target" : null),
        isAncestor: (_repoRoot, source, target) => source === "source" && target === "target",
        branchContains: () => true,
      },
    });

    const first = merge.reconcileProject(projects.get("project-1").id);
    expect(first.items[0]).toMatchObject({ outcome: "DETECTED", sourceCommit: "source", targetCommit: "target" });
    expect(first.items[0]?.mergeRequest).toMatchObject({ status: "OPEN", detectedTargetCommit: "target" });
    expect(store.getPlan(plan.id)?.status).toBe("MERGE_READY");

    const second = merge.reconcileProject("project-1");
    expect(second.items[0]).toMatchObject({ outcome: "ALREADY_OPEN" });
    expect(store.listMergeRequests()).toHaveLength(1);
    expect(
      store.listEvents({ aggregateId: first.items[0]!.mergeRequest!.id }).filter((event) => event.type === "merge.detected"),
    ).toHaveLength(1);

    merge.confirmMerged(first.items[0]!.mergeRequest!.id, "target");
    const afterConfirmation = merge.reconcileProject("project-1");
    expect(afterConfirmation.items[0]).toMatchObject({ outcome: "ALREADY_MERGED", mergeRequest: { status: "MERGED" } });
  });

  /**
   * **一个提交都没有的 Run 不能报"已检测到"。**
   *
   * 它的工作区 / 分支 HEAD 还停在基线本身（`resolveRunSource` 取的就是 HEAD），于是"源提交"就是
   * 基线——`isAncestor(source, target)` 恒真，对账会给出一个空洞的"主干里已经有这份提交了"。
   * 实测（2026-10-11，project4 的 `run-b7cd26ff-c11`）：它的修复一直躺在工作区里没提交，界面却
   * 显示「已检测到」；人照着提示去点「确认合并」，会连带把那份没提交的修复删掉。
   */
  it("does not claim a merge for a run that never committed anything", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({
      id: "project-1",
      name: "Project",
      repoRoot: "/repo/project",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-worktrees",
    });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Run without commits",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Run without commits" }),
    });
    store.updatePlan({
      ...plan,
      resolvedContract: {
        ...plan.resolvedContract,
        repository: { ...plan.resolvedContract.repository, baseBranch: "main", baseCommit: "abc" },
      },
    });
    plans.confirm(plan.id, "user-1");
    const run = makeRun(plan.id); // baseCommit 就是 "abc"
    run.status = "MERGE_READY";
    store.saveRun(run);
    store.updatePlan({ ...store.getPlan(plan.id)!, status: "MERGE_READY", runId: run.id });
    store.saveVerificationRun({
      id: "verification-1",
      runId: run.id,
      status: "PASSED",
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    });
    const merge = new MergeService(store, {
      git: {
        commitExists: () => true,
        // 关键：HEAD 解析出来就是它自己的基线（"abc"）——这个 Run 没提交过任何东西。
        resolveCommit: (_repoRoot, ref) => (ref === "HEAD" ? "abc" : ref === "main" ? "target" : null),
        isAncestor: () => true, // 恒真的包含关系，正是要挡住的那种"检测到"
        branchContains: () => true,
      },
    });

    const report = merge.reconcileProject("project-1");

    expect(report.items[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      sourceCommit: "abc",
      reason: "Run 在分支上没有任何自己的提交（工作区里的改动还没提交），没有可判定的提交",
    });
    // 也不该顺手建一条合并请求出来。
    expect(store.listMergeRequests()).toHaveLength(0);
    expect(store.getPlan(plan.id)?.status).toBe("MERGE_READY");
  });

  it("persists detected target commits across SQLite reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-merge-reconcile-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const firstStore = new SqlitePipelineStore(databasePath);
      const projects = new ProjectService(firstStore);
      projects.create({
        id: "project-1",
        name: "Project",
        repoRoot: "/repo/project",
        defaultBranch: "main",
        worktreeRoot: "/tmp/project-worktrees",
      });
      const plans = new PlanService(firstStore, projects);
      const plan = plans.createCandidatePlan({
        projectId: "project-1",
        sourceExplorerThreadId: "thread-1",
        title: "Persist detected merge",
        resolvedContract: planContractFixture({ store: firstStore, projectId: "project-1", title: "Persist detected merge" }),
      });
      const configuredPlan = firstStore.updatePlan({
        ...plan,
        resolvedContract: {
          ...plan.resolvedContract,
          repository: { ...plan.resolvedContract.repository, baseBranch: "main", baseCommit: "base" },
        },
      });
      plans.confirm(configuredPlan.id, "user-1");
      const run = makeRun(plan.id);
      run.status = "MERGE_READY";
      firstStore.saveRun(run);
      firstStore.updatePlan({ ...firstStore.getPlan(plan.id)!, status: "MERGE_READY", runId: run.id });
      firstStore.saveVerificationRun({
        id: "verification-1",
        runId: run.id,
        status: "PASSED",
        repairAttempts: 0,
        commandResults: [],
        completedAt: new Date().toISOString(),
      });
      const merge = new MergeService(firstStore, {
        git: {
          commitExists: (_repoRoot, commit) => commit === "source" || commit === "target",
          resolveCommit: (_repoRoot, ref) => (ref === "HEAD" ? "source" : ref === "main" ? "target" : null),
          isAncestor: (_repoRoot, source, target) => source === "source" && target === "target",
          branchContains: () => true,
        },
      });
      const request = merge.reconcileProject("project-1").items[0]?.mergeRequest;
      expect(request).toMatchObject({ detectedTargetCommit: "target" });
      firstStore.close();

      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getMergeRequest(request!.id)).toMatchObject({ detectedTargetCommit: "target", status: "OPEN" });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
