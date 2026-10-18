/**
 * 测试职责：验证 m3-run 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryPipelineStore,
  LifecycleHookRunner,
  LocalGitWorktreeAdapter,
  PlanService,
  ProjectService,
  Scheduler,
  composeRunBranchLeaf,
  runBranchName,
  type RunBranchNameGenerator,
} from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

describe("Scheduler and ExecutionThread", () => {
  it("fails before creating a worktree when frozen verification commands are not registered", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({
      id: "project-preflight",
      name: "Preflight",
      repoRoot: "/repo/preflight",
      defaultBranch: "main",
      worktreeRoot: "/tmp/preflight",
      settings: { commands: [{ commandId: "project.test", category: "verification", enabled: true, argv: ["true"] }] },
    });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({
      projectId: "project-preflight",
      sourceExplorerThreadId: "thread-preflight",
      title: "Preflight",
      resolvedContract: planContractFixture({ store, projectId: "project-preflight", title: "Preflight" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    plans.dispatch(plan.id);
    let created = false;
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => {
          created = true;
          return { path: "/tmp/preflight/run", branch: "factory/run", baseCommit: "abc" };
        },
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    await expect(scheduler.start(plan.id)).rejects.toThrow(/RUN_PREREQUISITES_UNSATISFIED/);
    expect(created).toBe(false);
  });
  it("creates a run, workspace and thread in order, then records the start hook", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Run a plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Run a plan" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const order: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => {
          order.push("worktree.add");
          return { path: "/tmp/run-1", branch: "factory/run-1", baseCommit: "abc" };
        },
        remove: async () => {
          order.push("worktree.remove");
        },
      },
      hooks: new LifecycleHookRunner(async (command) => {
        order.push(command.commandId);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start" } });
    expect(run).toMatchObject({ planId: plan.id, planRevision: 1, status: "IN_PROGRESS", executionThreadId: expect.any(String) });
    expect(order).toEqual(["worktree.add", "project.start"]);
    expect(scheduler.thread(run.executionThreadId).journal.map((entry) => entry.type)).toEqual([
      "RUN_CREATED",
      "HOOK_COMPLETED",
      "TASK_PROGRESS",
    ]);
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({
      type: "TASK_PROGRESS",
      payload: { action: "legacy_plan_revision" },
    });
  });

  it("uses the generated readable branch for the Run and Worktree", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-branch-name",
      sourceExplorerThreadId: "thread-branch-name",
      title: "Vue introduction",
      resolvedContract: planContractFixture({ store, projectId: "project-branch-name", title: "Vue introduction" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    let workspaceInput: { runId: string; branch: string } | undefined;
    const branchNameGenerator: RunBranchNameGenerator = { generate: async () => "vue-intro" };
    const scheduler = new Scheduler({
      store,
      branchNameGenerator,
      workspace: {
        create: async (input) => {
          workspaceInput = { runId: input.runId, branch: input.branch };
          return { path: `/tmp/${input.branch.split("/").at(-1)}`, branch: input.branch, baseCommit: input.baseCommit };
        },
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);

    // 戳是**年月日-时分秒**（见 runBranchStamp）：只到天的话，同一天里标题相近的两次 Run
    // 会算出同一个叶子，而那就是分支名——撞上就把 Run 打成 BLOCKED。
    expect(run.branch).toMatch(/^factory\/\d{8}-\d{6}-vue-intro$/);
    expect(workspaceInput).toMatchObject({ runId: run.id, branch: run.branch });
    expect(run.workspacePath).toBe(`/tmp/${run.branch.split("/").at(-1)}`);
  });

  /**
   * 分支名分配器原先只问**库里记着的 Run 分支**，而删掉 Run 行**不会**删掉仓库里那条分支。
   * 实测撞过（`factory/20261007-fix-task-project-validation`：分支还在仓库里、库里那条 Run 早被删），
   * 新 Run 拿到同一个叶子 → `git worktree add -b` 当场失败 → Run 打成 `BLOCKED`，界面上的
   * 「为什么停下」写着"分支已经存在"。现在它一并去问 git。
   */
  it("avoids a branch that exists in the repository but has no Run row", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-branch-orphan",
      sourceExplorerThreadId: "thread-branch-orphan",
      title: "Vue introduction",
      resolvedContract: planContractFixture({ store, projectId: "project-branch-orphan", title: "Vue introduction" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      branchNameGenerator: { generate: async () => "vue-intro" },
      workspace: {
        create: async (input) => ({ path: `/tmp/${input.runId}`, branch: input.branch, baseCommit: input.baseCommit }),
        remove: async () => undefined,
        // 叶子里的时间戳由调度器内部取 `store.now()`，测试猜不到是哪一秒——把相邻三秒都占上。
        listBranches: async () => {
          const now = Date.now();
          return [-1000, 0, 1000].map((offset) => runBranchName(composeRunBranchLeaf(new Date(now + offset).toISOString(), "vue-intro")));
        },
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);

    expect(run.branch).toMatch(/^factory\/\d{8}-\d{6}-vue-intro-2$/);
  });

  it("falls back to change when branch summary generation fails", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-branch-fallback",
      sourceExplorerThreadId: "thread-branch-fallback",
      title: "中文需求",
      resolvedContract: planContractFixture({ store, projectId: "project-branch-fallback", title: "中文需求" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      branchNameGenerator: {
        generate: async () => {
          throw new Error("model unavailable");
        },
      },
      workspace: {
        create: async (input) => ({ path: `/tmp/${input.runId}`, branch: input.branch, baseCommit: input.baseCommit }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);

    expect(run.branch).toMatch(/^factory\/\d{8}-\d{6}-change$/);
  });

  /**
   * 模型超时/失败时**不要丢掉标题里本来就有的 ASCII**：标题派生的 slug 是兜底值，
   * 只有标题也派不出 slug（纯中文）时才回落到 `change`。
   */
  it("falls back to the title-derived slug when branch summary generation fails", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-branch-fallback-title",
      sourceExplorerThreadId: "thread-branch-fallback-title",
      title: "Vue introduction",
      resolvedContract: planContractFixture({ store, projectId: "project-branch-fallback-title", title: "Vue introduction" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      branchNameGenerator: {
        generate: async () => {
          throw new Error("model timed out");
        },
      },
      workspace: {
        create: async (input) => ({ path: `/tmp/${input.runId}`, branch: input.branch, baseCommit: input.baseCommit }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);

    expect(run.branch).toMatch(/^factory\/\d{8}-\d{6}-vue-introduction$/);
  });

  it("persists every bounded lifecycle hook attempt", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-hooks",
      sourceExplorerThreadId: "thread-hooks",
      title: "Hook audit",
      resolvedContract: planContractFixture({ store, projectId: "project-hooks", title: "Hook audit" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    let calls = 0;
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/hook-audit", branch: "factory/hook-audit", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: ++calls === 2 ? 0 : 1, stdout: `attempt-${calls}`, stderr: "" })),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start", maxAttempts: 2 } });

    expect(run.status).toBe("IN_PROGRESS");
    expect(store.listHookExecutions(run.id).map((item) => ({ attempt: item.attempt, status: item.status, stdout: item.stdout }))).toEqual([
      { attempt: 1, status: "failed", stdout: "attempt-1" },
      { attempt: 2, status: "completed", stdout: "attempt-2" },
    ]);
  });

  it("blocks a run after start failure and never opens an Executor turn", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Blocked run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Blocked run" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/run-2", branch: "factory/run-2", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 1, stdout: "", stderr: "environment failed" })),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.start" } });
    expect(run.status).toBe("BLOCKED");
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({ type: "HOOK_FAILED" });
  });

  /**
   * 与上一条**互为对照**：同一次失败，只因为钩子配了 `blocking: false`，Run 就必须开下去。
   *
   * 这里钉三件事：Run 进 IN_PROGRESS、失败只有一条 HOOK_FAILED 且带 `blocking: false`
   * （这条 journal 是唯一现场——没有 BLOCKED 状态供人事后回看）、以及失败之后**不能**再补一条
   * HOOK_COMPLETED（那会让"失败"在会话里看起来像"成功"）。
   */
  it("**非阻塞的启动钩子失败后照常开 Executor，失败只留在 journal 里**", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Soft hook",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Soft hook" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/run-2b", branch: "factory/run-2b", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 1, stdout: "", stderr: "codegraph: command not found" })),
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "project.codegraph-init", blocking: false } });
    const journal = scheduler.thread(run.executionThreadId).journal;

    expect(run.status).toBe("IN_PROGRESS");
    expect(journal.filter((entry) => entry.type === "HOOK_FAILED")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ hook: "start", blocking: false, stderr: "codegraph: command not found" }),
      }),
    ]);
    expect(journal.some((entry) => entry.type === "HOOK_COMPLETED")).toBe(false);
    // 审计照旧：失败的那次尝试一条不少地进了 HookExecution。
    expect(store.listHookExecutions(run.id).map((item) => item.status)).toEqual(["failed"]);
  });

  it("removes the workspace before running cleanup and keeps cleanup failure as attention", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Cleanup run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Cleanup run" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const order: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/run-3", branch: "factory/run-3", baseCommit: "abc" }),
        remove: async () => {
          order.push("worktree.remove");
        },
      },
      hooks: new LifecycleHookRunner(async (command) => {
        order.push(command.commandId);
        return { exitCode: 1, stdout: "", stderr: "cleanup failed" };
      }),
    });
    const run = await scheduler.start(plan.id);
    await scheduler.finish(run.id, "completed", { cleanup: { commandId: "project.cleanup" } });
    expect(order).toEqual(["worktree.remove", "project.cleanup"]);
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({ type: "HOOK_FAILED" });
    expect(store.getPlan(plan.id)?.attentionReason).toMatch(/cleanup/i);
    // **删完把 `workspacePath` 清掉**：这一列此前删完留着，于是"这条 Run 还有没有 worktree"
    // 在库里看不出来（7 条已取消的 Run 全带着路径，其中 5 条目录早没了）。界面要靠它判断
    // 该不该给「回收工作区」那个入口。
    expect(store.getRun(run.id)?.workspacePath).toBeNull();
  });

  it("目录早就不在了：按「已回收」算，`finish` 不抛、并把那一列清掉", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Already gone",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Already gone" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        // 返回一个**不存在**的目录：这正是老库里 `workspacePath` 与磁盘对不上的样子。
        create: async () => ({ path: "/tmp/run-already-gone", branch: "factory/run-already-gone", baseCommit: "abc" }),
        remove: async () => {
          throw new Error("Git worktree could not be removed: not a working tree");
        },
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const run = await scheduler.start(plan.id);

    await expect(scheduler.finish(run.id, "completed", {})).resolves.toBeTruthy();
    expect(store.getRun(run.id)?.workspacePath).toBeNull();
  });

  it("真删不掉时：`finish` 仍然不抛，但把失败记进 attention 与 journal", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Stuck workspace",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Stuck workspace" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    // 目录**真的存在**，remove 又抛 → 这才是"删不掉"，不能当已回收。
    const stuck = mkdtempSync(join(tmpdir(), "pf-stuck-workspace-"));
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: stuck, branch: "factory/run-stuck", baseCommit: "abc" }),
        remove: async () => {
          throw new Error("Git worktree could not be removed: device busy");
        },
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const run = await scheduler.start(plan.id);

    await expect(scheduler.finish(run.id, "completed", {})).resolves.toBeTruthy();
    // 删不掉就**别清那一列**——目录还在，清了界面就会以为已经收干净了。
    expect(store.getRun(run.id)?.workspacePath).toBe(stuck);
    expect(store.getPlan(plan.id)?.attentionReason).toMatch(/worktree not released/i);
    expect(scheduler.thread(run.executionThreadId).journal.at(-1)).toMatchObject({
      type: "HOOK_FAILED",
      payload: expect.objectContaining({ hook: "worktree-release" }),
    });
    rmSync(stuck, { recursive: true, force: true });
  });

  it("releases a merged Run's worktree once and keeps the branch", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Merged plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Merged plan" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    // 真目录：releaseWorkspace 以"目录还在不在"判断要不要调 git，用假路径会走"已回收"分支。
    const workspacePath = mkdtempSync(join(tmpdir(), "pipeline-merged-worktree-"));
    const removed: string[] = [];
    const cleanupRuns: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: workspacePath, branch: "factory/run-merged", baseCommit: "abc" }),
        remove: async (workspace) => {
          removed.push(workspace.path);
        },
      },
      hooks: new LifecycleHookRunner(async (command) => {
        cleanupRuns.push(command.commandId);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    });
    try {
      const run = await scheduler.start(plan.id);
      const branchBefore = store.getRun(run.id)!.branch;

      // hook 由调用方传入（与 routes/merge-requests.ts 一致）：冻结快照优先，其次才是当前 Project 设置。
      const released = await scheduler.releaseWorkspace(run.id, { cleanup: { commandId: "project.cleanup" } });
      expect(released).toMatchObject({ released: true, worktreeRemoved: true, cleanupNeedsAttention: false });
      expect(removed).toEqual([workspacePath]);
      expect(cleanupRuns).toEqual(["project.cleanup"]);
      // 幂等：目录已回收，再调一次不会重复删、也不会重复跑 cleanup。
      expect(await scheduler.releaseWorkspace(run.id, { cleanup: { commandId: "project.cleanup" } })).toMatchObject({ released: false });
      expect(removed).toEqual([workspacePath]);
      expect(cleanupRuns).toEqual(["project.cleanup"]);
      // 状态不被这次回收改动：Plan 仍是 DISPATCHED，Run 仍按原状态存在（分支保留给人工审计）。
      expect(store.getRun(run.id)?.workspacePath).toBeNull();
      expect(store.getRun(run.id)?.branch).toBe(branchBefore);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("validates the base commit before creating a real Git worktree", async () => {
    const commands: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot: "/repo",
      worktreeRoot: "/worktrees",
      runGit: async (args) => {
        commands.push(args);
        return { exitCode: 0, stdout: "abc", stderr: "" };
      },
    });
    await adapter.create({ projectId: "project-1", runId: "run-1", branch: "factory/20260906-vue-intro", baseCommit: "abc" });
    await adapter.remove({ path: "/worktrees/20260906-vue-intro", branch: "factory/20260906-vue-intro", baseCommit: "abc" });
    // 第二条是"工作区必须干净"的检查（见 git/working-tree.ts）：基线恒等于 baseCommit 之后，
    // 工作区里未提交的改动不再被搬进新工作树，而是被这道检查挡在门外。
    expect(commands).toEqual([
      ["rev-parse", "--verify", "abc"],
      ["status", "--porcelain", "-uall", "--", "."],
      ["worktree", "add", "-b", "factory/20260906-vue-intro", "/worktrees/20260906-vue-intro", "abc"],
      ["worktree", "remove", "--force", "/worktrees/20260906-vue-intro"],
    ]);
  });

  /**
   * Run 成功收尾前 `VerificationService` 会调它一次（见那边的维护提示 6）。三条判据：
   * 命令顺序、干净就不提交、失败要抛——最后一条决定了调用方能不能把 Run 打成 BLOCKED。
   */
  it("commits the workspace changes onto its own branch", async () => {
    const commands: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot: "/repo",
      worktreeRoot: "/worktrees",
      runGit: async (args) => {
        commands.push(args);
        if (args[0] === "status") return { exitCode: 0, stdout: " M code/src/App.vue\n", stderr: "" };
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "newsha\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(adapter.commit({ path: "/worktrees/run-1", branch: "factory/run-1", baseCommit: "abc" }, "title")).resolves.toBe("newsha");
    expect(commands).toEqual([
      ["status", "--porcelain"],
      // 工具元数据目录（服务配置）不参与提交，见 git/worktree.ts 的说明。
      ["add", "-A", "--", ".", ":(exclude).pipeline-factory", ":(exclude).worktree-manage"],
      ["commit", "-m", "title"],
      ["rev-parse", "HEAD"],
    ]);
  });

  it("skips the commit when the workspace is clean", async () => {
    const commands: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot: "/repo",
      worktreeRoot: "/worktrees",
      runGit: async (args) => {
        commands.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // 干净时**不**调 `commit`：那会以非 0 退出（"nothing to commit"），但那不是错误。
    await expect(adapter.commit({ path: "/worktrees/run-1", branch: "factory/run-1", baseCommit: "abc" }, "title")).resolves.toBeNull();
    expect(commands).toEqual([["status", "--porcelain"]]);
  });

  it("throws when the commit fails, so the caller can block the run", async () => {
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot: "/repo",
      worktreeRoot: "/worktrees",
      runGit: async (args) => {
        if (args[0] === "status") return { exitCode: 0, stdout: " M code/src/App.vue\n", stderr: "" };
        return { exitCode: 128, stdout: "", stderr: "fatal: unable to auto-detect email address" };
      },
    });

    await expect(adapter.commit({ path: "/worktrees/run-1", branch: "factory/run-1", baseCommit: "abc" }, "title")).rejects.toThrow(
      /auto-detect email address/,
    );
  });

  it("uses the persisted run status after verification changes it", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Fresh run state",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Fresh run state" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/run-4", branch: "factory/run-4", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);
    store.saveRun({ ...run, status: "MERGE_READY" });

    expect(() => scheduler.pause(run.id)).toThrow(/cannot be paused from MERGE_READY/i);
    expect(scheduler.thread(run.executionThreadId).state).toBe("ACTIVE");
  });

  it("synchronizes the Plan when a cancelled Run reaches finish twice", async () => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const plan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Cancelled run race",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Cancelled run race" }),
    });
    planService.confirm(plan.id, "user-1");
    planService.enqueue(plan.id);
    planService.dispatch(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/run-race", branch: "factory/run-race", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const run = await scheduler.start(plan.id);
    store.saveRun({ ...run, status: "CANCELLED" });
    await scheduler.finish(run.id, "cancelled", {}, "stale_run");

    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Run cancelled: stale_run" });
  });

  // 槽位语义（哪些状态占执行名额）现在由 PlanDispatchCoordinator 的容量判定决定，
  // 见 dispatch-coordinator.test.ts；本用例只验证 Scheduler.start 不会因为另一个 Run 在跑而拒绝。
  it.each(["READY_FOR_VERIFY", "MERGE_READY"] as const)("does not count %s as an execution slot", async (status) => {
    const store = new InMemoryPipelineStore();
    const planService = new PlanService(store);
    const firstPlan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "First plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "First plan" }),
    });
    planService.confirm(firstPlan.id, "user-1");
    planService.enqueue(firstPlan.id);
    planService.dispatch(firstPlan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });

    const firstRun = await scheduler.start(firstPlan.id);
    store.saveRun({ ...firstRun, status });
    const secondPlan = planService.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Second plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Second plan" }),
    });
    planService.confirm(secondPlan.id, "user-1");
    planService.enqueue(secondPlan.id);
    planService.dispatch(secondPlan.id);

    await expect(scheduler.start(secondPlan.id)).resolves.toMatchObject({ status: "IN_PROGRESS" });
  });
});
