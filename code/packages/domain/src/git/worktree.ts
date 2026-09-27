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
 *   2) create() 的三步顺序不可调换：先 rev-parse --verify 确认 baseCommit 存在 → 再
 *      worktree add 建出工作树 → 最后 snapshotProjectWorkingTree 把项目**当前未提交的改动**
 *      铺进新 Worktree 作为基线，并把基线 commit 作为 Workspace.baseCommit 返回。
 *      跳过第 3 步会让 Run 看到的是一棵干净的 baseCommit 树，而不是用户眼前的树。
 *   3) 第 3 步失败时**必须回滚**（worktree remove --force + branch -D，两步都用 catch 吞掉
 *      自身的异常），否则会留下一个已注册但基线错误的工作树，同名分支之后再也建不出来。
 *      回滚失败不掩盖原错误：抛出的仍是 baseline 那条。
 *   4) workspaceName 只接受 /^[A-Za-z0-9][A-Za-z0-9._-]*$/ 形式的分支叶子名，否则回落 runId。
 *      这条正则同时挡掉路径分隔符与 "." / ".." 开头，是 resolve() 不会把目录引出
 *      worktreeRoot 的唯一关口 —— 放宽它等于开放路径穿越。
 *   5) defaultGitCommand 用 64MB maxBuffer，并且**永远 resolve**：非 0 退出码通过 exitCode
 *      表达，不用 reject。调用方（snapshotProjectWorkingTree 与本类）一律读 exitCode 判定，
 *      改成 reject 会绕过这些判定。它是本模块私有，barrel 不转发。
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { snapshotProjectWorkingTree } from "./worktree-snapshot.js";
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
/** 本地 Git Worktree 适配器配置。 */
export type LocalGitWorktreeOptions = { projectRoot: string; worktreeRoot: string; runGit?: GitCommandRunner | undefined };

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
    const created = await this.runGit(["worktree", "add", "-b", input.branch, path, input.baseCommit], this.options.projectRoot);
    if (created.exitCode !== 0) throw new Error(`Git worktree could not be created: ${created.stderr}`);
    try {
      const baseCommit = await snapshotProjectWorkingTree({
        projectRoot: this.options.projectRoot,
        worktreeRoot: this.options.worktreeRoot,
        workspacePath: path,
        baseCommit: input.baseCommit,
        runGit: this.runGit,
      });
      return { path, branch: input.branch, baseCommit };
    } catch (error) {
      await this.runGit(["worktree", "remove", "--force", path], this.options.projectRoot).catch(() => undefined);
      await this.runGit(["branch", "-D", input.branch], this.options.projectRoot).catch(() => undefined);
      throw new Error(`Git worktree baseline could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async remove(workspace: Workspace): Promise<void> {
    const removed = await this.runGit(["worktree", "remove", "--force", workspace.path], this.options.projectRoot);
    if (removed.exitCode !== 0) throw new Error(`Git worktree could not be removed: ${removed.stderr}`);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

