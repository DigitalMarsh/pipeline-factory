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
  /**
   * 可缺省：把工作区里的改动提交到**它自己的分支**上，返回提交号（没有改动可提交时 `null`）。
   *
   * 缺省时就没有"Run 跑完自动提交"这一步——测试桩与无 Git 环境走这条，**不要改成必填**
   * （加必填成员会让十几处 worktree 桩跟着改，收益只有一行）。
   */
  commit?(workspace: Workspace, message: string): Promise<string | null>;
  /**
   * 可缺省：仓库里**真实存在的本地分支**（短名，含 `factory/` 前缀）。
   *
   * 它服务的是分支名分配：删掉 Run 行**不会**删掉仓库里那条分支，只问库就会拿到一个已经被占的
   * 叶子，`git worktree add -b` 当场失败、Run 被打成 `BLOCKED`（实测撞过）。
   * 缺省时分配器退回只看库里的 Run 分支——与加这个方法之前的行为一致。
   */
  listBranches?(): Promise<string[]>;
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

  /**
   * 把工作区里的改动提交到它自己的分支上，返回提交号；没有改动可提交时返回 `null`。
   *
   * 为什么归这一层：Worktree 的生命周期（建 / 收）本来就在这儿，提交是同一件事的第三步。
   *
   * **它不碰任何别的分支**——合并仍然由人在 Git 侧做，与 `MergeService` 那条链同一口径。
   * 提交发生在这里的理由是具体的：改动不落成提交，"确认合并"就只是一句空话（实测踩过：
   * 一个 Run 的修复一直躺在工作区里，分支 tip 等于 main tip，合并过去什么都没有）。
   *
   * `add -A` 尊重 `.gitignore`；忽略规则之外留下的临时文件会被一起提交，所以 Run 不该往
   * 工作区里丢垃圾。没有改动时**不**调 `commit`（那会以非 0 退出，且不是错误）。
   */
  async commit(workspace: Workspace, message: string): Promise<string | null> {
    const status = await this.runGit(["status", "--porcelain"], workspace.path);
    if (status.exitCode !== 0) throw new Error(`Git status failed in ${workspace.path}: ${status.stderr}`);
    if (!status.stdout.trim()) return null;
    /**
     * **排除工具自己的元数据目录**（服务配置）：它们属于本机的运行配置，不是这次 Run 的产物。
     * 不排除的话，`git add -A` 会把 `.pipeline-factory/services.json` 一起提交进分支，
     * 再随合并进主干——那是把本机配置当成代码发布。
     */
    const added = await this.runGit(["add", "-A", "--", ".", ":(exclude).pipeline-factory", ":(exclude).worktree-manage"], workspace.path);
    if (added.exitCode !== 0) throw new Error(`Git add failed in ${workspace.path}: ${added.stderr}`);
    const committed = await this.runGit(["commit", "-m", message], workspace.path);
    if (committed.exitCode !== 0) throw new Error(`Git commit failed in ${workspace.path}: ${committed.stderr}`);
    const head = await this.runGit(["rev-parse", "HEAD"], workspace.path);
    return head.exitCode === 0 ? head.stdout.trim() : null;
  }

  /**
   * 仓库里真实存在的本地分支（短名）。
   *
   * 这是"去问 git"的唯一一把把手：分支名分配器原先只问**库里记着的 Run 分支**，而删掉 Run 行不会
   * 删掉仓库里那条分支——实测撞过（`factory/20261007-fix-task-project-validation` 还在仓库里、
   * 库里那条 Run 早没了，新 Run 拿到同一个叶子，`git worktree add -b` 直接失败、Run 被打成
   * `BLOCKED`，界面上的「为什么停下」写着"分支已经存在"）。
   */
  async listBranches(): Promise<string[]> {
    const listed = await this.runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], this.options.projectRoot);
    if (listed.exitCode !== 0) throw new Error(`Git branch listing failed: ${listed.stderr}`);
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}
