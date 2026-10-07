/**
 * 模块职责：Run 的 Git Worktree 边界 —— Workspace / WorkspaceAdapter 端口、它的本地 Git
 *   实现 LocalGitWorktreeAdapter，以及该实现默认使用的 defaultGitCommand。
 *
 * 为什么从 index.ts 抽出来（批 D：IO 边界）：与 platform/commands.ts、git/merge-inspector.ts
 *   同属"领域层里真的碰 IO 的三块"。搬迁前它混在 index.ts 里，任何想替换 Worktree 行为的
 *   测试都只能从 barrel 绕；搬出来之后它可以和同目录的 worktree-snapshot.ts 并排阅读 ——
 *   后者是本文件 create() 唯一调用的外部函数。
 *
 * 维护提示：
 *   1) **Git 命令的工作目录与 Explorer 的 repoRoot 是分离的**：所有 git 命令都跑在
 *      options.projectRoot，而不是 Worktree 内部；Workspace.path 只作为 worktree add/remove
 *      的参数。把 cwd 改成 workspace.path 会让"创建 Worktree"这件事反过来依赖一个尚不存在的
 *      目录。
 *   2) create() 的顺序不可调换：先 rev-parse --verify 确认 baseCommit 存在 → 再做**工作区干净检查**
 *      → 最后 worktree add。干净检查必须排在 worktree add **之前**：顺序颠倒会白建一个工作树再回滚，
 *      而且会让"基线为什么不对"这件事被回滚动作掩盖（见 git/working-tree.ts）。
 *   3) **基线恒等于 baseCommit**。本类不再把工作区里未提交的改动搬进新工作树——那个搬运曾由
 *      snapshotProjectWorkingTree 承担，在"派发要求工作区干净"之后它已无事可做，模块随之删除。
 *      未提交改动被干净检查挡在门外，而不是被悄悄搬进来：**用户本地看到的树与 Agent 改的树必须是
 *      同一棵**，否则"我本地明明是好的"这类纠纷无法收敛。改动没进工作树是**有意**的，不是遗漏。
 *   4) workspaceName 只接受 /^[A-Za-z0-9][A-Za-z0-9._-]*$/ 形式的分支叶子名，否则回落 runId。
 *      这条正则同时挡掉路径分隔符与 "." / ".." 开头，是 resolve() 不会把目录引出
 *      worktreeRoot 的唯一关口 —— 放宽它等于开放路径穿越。
 *   5) defaultGitCommand 用 64MB maxBuffer，并且**永远 resolve**：非 0 退出码通过 exitCode
 *      表达，不用 reject。调用方（本类与 git/working-tree.ts）一律读 exitCode 判定，
 *      改成 reject 会绕过这些判定。它是本模块私有，barrel 不转发。
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { inspectWorkingTree, workingTreeDirtyError } from "./working-tree.js";
import type { CommandResult } from "../platform/commands.js";

/** 一个 Run 的 Git Worktree 事实。 */
export type Workspace = { path: string; branch: string; baseCommit: string };
/** Worktree 创建/移除端口；实现必须使用 Revision 快照中的路径。 */
export type WorkspaceAdapter = {
  create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace>;
  remove(workspace: Workspace): Promise<void>;
};

/** 可注入的 Git 命令执行端口。 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
/**
 * 本地 Git Worktree 适配器配置。
 * `ignoreDirtyPaths` 是工作区干净检查的白名单（相对 projectRoot 的 git pathspec），
 * 只应放行 Factory 自己写的产物（Plan 落盘目录）——见 git/working-tree.ts 的维护提示 1。
 */
export type LocalGitWorktreeOptions = {
  projectRoot: string;
  worktreeRoot: string;
  ignoreDirtyPaths?: readonly string[] | undefined;
  runGit?: GitCommandRunner | undefined;
};

/** 使用 Git 创建和移除 Run 专属 Worktree；执行目录与只读 Explorer 的 repoRoot 分离。 */
export class LocalGitWorktreeAdapter implements WorkspaceAdapter {
  private readonly runGit: GitCommandRunner;

  constructor(private readonly options: LocalGitWorktreeOptions) {
    this.runGit = options.runGit ?? defaultGitCommand;
  }

  async create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace> {
    const branchLeaf = input.branch.slice(input.branch.lastIndexOf("/") + 1);
    const workspaceName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchLeaf) ? branchLeaf : input.runId;
    const path = resolve(this.options.worktreeRoot, workspaceName);
    const verified = await this.runGit(["rev-parse", "--verify", input.baseCommit], this.options.projectRoot);
    if (verified.exitCode !== 0) throw new Error(`Base commit ${input.baseCommit} could not be verified`);
    // 干净检查在 worktree add **之前**（顺序理由见类头维护提示 2）。
    const inspection = await inspectWorkingTree({
      repoRoot: this.options.projectRoot,
      ...(this.options.ignoreDirtyPaths ? { ignorePaths: this.options.ignoreDirtyPaths } : {}),
      runGit: this.runGit,
    });
    if (!inspection.clean) throw workingTreeDirtyError(inspection.paths);
    const created = await this.runGit(["worktree", "add", "-b", input.branch, path, input.baseCommit], this.options.projectRoot);
    if (created.exitCode !== 0) throw new Error(`Git worktree could not be created: ${created.stderr}`);
    // 基线恒等于 baseCommit（理由见类头维护提示 3）。
    return { path, branch: input.branch, baseCommit: input.baseCommit };
  }

  async remove(workspace: Workspace): Promise<void> {
    const removed = await this.runGit(["worktree", "remove", "--force", workspace.path], this.options.projectRoot);
    if (removed.exitCode !== 0) throw new Error(`Git worktree could not be removed: ${removed.stderr}`);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}
