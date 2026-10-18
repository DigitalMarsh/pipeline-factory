/**
 * 测试职责：Project 视角的 Worktree 服务 —— 清单分类、合并预览的阻断判据、真实合并、
 *   冲突后的继续/中止、以及清理的 `merged_clean` 约束。
 *
 * 设计说明：全部用**真 Git 仓库 + 真 worktree**（`git init` / `worktree add`）。这套判据的价值
 *   恰恰在于它与 git 语义对齐（`--is-ancestor`、`merge-tree`、`worktree remove` 的行为都不是
 *   我们能自己模拟的），用桩替换掉就等于没测。fixture 只造"某个状态下必须成立的最小提交图"。
 *
 * 维护提示：新增判据时，先在这里造出"它必须拒绝"的那种仓库形状，再实现；
 *   只断言 happy path 的用例挡不住"顺手放宽了一条阻断项"这类回归。
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { ProjectService } from "../project/project.js";
import type { Project } from "../project/project.js";
import { MergeService } from "../run/merge.js";
import { WorktreeError, WorktreeService, classifyDetached, classifyNamedBranch } from "./service.js";
import { createLocalWorktreeGit } from "./local-git.js";

const temporaryPaths: string[] = [];
afterAll(() => {
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(cwd: string, message: string): void {
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "-q", "-m", message], {
    cwd,
  });
}

function makeTemporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

type Fixture = { store: InMemoryPipelineStore; project: Project; repoRoot: string; worktreeRoot: string };

/** 一个干净的真仓库：main 上一次 init 提交，worktree 根目录在仓库之外。 */
function setup(): Fixture {
  const repoRoot = makeTemporary("pipeline-worktree-repo-");
  const worktreeRoot = makeTemporary("pipeline-worktree-wt-");
  git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "base\n");
  git(repoRoot, ["add", "-A"]);
  commit(repoRoot, "init");
  const store = new InMemoryPipelineStore();
  const project = new ProjectService(store).create({
    id: "project-1",
    name: "project-1",
    repoRoot,
    defaultBranch: "main",
    worktreeRoot,
  });
  return { store, project, repoRoot, worktreeRoot };
}

function serviceFor(fixture: Fixture, overrides: { activeRun?: boolean } = {}): WorktreeService {
  if (overrides.activeRun) {
    fixture.store.saveRun({
      id: "run-active",
      projectId: fixture.project.id,
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "feature/ahead",
      workspacePath: join(fixture.worktreeRoot, "ahead"),
      baseCommit: "0000000000000000000000000000000000000000",
      executionThreadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return new WorktreeService(fixture.store, { git: createLocalWorktreeGit() });
}

/** 建一条带提交的分支并切回 main（工作区干净，供后续 `worktree add`）。 */
function createBranch(repoRoot: string, branch: string, file: string, content: string): void {
  git(repoRoot, ["switch", "-c", branch, "main"]);
  writeFileSync(join(repoRoot, file), content);
  git(repoRoot, ["add", "-A"]);
  commit(repoRoot, `${branch} change`);
  git(repoRoot, ["switch", "main"]);
}

function addWorktree(fixture: Fixture, branch: string, name: string): string {
  const path = join(fixture.worktreeRoot, name);
  git(fixture.repoRoot, ["worktree", "add", path, branch]);
  return path;
}

function itemFor(inventory: Awaited<ReturnType<WorktreeService["list"]>>, branch: string) {
  return inventory.items.find((item) => item.branch === branch);
}

describe("状态分类", () => {
  it("named branch：按 clean/提交/合并三个维度分类", () => {
    expect(classifyNamedBranch("clean", 0, false, true)).toBe("no_updates");
    expect(classifyNamedBranch("clean", 2, false, false)).toBe("committed_unmerged");
    expect(classifyNamedBranch("dirty", 2, false, false)).toBe("dirty_with_commits");
    expect(classifyNamedBranch("dirty", 0, false, false)).toBe("dirty_uncommitted");
    expect(classifyNamedBranch("conflict", 1, false, false)).toBe("merge_conflict");
    expect(classifyNamedBranch("clean", 0, true, false)).toBe("merged_clean");
    expect(classifyNamedBranch("dirty", 0, true, false)).toBe("merged_dirty");
  });

  it("detached：没有 merged 这一档", () => {
    expect(classifyDetached("clean", 0)).toBe("detached_clean");
    expect(classifyDetached("clean", 2)).toBe("detached_unmerged");
    expect(classifyDetached("dirty", 2)).toBe("detached_dirty_with_commits");
    expect(classifyDetached("dirty", 0)).toBe("detached_dirty");
    expect(classifyDetached("conflict", 0)).toBe("merge_conflict");
  });
});

describe("清单", () => {
  it("列出主分支、已提交未合并、已合并、脏 worktree 与 detached", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    createBranch(fixture.repoRoot, "feature/dirty", "dirty.txt", "dirty\n");
    createBranch(fixture.repoRoot, "feature/merged", "merged.txt", "merged\n");
    addWorktree(fixture, "feature/ahead", "ahead");
    addWorktree(fixture, "feature/dirty", "dirty");
    const mergedWorktree = addWorktree(fixture, "feature/merged", "merged");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);
    writeFileSync(join(fixture.worktreeRoot, "dirty", "scratch.txt"), "uncommitted\n");
    const detachedPath = join(fixture.worktreeRoot, "detached");
    git(fixture.repoRoot, ["worktree", "add", "--detach", detachedPath, "main"]);

    const inventory = await serviceFor(fixture).list(fixture.project);

    expect(itemFor(inventory, "main")?.status).toBe("no_updates");
    expect(itemFor(inventory, "main")?.kind).toBe("base_branch");
    expect(itemFor(inventory, "feature/ahead")?.status).toBe("committed_unmerged");
    expect(itemFor(inventory, "feature/ahead")?.kind).toBe("branch_worktree");
    expect(itemFor(inventory, "feature/ahead")?.aheadCount).toBe(1);
    expect(itemFor(inventory, "feature/ahead")?.mergeable).toBe(true);
    expect(itemFor(inventory, "feature/dirty")?.status).toBe("dirty_with_commits");
    expect(itemFor(inventory, "feature/dirty")?.mergeable).toBe(false);
    expect(itemFor(inventory, "feature/merged")?.status).toBe("merged_clean");
    expect(itemFor(inventory, "feature/merged")?.cleanupable).toBe(true);
    expect(itemFor(inventory, "feature/merged")?.worktreePath).toBe(realpathSync(mergedWorktree));

    const detached = inventory.items.find((item) => item.kind === "detached_worktree");
    expect(detached?.status).toBe("detached_clean");
    expect(detached?.mergeable).toBe(false);
    // 它停在 main 上、HEAD 被主分支包含：现在允许"只删目录、不删提交"。
    expect(detached?.containedInBranch).toBe(true);
    expect(detached?.cleanupable).toBe(true);
    expect(inventory.mergeInProgress).toBeNull();
    expect(inventory.currentBranch).toBe("main");
  });

  it("只有服务配置的 worktree 仍算 clean（工具元数据不算工作区改动）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/merged", "merged.txt", "merged\n");
    const worktreePath = addWorktree(fixture, "feature/merged", "merged");
    mkdirSync(join(worktreePath, ".pipeline-factory"), { recursive: true });
    writeFileSync(join(worktreePath, ".pipeline-factory", "services.json"), JSON.stringify({ services: [] }));
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);

    const item = itemFor(await serviceFor(fixture).list(fixture.project), "feature/merged");

    expect(item?.gitDirtyState).toBe("clean");
    expect(item?.cleanupable).toBe(true);
  });

  it("带服务配置的 worktree 可以真正删除（git 的 force 与我们的干净判据对齐）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/merged", "merged.txt", "merged\n");
    const worktreePath = addWorktree(fixture, "feature/merged", "merged");
    mkdirSync(join(worktreePath, ".pipeline-factory"), { recursive: true });
    writeFileSync(join(worktreePath, ".pipeline-factory", "services.json"), JSON.stringify({ services: [] }));
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);
    const service = serviceFor(fixture);
    const item = itemFor(await service.list(fixture.project), "feature/merged");

    const result = await service.cleanup(fixture.project, {
      itemId: "branch:feature/merged",
      expectedBranchHead: item?.lastCommit ?? null,
    });

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(() => git(fixture.repoRoot, ["rev-parse", "--verify", "refs/heads/feature/merged"])).toThrow();
  });

  it("repoRoot 不干净时挡住合并（白名单为空）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    writeFileSync(join(fixture.repoRoot, "untracked.txt"), "x\n");

    const inventory = await serviceFor(fixture).list(fixture.project);

    expect(itemFor(inventory, "feature/ahead")?.mergeable).toBe(false);
    expect(itemFor(inventory, "feature/ahead")?.blockers.join("\n")).toContain("仓库工作目录有未提交改动");
  });

  it("有活动 Run 时挡住合并与清理", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    addWorktree(fixture, "feature/ahead", "ahead");

    const inventory = await serviceFor(fixture, { activeRun: true }).list(fixture.project);

    expect(inventory.activeRunIds).toEqual(["run-active"]);
    expect(itemFor(inventory, "feature/ahead")?.mergeable).toBe(false);
    expect(itemFor(inventory, "feature/ahead")?.blockers.join("\n")).toContain("活动 Run");
  });

  it("分支属于 Run 时带上 Factory 标注", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    fixture.store.saveRun({
      id: "run-2",
      projectId: fixture.project.id,
      planId: "plan-2",
      planRevision: 1,
      status: "MERGE_READY",
      branch: "feature/ahead",
      workspacePath: join(fixture.worktreeRoot, "ahead"),
      baseCommit: "0000000000000000000000000000000000000000",
      executionThreadId: "thread-2",
      createdAt: "2026-01-02T00:00:00.000Z",
      startedAt: "2026-01-02T00:00:00.000Z",
    });

    const inventory = await serviceFor(fixture).list(fixture.project);

    expect(itemFor(inventory, "feature/ahead")?.factory?.runId).toBe("run-2");
    expect(itemFor(inventory, "feature/ahead")?.factory?.mergeRequestStatus).toBeNull();
  });
});

describe("合并预览", () => {
  it("可合并的分支给出结论与命令", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    addWorktree(fixture, "feature/ahead", "ahead");
    const service = serviceFor(fixture);

    const preview = await service.preview(fixture.project, "branch:feature/ahead");

    expect(preview.conclusion).toBe("ready");
    expect(preview.canConfirm).toBe(true);
    expect(preview.aheadCount).toBe(1);
    expect(preview.fileChanges.map((change) => change.path)).toContain("ahead.txt");
    expect(preview.recentCommits[0]?.subject).toContain("feature/ahead");
    expect(preview.conflictPrediction.status).toBe("clean");
    expect(preview.commands).toEqual([`git -C ${fixture.repoRoot} switch main`, `git -C ${fixture.repoRoot} merge --no-ff feature/ahead`]);
    expect(preview.expectedBranchHead).toBeTruthy();
    expect(preview.expectedBaseHead).toBeTruthy();
  });

  it("冲突分支给出 conflict_risk（仍可确认）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/conflict", "README.md", "feature side\n");
    writeFileSync(join(fixture.repoRoot, "README.md"), "main side\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "main changes README");
    const service = serviceFor(fixture);

    const preview = await service.preview(fixture.project, "branch:feature/conflict");

    expect(preview.conclusion).toBe("conflict_risk");
    expect(preview.canConfirm).toBe(true);
    expect(preview.conflictPrediction.hasConflicts).toBe(true);
    expect(preview.conflictPrediction.conflictFiles).toContain("README.md");
  });

  it("主分支与 detached 都不能合并", async () => {
    const fixture = setup();
    const detachedPath = join(fixture.worktreeRoot, "detached");
    git(fixture.repoRoot, ["worktree", "add", "--detach", detachedPath, "main"]);
    const service = serviceFor(fixture);

    const base = await service.preview(fixture.project, "branch:main");
    expect(base.canConfirm).toBe(false);
    expect(base.blockers.join("\n")).toContain("主分支");

    const detachedItem = (await service.list(fixture.project)).items.find((item) => item.kind === "detached_worktree");
    const detached = await service.preview(fixture.project, detachedItem?.itemId ?? "");
    expect(detached.canConfirm).toBe(false);
    expect(detached.blockers.join("\n")).toContain("detached");
  });

  it("未知 itemId 抛 WORKTREE_NOT_FOUND", async () => {
    const fixture = setup();
    await expect(serviceFor(fixture).preview(fixture.project, "branch:nope")).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    });
  });
});

describe("执行合并", () => {
  it("合并成功并生成 merge commit", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    addWorktree(fixture, "feature/ahead", "ahead");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/ahead");

    const result = await service.merge(fixture.project, {
      itemId: "branch:feature/ahead",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });

    expect(result.status).toBe("merged");
    expect(result.baseHeadAfter).not.toBe(result.baseHeadBefore);
    expect(git(fixture.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    const parents = git(fixture.repoRoot, ["rev-list", "--parents", "-n", "1", "main"]).trim().split(" ");
    expect(parents).toHaveLength(3);
    expect(git(fixture.repoRoot, ["status", "--short"]).trim()).toBe("");
  });

  it("预览之后 base 前进时拒绝执行（乐观并发）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/ahead");
    writeFileSync(join(fixture.repoRoot, "other.txt"), "other\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "move base");

    await expect(
      service.merge(fixture.project, {
        itemId: "branch:feature/ahead",
        expectedBranchHead: preview.expectedBranchHead,
        expectedBaseHead: preview.expectedBaseHead,
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_STATE_CHANGED" });
  });

  it("有活动 Run 时拒绝合并", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const service = serviceFor(fixture, { activeRun: true });

    await expect(
      service.merge(fixture.project, { itemId: "branch:feature/ahead", expectedBranchHead: null, expectedBaseHead: null }),
    ).rejects.toMatchObject({ code: "WORKTREE_MERGE_BLOCKED" });
  });

  it("冲突后停在合并中，可以中止并恢复干净工作区", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/conflict", "README.md", "feature side\n");
    writeFileSync(join(fixture.repoRoot, "README.md"), "main side\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "main changes README");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/conflict");

    const result = await service.merge(fixture.project, {
      itemId: "branch:feature/conflict",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });
    expect(result.status).toBe("merge_conflict");
    expect(result.conflictFiles).toContain("README.md");

    const inventory = await service.list(fixture.project);
    expect(inventory.mergeInProgress?.conflictFiles).toContain("README.md");

    const aborted = await service.abortMerge(fixture.project);
    expect(aborted.status).toBe("aborted");
    expect(git(fixture.repoRoot, ["status", "--short"]).trim()).toBe("");
    expect((await service.list(fixture.project)).mergeInProgress).toBeNull();
  });

  it("解决冲突后继续合并", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/conflict", "README.md", "feature side\n");
    writeFileSync(join(fixture.repoRoot, "README.md"), "main side\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "main changes README");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/conflict");
    await service.merge(fixture.project, {
      itemId: "branch:feature/conflict",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });

    writeFileSync(join(fixture.repoRoot, "README.md"), "resolved\n");
    git(fixture.repoRoot, ["add", "README.md"]);
    const continued = await service.continueMerge(fixture.project);

    expect(continued.status).toBe("merged");
    expect(git(fixture.repoRoot, ["status", "--short"]).trim()).toBe("");
  });

  it("没有进行中的合并时 continue/abort 报 WORKTREE_NO_MERGE_IN_PROGRESS", async () => {
    const fixture = setup();
    const service = serviceFor(fixture);
    await expect(service.continueMerge(fixture.project)).rejects.toBeInstanceOf(WorktreeError);
    await expect(service.abortMerge(fixture.project)).rejects.toMatchObject({ code: "WORKTREE_NO_MERGE_IN_PROGRESS" });
  });
});

describe("清理", () => {
  it("已合并且干净的 worktree 可以清理（worktree + 分支）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/merged", "merged.txt", "merged\n");
    const worktreePath = addWorktree(fixture, "feature/merged", "merged");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);
    const service = serviceFor(fixture);
    const inventory = await service.list(fixture.project);
    const item = itemFor(inventory, "feature/merged");
    const expectedPath = realpathSync(worktreePath);

    const result = await service.cleanup(fixture.project, {
      itemId: "branch:feature/merged",
      expectedBranchHead: item?.lastCommit ?? null,
    });

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(() => git(fixture.repoRoot, ["rev-parse", "--verify", "refs/heads/feature/merged"])).toThrow();
    const after = await service.list(fixture.project);
    expect(itemFor(after, "feature/merged")).toBeUndefined();
    expect(after.items.some((entry) => entry.worktreePath === expectedPath)).toBe(false);
  });

  it("未合并的分支不能清理", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    addWorktree(fixture, "feature/ahead", "ahead");
    const service = serviceFor(fixture);
    const item = itemFor(await service.list(fixture.project), "feature/ahead");

    await expect(
      service.cleanup(fixture.project, { itemId: "branch:feature/ahead", expectedBranchHead: item?.lastCommit ?? null }),
    ).rejects.toMatchObject({ code: "WORKTREE_CLEANUP_BLOCKED" });
  });

  it("有未提交改动的 detached worktree 不能清理", async () => {
    const fixture = setup();
    const detachedPath = join(fixture.worktreeRoot, "detached-dirty");
    git(fixture.repoRoot, ["worktree", "add", "--detach", detachedPath, "main"]);
    writeFileSync(join(detachedPath, "scratch.txt"), "uncommitted\n");
    const service = serviceFor(fixture);
    const item = (await service.list(fixture.project)).items.find((entry) => entry.kind === "detached_worktree");

    await expect(
      service.cleanup(fixture.project, { itemId: item?.itemId ?? "", expectedBranchHead: item?.lastCommit ?? null }),
    ).rejects.toMatchObject({ code: "WORKTREE_CLEANUP_BLOCKED" });
  });
});

/**
 * Factory 联动：合并成功后要确认 `OPEN` 的 MergeRequest、回收 worktree；清理要走 Run 自己的
 * `releaseWorkspace`（这样 cleanup 钩子才会执行）。这三条是"搬进 Factory"之后新增的行为，
 * worktree-manage 里没有对应物，所以必须有独立的用例。
 */
describe("Factory 联动", () => {
  function seedRunWithMergeRequest(
    fixture: Fixture,
    branch: string,
    workspacePath: string | null,
    targetBranch = "main",
    requestId = "merge-1",
  ): void {
    fixture.store.saveRun({
      id: "run-1",
      projectId: fixture.project.id,
      planId: "plan-1",
      planRevision: 1,
      status: "MERGE_READY",
      branch,
      workspacePath,
      baseCommit: "0000000000000000000000000000000000000000",
      executionThreadId: "thread-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:00.000Z",
    });
    fixture.store.saveMergeRequest({
      id: requestId,
      runId: "run-1",
      planId: "plan-1",
      sourceCommit: "0000000000000000000000000000000000000000",
      targetBranch,
      status: "OPEN",
      humanConfirmationRequired: true,
      createdAt: "2026-10-01T00:00:00.000Z",
      mergedAt: null,
    });
  }

  it("合并成功后确认 OPEN 的 MergeRequest 并回收 worktree", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const worktreePath = addWorktree(fixture, "feature/ahead", "ahead");
    seedRunWithMergeRequest(fixture, "feature/ahead", realpathSync(worktreePath));

    const released: string[] = [];
    const merger = new MergeService(fixture.store, {
      // 没有 Plan 时 `confirmMerged` 不会拿这些去校验；给一份确定性的实现，避免依赖本机 Git 状态。
      git: { commitExists: () => true, resolveCommit: () => null, isAncestor: () => true, branchContains: () => true },
    });
    const service = new WorktreeService(fixture.store, {
      git: createLocalWorktreeGit(),
      merger,
      scheduler: {
        releaseWorkspace: async (runId) => {
          released.push(runId);
          return { released: true, worktreeRemoved: true, cleanupNeedsAttention: false };
        },
      },
    });

    const preview = await service.preview(fixture.project, "branch:feature/ahead");
    const result = await service.merge(fixture.project, {
      itemId: "branch:feature/ahead",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });

    expect(result.status).toBe("merged");
    expect(result.factory).toMatchObject({ mergeRequest: "confirmed", runId: "run-1" });
    expect(fixture.store.getMergeRequest("merge-1")?.status).toBe("MERGED");
    expect(released).toEqual(["run-1"]);
  });

  it("分支不属于任何 Run 时只报告 not_found，不影响合并结果", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/ahead");

    const result = await service.merge(fixture.project, {
      itemId: "branch:feature/ahead",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });

    expect(result.status).toBe("merged");
    expect(result.factory).toMatchObject({ mergeRequest: "not_found" });
  });

  it("MergeRequest 目标分支与项目默认分支不一致时阻断", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    // `saveMergeRequest` 是首次写入生效，所以这里直接给目标分支，不要先写一份 main 的再覆盖。
    seedRunWithMergeRequest(fixture, "feature/ahead", null, "release");

    const preview = await serviceFor(fixture).preview(fixture.project, "branch:feature/ahead");

    expect(preview.canConfirm).toBe(false);
    expect(preview.blockers.join("\n")).toContain("release");
  });

  it("清理属于 Run 的 worktree 时走 releaseWorkspace（cleanup 钩子才会执行）", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/merged", "merged.txt", "merged\n");
    const worktreePath = addWorktree(fixture, "feature/merged", "merged");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);
    seedRunWithMergeRequest(fixture, "feature/merged", realpathSync(worktreePath));

    const released: string[] = [];
    const service = new WorktreeService(fixture.store, {
      git: createLocalWorktreeGit(),
      scheduler: {
        releaseWorkspace: async (runId) => {
          released.push(runId);
          // 真实实现会删目录并清空 workspacePath；这里照做，否则后面的 branch -d 会因为
          // "分支仍被 worktree 占用"而失败。
          git(fixture.repoRoot, ["worktree", "remove", "--force", worktreePath]);
          const run = fixture.store.getRun(runId)!;
          fixture.store.saveRun({ ...run, workspacePath: null });
          return { released: true, worktreeRemoved: true, cleanupNeedsAttention: false };
        },
      },
    });
    const item = itemFor(await service.list(fixture.project), "feature/merged");

    const result = await service.cleanup(fixture.project, {
      itemId: "branch:feature/merged",
      expectedBranchHead: item?.lastCommit ?? null,
    });

    expect(released).toEqual(["run-1"]);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.cleanupHookNeedsAttention).toBe(false);
    expect(fixture.store.getRun("run-1")?.workspacePath).toBeNull();
  });
});

/**
 * 项目范围、曾经合并、三种清理、rebase 与提交历史 —— 复盘后补齐的能力。
 * 每条都对应一个具体的误操作风险，所以用例名直接写"为什么"。
 */
describe("项目范围（忽略分支 / 分支模式 / detached 开关）", () => {
  function withFilter(fixture: Fixture, worktree: Record<string, unknown>): void {
    new ProjectService(fixture.store).update(fixture.project.id, {
      settings: { worktree: worktree as never },
      expectedConfigVersion: fixture.project.configVersion,
    });
    const updated = fixture.store.getProject(fixture.project.id);
    if (updated) fixture.project = updated;
  }

  it("被忽略的分支不出现在默认清单，includeFiltered 时带着 isIgnored 回来", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    createBranch(fixture.repoRoot, "feature/noise", "noise.txt", "noise\n");
    withFilter(fixture, { ignoredBranches: ["feature/noise"] });
    const service = serviceFor(fixture);

    const hidden = await service.list(fixture.project);
    expect(itemFor(hidden, "feature/noise")).toBeUndefined();
    expect(hidden.filteredOutCount).toBe(1);
    expect(itemFor(hidden, "feature/ahead")).toBeDefined();

    const all = await service.list(fixture.project, { includeFiltered: true });
    expect(itemFor(all, "feature/noise")?.isIgnored).toBe(true);
    expect(all.filteredOutCount).toBe(0);
  });

  it("模式模式只保留匹配的分支，主分支永远在", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "factory/one", "one.txt", "one\n");
    createBranch(fixture.repoRoot, "feature/two", "two.txt", "two\n");
    withFilter(fixture, { filterMode: "patterns", branchPatterns: ["factory/*"] });
    const service = serviceFor(fixture);

    const inventory = await service.list(fixture.project);

    expect(itemFor(inventory, "factory/one")).toBeDefined();
    expect(itemFor(inventory, "feature/two")).toBeUndefined();
    expect(itemFor(inventory, "main")?.kind).toBe("base_branch");
    expect(inventory.filteredOutCount).toBe(1);
  });

  it("关闭 detached 开关后，detached worktree 不进清单但仍可显式查看", async () => {
    const fixture = setup();
    git(fixture.repoRoot, ["worktree", "add", "--detach", join(fixture.worktreeRoot, "detached"), "main"]);
    withFilter(fixture, { includeDetachedWorktrees: false });
    const service = serviceFor(fixture);

    expect((await service.list(fixture.project)).items.some((item) => item.isDetached)).toBe(false);
    expect((await service.list(fixture.project, { includeFiltered: true })).items.some((item) => item.isDetached)).toBe(true);
  });

  it("被过滤的分支仍然可以预览：写路径按全量清单解析", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    withFilter(fixture, { ignoredBranches: ["feature/ahead"] });

    const preview = await serviceFor(fixture).preview(fixture.project, "branch:feature/ahead");

    expect(preview.canConfirm).toBe(true);
  });
});

describe("曾经合并过", () => {
  it("合并后又有新提交的分支标记为 was_merged_before", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const service = serviceFor(fixture);
    const preview = await service.preview(fixture.project, "branch:feature/ahead");
    await service.merge(fixture.project, {
      itemId: "branch:feature/ahead",
      expectedBranchHead: preview.expectedBranchHead,
      expectedBaseHead: preview.expectedBaseHead,
    });

    // 合并之后又推了一个提交：现在既不 merged，也不是从未合并过。
    git(fixture.repoRoot, ["switch", "feature/ahead"]);
    writeFileSync(join(fixture.repoRoot, "later.txt"), "later\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "later change");
    git(fixture.repoRoot, ["switch", "main"]);

    const item = itemFor(await service.list(fixture.project), "feature/ahead");
    expect(item?.everMerged).toBe(true);
    expect(item?.mergeRelation).toBe("was_merged_before");
    expect(item?.status).toBe("committed_unmerged");
  });
});

describe("删除已合并的本地分支", () => {
  it("无 worktree 且已合并的本地分支可以删除", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/done", "done.txt", "done\n");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/done"]);
    const service = serviceFor(fixture);
    const item = itemFor(await service.list(fixture.project), "feature/done");

    expect(item?.kind).toBe("local_branch");
    expect(item?.cleanupable).toBe(true);

    const result = await service.cleanup(fixture.project, { itemId: "branch:feature/done", expectedBranchHead: item?.lastCommit ?? null });

    expect(result.branchDeleted).toBe(true);
    expect(result.worktreeRemoved).toBe(false);
    expect(() => git(fixture.repoRoot, ["rev-parse", "--verify", "refs/heads/feature/done"])).toThrow();
  });

  it("仓库停在别的分支时也能删除已合并分支（git -d 只与 HEAD 比较）", async () => {
    const fixture = setup();
    // 先造一条基于**合并之前**的 main 的分支，最后把仓库切过去——它不包含那条合并提交。
    git(fixture.repoRoot, ["switch", "-c", "feature/other", "main"]);
    writeFileSync(join(fixture.repoRoot, "other.txt"), "other\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "other change");
    git(fixture.repoRoot, ["switch", "main"]);

    createBranch(fixture.repoRoot, "feature/done", "done.txt", "done\n");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/done"]);
    git(fixture.repoRoot, ["switch", "feature/other"]);

    const service = serviceFor(fixture);
    const item = itemFor(await service.list(fixture.project), "feature/done");
    expect(item?.cleanupable).toBe(true);

    const result = await service.cleanup(fixture.project, {
      itemId: "branch:feature/done",
      expectedBranchHead: item?.lastCommit ?? null,
    });

    expect(result.branchDeleted).toBe(true);
    expect(() => git(fixture.repoRoot, ["rev-parse", "--verify", "refs/heads/feature/done"])).toThrow();
    // 当前分支不能被误删
    expect(git(fixture.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/other");
  });

  it("未合并的本地分支不能删除", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const item = itemFor(await serviceFor(fixture).list(fixture.project), "feature/ahead");

    expect(item?.cleanupable).toBe(false);
    expect(item?.cleanupBlockers.join("\n")).toContain("未合并");
  });

  it("正被仓库检出的合并分支不能删除", async () => {
    const fixture = setup();
    // main 自己就是"已合并且被检出"——用主分支验证这条判据（主分支另有一条更早的阻断）。
    const item = itemFor(await serviceFor(fixture).list(fixture.project), "main");
    expect(item?.cleanupBlockers.join("\n")).toContain("主分支不能清理");
  });
});

describe("detached worktree 的清理", () => {
  it("提交已被本地分支包含时可以删除目录（提交不丢）", async () => {
    const fixture = setup();
    const detachedPath = join(fixture.worktreeRoot, "detached-main");
    git(fixture.repoRoot, ["worktree", "add", "--detach", detachedPath, "main"]);
    const service = serviceFor(fixture);
    const item = (await service.list(fixture.project)).items.find((entry) => entry.itemId === `detached:${realpathSync(detachedPath)}`);

    expect(item?.containedInBranch).toBe(true);
    expect(item?.cleanupable).toBe(true);

    const result = await service.cleanup(fixture.project, {
      itemId: item?.itemId ?? "",
      expectedBranchHead: item?.lastCommit ?? null,
    });

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(git(fixture.repoRoot, ["worktree", "list"])).not.toContain("detached-main");
  });

  it("有独有提交的 detached worktree 不能删除", async () => {
    const fixture = setup();
    const detachedPath = join(fixture.worktreeRoot, "detached-unique");
    git(fixture.repoRoot, ["worktree", "add", "--detach", detachedPath, "main"]);
    writeFileSync(join(detachedPath, "unique.txt"), "unique\n");
    git(detachedPath, ["add", "-A"]);
    commit(detachedPath, "unique commit");
    const service = serviceFor(fixture);
    const item = (await service.list(fixture.project)).items.find((entry) => entry.isDetached);

    expect(item?.containedInBranch).toBe(false);
    expect(item?.cleanupable).toBe(false);
    expect(item?.cleanupBlockers.join("\n")).toContain("不属于任何本地分支");
  });
});

describe("进行中的 Git 操作", () => {
  it("rebase 进行中时如实报告并阻断合并", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/conflict", "README.md", "feature side\n");
    writeFileSync(join(fixture.repoRoot, "README.md"), "main side\n");
    git(fixture.repoRoot, ["add", "-A"]);
    commit(fixture.repoRoot, "main changes README");
    git(fixture.repoRoot, ["switch", "feature/conflict"]);
    // 这一步会冲突并停在 rebase 中间（rebase-merge 目录存在）。
    expect(() => git(fixture.repoRoot, ["rebase", "main"])).toThrow();
    const service = serviceFor(fixture);

    const inventory = await service.list(fixture.project);

    expect(inventory.mergeInProgress?.kind).toBe("rebase");
    const branch = itemFor(inventory, "feature/conflict");
    expect(branch?.mergeable).toBe(false);
    expect(branch?.blockers.join("\n")).toContain("rebase");
    // 收尾，避免残留状态影响同文件后面的用例（每个用例的仓库是独立的，这里只是整洁）。
    git(fixture.repoRoot, ["rebase", "--abort"]);
  });
});

describe("按 itemId 只解析 worktree 路径", () => {
  it("有 worktree 的分支、detached 都返回路径；无 worktree 的本地分支返回 null", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    createBranch(fixture.repoRoot, "feature/local", "local.txt", "local\n");
    const worktreePath = addWorktree(fixture, "feature/ahead", "ahead");
    git(fixture.repoRoot, ["worktree", "add", "--detach", join(fixture.worktreeRoot, "detached"), "main"]);
    const service = serviceFor(fixture);

    expect(await service.worktreePathFor(fixture.project, "branch:feature/ahead")).toBe(realpathSync(worktreePath));
    expect(await service.worktreePathFor(fixture.project, "branch:feature/local")).toBeNull();
    expect(await service.worktreePathFor(fixture.project, `detached:${realpathSync(join(fixture.worktreeRoot, "detached"))}`)).toBeTruthy();
    await expect(service.worktreePathFor(fixture.project, "branch:nope")).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
  });
});

describe("提交历史与 diff", () => {
  it("返回提交列表、单个提交的文件与文本 diff", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/ahead", "ahead.txt", "ahead\n");
    const service = serviceFor(fixture);

    const commits = await service.log(fixture.project, { ref: "feature/ahead", limit: 10 });
    expect(commits[0]?.subject).toContain("feature/ahead");
    expect(commits[0]?.shortHash).toHaveLength(7);

    const files = await service.commitFiles(fixture.project, commits[0]?.hash ?? "");
    expect(files.map((file) => file.path)).toContain("ahead.txt");

    const diff = await service.commitDiff(fixture.project, { commit: commits[0]?.hash ?? "", path: "ahead.txt" });
    expect(diff).toContain("+ahead");
  });

  it("不存在 ref / 提交时返回 WORKTREE_NOT_FOUND", async () => {
    const fixture = setup();
    const service = serviceFor(fixture);
    await expect(service.log(fixture.project, { ref: "nope" })).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
    await expect(service.commitFiles(fixture.project, "deadbeef")).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
  });
});
