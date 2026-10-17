/**
 * 模块职责：**项目视角**的 Worktree 业务边界 —— 盘点、合并预览、执行合并、冲突续做/中止、清理，
 *   以及合并成功后把结果追回 Factory 的 MergeRequest / Plan。
 *
 * 为什么放在 domain 而不是路由里：这里的每一条判据都是业务不变量（"有活动 Run 时不许合并"、
 *   "只有 merged_clean 才许清理"、"合并事实一旦发生就不回滚"），HTTP 只是它的一个入口。
 *   路由负责参数形状与状态码，判据与顺序全部在本文件。
 *
 * 维护提示：
 *   1) **本服务确实会执行 `git merge`**——这与 `run/merge.ts` 的 `MergeService` 是两件事，
 *      不要合并：`MergeService` 从不合并，它只把"验证通过的 Run"变成待人工确认的请求，
 *      并按 Git 的只读观察回填 `detectedTargetCommit`；本服务做的是人从 Worktree 面板按下的
 *      那一次真实合并。两者唯一的衔接点是 `syncFactoryAfterMerge`，且**只认 OPEN 的 MergeRequest**。
 *   2) **判据在预览与执行时各跑一次**。确认时不能只信预览的结论：从预览到点确认之间，base 可能
 *      前进了、Run 可能起来了、工作区可能脏了。所以 `merge()` 重新 `buildPreview()` 并**另加**
 *      `expectedBranchHead` / `expectedBaseHead` 的比对——"我审核的那一版"与"实际合并的那一版"
 *      必须是同一版，不一致就报 `WORKTREE_STATE_CHANGED` 让用户重看，绝不"按最新状态继续"。
 *   3) **冲突后停在合并中是有意的**：不自动 `merge --abort`（那会丢掉用户可能想保留的解冲突进度），
 *      也不自动 `--continue`（未解决完就 continue 只会报错）。界面靠 `GET /worktrees` 的
 *      `mergeInProgress` 常驻提示；这个状态会挡住后续 Plan 确认与 Run 派发（工作区干净检查），
 *      所以它必须显眼，不能只在一次响应里出现。
 *   4) **合并成功后自动推进 Factory，但失败不回滚**：合并已经写进 Git 是既成事实；`confirmMerged`
 *      或 worktree 回收失败只作为提醒返回（与 `routes/merge-requests.ts` 里 releaseWorkspace 的
 *      立场一致）。**只认 `status === "OPEN"`**：`SUPERSEDED` 的请求指向更早的 commit，
 *      承认它等于把没重新验证过的改动一起算成"已合并"。
 *   5) **清理严格按 `merged_clean`**：分支已合并 + worktree clean + 无冲突 + 无活动 Run + 该
 *      worktree 不是活动 Run 的 workspace。删分支用 `-d`（不是 `-D`），删目录不带 `--force`。
 *      detached worktree 一律不清理：没有分支可判定"已合并"，删掉就是丢提交。
 *   6) **同一项目的写操作串行**（`withProjectLock`）。两个标签页同时点合并时，第二个会排在后面，
 *      然后因为 base HEAD 已变而拿到 `WORKTREE_STATE_CHANGED` —— 这是正确结果，不是竞态失败。
 *   7) `list()` **不跑冲突预测**：`merge-tree` 对每条分支跑一次会把刷新拖成秒级。预览才预测。
 */
import { existsSync, realpathSync } from "node:fs";
import { EXECUTION_SLOT_RUN_STATUSES } from "../project/project.js";
import type { Project } from "../project/project.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { MergeService } from "../run/merge.js";
import type { Scheduler } from "../run/scheduler.js";
import type { Run } from "../run/types.js";
import { inspectWorkingTree } from "../git/working-tree.js";
import type {
  WorktreeFileChange,
  WorktreeFileSummary,
  WorktreeItem,
  WorktreeInventory,
  WorktreeMergePreview,
  WorktreeMergeResult,
  WorktreeCleanupResult,
  WorktreeFactoryLink,
  WorktreeGitDirtyState,
  WorktreeItemStatus,
} from "./types.js";
import type { WorktreeGitPort } from "./local-git.js";

/** 本域的错误码；路由按它映射 HTTP 状态，**不靠错误文案正则匹配**。 */
export type WorktreeErrorCode =
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_MERGE_BLOCKED"
  | "WORKTREE_CLEANUP_BLOCKED"
  | "WORKTREE_STATE_CHANGED"
  | "WORKTREE_NO_MERGE_IN_PROGRESS"
  | "WORKTREE_GIT_FAILED";

/** 带错误码的领域错误。`code` 是给调用方分支用的，`message` 是给人看的。 */
export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** 合并 / 清理的输入；两个 expected SHA 来自预览，用于乐观并发。 */
export type WorktreeMergeInput = { itemId: string; expectedBranchHead: string | null; expectedBaseHead: string | null };
export type WorktreeCleanupInput = { itemId: string; expectedBranchHead: string | null };

export type WorktreeServiceOptions = {
  git: WorktreeGitPort;
  /**
   * repoRoot 工作区干净检查的白名单（相对 repoRoot 的 git pathspec）。
   * 组合根传 Plan 留档目录 —— Factory 自己写的产物不该挡住一次合并。
   */
  ignoreDirtyPathsFor?: ((repoRoot: string) => readonly string[]) | undefined;
  /** 可缺省：只读实例与测试不装联动。缺省时合并照常执行，只是不推进 Plan。 */
  merger?: MergeService | undefined;
  /** 可缺省：缺省时合并后不回收 Worktree。 */
  scheduler?: Pick<Scheduler, "releaseWorkspace"> | undefined;
  /** 写成功后的通知（组合根接 `dispatchCoordinator.wake()`），避免界面停在过期投影上。 */
  onStateChanged?: (() => Promise<void> | void) | undefined;
  /** 清单里最多列出的分支数；超出置 `truncated`。 */
  maxBranches?: number | undefined;
};

const DEFAULT_MAX_BRANCHES = 300;

/** named branch 的分类；判据逐条对应 worktree-manage 的 `classify_named_branch_state`。 */
export function classifyNamedBranch(
  dirty: WorktreeGitDirtyState,
  ahead: number,
  merged: boolean,
  isBaseBranch: boolean,
): WorktreeItemStatus {
  if (isBaseBranch) return "no_updates";
  if (dirty === "conflict") return "merge_conflict";
  if (merged && dirty !== "clean") return "merged_dirty";
  if (merged) return "merged_clean";
  if (ahead > 0 && dirty === "clean") return "committed_unmerged";
  if (ahead > 0) return "dirty_with_commits";
  if (dirty !== "clean") return "dirty_uncommitted";
  return "no_updates";
}

/** detached worktree 的分类；它永远不会是 merged（没有可比较的分支）。 */
export function classifyDetached(dirty: WorktreeGitDirtyState, ahead: number): WorktreeItemStatus {
  if (dirty === "conflict") return "merge_conflict";
  if (ahead > 0 && dirty === "clean") return "detached_unmerged";
  if (ahead > 0) return "detached_dirty_with_commits";
  if (dirty !== "clean") return "detached_dirty";
  return "detached_clean";
}

/** 汇总 `--name-status` 的结果。 */
function summarizeFileChanges(changes: readonly WorktreeFileChange[]): WorktreeFileSummary {
  const summary: WorktreeFileSummary = {
    total: changes.length,
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    typeChanged: 0,
    unknown: 0,
  };
  for (const change of changes) {
    const kind = change.status.charAt(0);
    if (kind === "A") summary.added += 1;
    else if (kind === "M") summary.modified += 1;
    else if (kind === "D") summary.deleted += 1;
    else if (kind === "R") summary.renamed += 1;
    else if (kind === "C") summary.copied += 1;
    else if (kind === "T") summary.typeChanged += 1;
    else summary.unknown += 1;
  }
  return summary;
}

export class WorktreeService {
  private readonly git: WorktreeGitPort;
  private readonly maxBranches: number;
  /** 按 projectId 串行的写锁；值是"当前排队链的尾"。 */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PipelineStore,
    private readonly options: WorktreeServiceOptions,
  ) {
    this.git = options.git;
    this.maxBranches = Math.max(1, options.maxBranches ?? DEFAULT_MAX_BRANCHES);
  }

  /** 盘点一个项目的全部分支与 worktree。只读；不跑冲突预测。 */
  async list(project: Project): Promise<WorktreeInventory> {
    const repoRoot = project.repoRoot;
    const baseBranch = project.defaultBranch;
    const warnings: string[] = [];
    // 仓库不可读时给一句能看懂的话：`SmokeRun` 这类项目删掉目录后，git 只会回一句
    // "git worktree list --porcelain 失败"，用户无从判断是路径没了还是 git 坏了。
    if (!existsSync(repoRoot)) {
      throw new WorktreeError("WORKTREE_GIT_FAILED", `仓库目录不存在：${repoRoot}（请检查项目设置里的仓库路径）`);
    }
    const worktrees = await this.readGit(() => this.git.listWorktrees(repoRoot), "读取 worktree 列表");
    const branches = await this.readGit(() => this.git.listBranches(repoRoot), "读取本地分支");
    const baseHead = await this.git.resolveCommit(repoRoot, baseBranch);
    const currentBranch = await this.git.currentBranch(repoRoot);
    const mergeHead = await this.git.mergeHead(repoRoot);
    const conflictFiles = mergeHead ? await this.git.conflictFiles(repoRoot) : [];
    const activeRuns = this.activeRuns(project.id);

    let mergedBranches = new Set<string>();
    try {
      mergedBranches = new Set(await this.git.mergedBranches(repoRoot, baseBranch));
    } catch (error) {
      warnings.push(`无法读取已合并分支：${error instanceof Error ? error.message : String(error)}`);
    }

    const repoDirty = await this.inspectRepoRoot(project).catch((error: unknown) => ({
      clean: false,
      paths: [`（工作区状态读取失败：${error instanceof Error ? error.message : String(error)}）`],
    }));

    const worktreeByBranch = new Map<string, (typeof worktrees)[number]>();
    const detachedWorktrees: (typeof worktrees)[number][] = [];
    for (const worktree of worktrees) {
      if (worktree.bare) continue;
      if (worktree.branch) worktreeByBranch.set(worktree.branch, worktree);
      else detachedWorktrees.push(worktree);
    }

    // base 被哪个 worktree 占用：合并要先 `switch` 到 base，被占用时 git 会拒绝。
    const baseWorktree = worktrees.find((worktree) => worktree.branch === baseBranch);
    const baseOccupiedElsewhere = baseWorktree && !samePath(baseWorktree.path, repoRoot) ? baseWorktree.path : null;

    const runsByBranch = this.runsByBranch(project.id);
    const truncated = branches.length > this.maxBranches;
    const visibleBranches = truncated ? branches.slice(0, this.maxBranches) : branches;

    const items: WorktreeItem[] = [];
    for (const branch of visibleBranches) {
      const worktree = worktreeByBranch.get(branch.name);
      // 展示与 `git worktree remove` 都用 git 自报的路径；**比较**一律走 `samePath`（见 normalizeFsPath）。
      const worktreePath = worktree ? worktree.path : null;
      const missing = worktreePath ? !existsSync(worktreePath) : false;
      const { dirty, conflictFiles: itemConflicts } = await this.dirtyState(worktreePath, missing, warnings);
      const isBaseBranch = branch.name === baseBranch;
      const { ahead, behind } = isBaseBranch
        ? { ahead: 0, behind: 0 }
        : await this.aheadBehindSafe(repoRoot, baseBranch, branch.name, warnings);
      const merged = isBaseBranch || mergedBranches.has(branch.name);
      const status = classifyNamedBranch(dirty, ahead, merged, isBaseBranch);

      const cheap = this.cheapMergeVerdict({
        branch: branch.name,
        isBaseBranch,
        detached: false,
        ahead,
        merged,
        dirty,
        worktreePath,
        missing,
        activeRunIds: activeRuns,
        mergeInProgress: Boolean(mergeHead),
        baseOccupiedElsewhere,
        repoDirtyPaths: repoDirty.clean ? [] : repoDirty.paths,
      });

      items.push({
        itemId: `branch:${branch.name}`,
        kind: isBaseBranch ? "base_branch" : worktreePath ? "branch_worktree" : "local_branch",
        branch: branch.name,
        displayName: branch.name,
        isBaseBranch,
        hasWorktree: Boolean(worktreePath),
        isDetached: false,
        worktreePath,
        effectivePath: worktreePath ?? repoRoot,
        missing,
        status,
        mergeRelation: merged ? "current_merged" : "current_unmerged",
        gitDirtyState: dirty,
        conflictFiles: itemConflicts,
        aheadCount: ahead,
        behindCount: behind,
        merged,
        lastCommit: branch.head,
        lastCommitAt: branch.committedAt,
        mergeable: cheap.blockers.length === 0,
        blockers: cheap.blockers,
        cleanupable: cheap.cleanupBlockers.length === 0,
        cleanupBlockers: cheap.cleanupBlockers,
        isLiveRunWorkspace: this.isLiveWorkspace(worktreePath, activeRuns),
        factory: runsByBranch.get(branch.name) ?? null,
      });
    }

    for (const worktree of detachedWorktrees) {
      const worktreePath = worktree.path;
      const missing = !existsSync(worktreePath);
      const { dirty, conflictFiles: itemConflicts } = await this.dirtyState(worktreePath, missing, warnings);
      const head = worktree.head;
      const { ahead, behind } =
        head && baseHead ? await this.aheadBehindSafe(repoRoot, baseBranch, head, warnings) : { ahead: 0, behind: 0 };
      const status = classifyDetached(dirty, ahead);
      items.push({
        itemId: `detached:${worktreePath}`,
        kind: "detached_worktree",
        branch: null,
        displayName: head ? `detached @ ${head.slice(0, 7)}` : "detached",
        isBaseBranch: false,
        hasWorktree: true,
        isDetached: true,
        worktreePath,
        effectivePath: worktreePath,
        missing,
        status,
        mergeRelation: "detached",
        gitDirtyState: dirty,
        conflictFiles: itemConflicts,
        aheadCount: ahead,
        behindCount: behind,
        merged: false,
        lastCommit: head,
        lastCommitAt: null,
        mergeable: false,
        blockers: ["detached worktree 没有分支名，不能合并。"],
        cleanupable: false,
        cleanupBlockers: ["detached worktree 没有分支可判定是否已合并，不能清理（会丢失提交）。"],
        isLiveRunWorkspace: this.isLiveWorkspace(worktreePath, activeRuns),
        factory: null,
      });
    }

    if (!repoDirty.clean) {
      warnings.push(`仓库工作目录不是 clean 状态（${repoDirty.paths.slice(0, 5).join("、")}），合并前需要先提交或 stash。`);
    }
    items.sort((left, right) => {
      if (left.isBaseBranch !== right.isBaseBranch) return left.isBaseBranch ? -1 : 1;
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return left.displayName.localeCompare(right.displayName);
    });

    return {
      projectId: project.id,
      repoRoot,
      baseBranch,
      baseHead,
      currentBranch,
      mergeInProgress: mergeHead ? { mergeHead, currentBranch, conflictFiles } : null,
      activeRunIds: activeRuns.map((run) => run.id),
      items,
      truncated,
      warnings,
    };
  }

  /** 合并预览：跑全部阻断判据 + 提交/文件变更 + 冲突预测。**确认合并的唯一依据。** */
  async preview(project: Project, itemId: string): Promise<WorktreeMergePreview> {
    const inventory = await this.list(project);
    const item = inventory.items.find((candidate) => candidate.itemId === itemId);
    if (!item) throw new WorktreeError("WORKTREE_NOT_FOUND", `分支或 worktree 不存在：${itemId}`);

    const blockers = [...item.blockers];
    const warnings: string[] = [];
    const baseHead = inventory.baseHead;
    let taskHead: string | null = null;
    let mergeBase: string | null = null;
    let recentCommits: WorktreeMergePreview["recentCommits"] = [];
    let fileChanges: WorktreeMergePreview["fileChanges"] = [];
    let conflictPrediction: WorktreeMergePreview["conflictPrediction"] = {
      status: "unavailable",
      hasConflicts: false,
      conflictFiles: [],
      message: "缺少分支名，已跳过冲突预测。",
    };

    if (item.branch) {
      taskHead = await this.git.resolveCommit(project.repoRoot, item.branch);
      if (!taskHead) blockers.push("该分支在当前仓库中不存在。");
      if (taskHead && baseHead) {
        mergeBase = await this.git.mergeBase(project.repoRoot, project.defaultBranch, item.branch);
        if (!mergeBase) warnings.push("找不到共同祖先，无法计算文件变更与冲突预测。");
        if (mergeBase) {
          try {
            fileChanges = await this.git.diffNameStatus(project.repoRoot, mergeBase, item.branch);
          } catch (error) {
            warnings.push(`文件变更读取失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          recentCommits = await this.git.recentCommits(project.repoRoot, project.defaultBranch, item.branch, 5);
        } catch (error) {
          warnings.push(`提交记录读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const prediction = await this.git.predictConflicts(project.repoRoot, project.defaultBranch, item.branch);
        conflictPrediction = { ...prediction, hasConflicts: prediction.status === "conflicts" };
        if (conflictPrediction.status === "unavailable" && conflictPrediction.message) {
          warnings.push(conflictPrediction.message);
        }
      }
    }

    if (item.behindCount > 0) {
      warnings.push(`主分支有 ${item.behindCount} 个提交不在该分支中（合并仍可进行）。`);
    }
    if (item.factory && item.factory.verificationStatus !== "PASSED" && item.factory.verificationStatus !== "SKIPPED") {
      warnings.push("该分支属于一条尚未通过验证的 Run；合并之后 Factory 不会自动把它标记为已合并。");
    }
    if (item.factory && item.factory.mergeRequestStatus === null) {
      warnings.push("该分支还没有 MergeRequest；合并只发生在 Git 里，Plan 不会因此推进到 MERGED。");
    }

    const canConfirm = blockers.length === 0;
    const conclusion: WorktreeMergePreview["conclusion"] = !canConfirm
      ? "blocked"
      : conflictPrediction.hasConflicts
        ? "conflict_risk"
        : "ready";
    const conclusionLabel = conclusion === "blocked" ? "需要处理" : conclusion === "conflict_risk" ? "可能冲突" : "可以合并";

    return {
      projectId: project.id,
      repoRoot: project.repoRoot,
      itemId: item.itemId,
      branch: item.branch,
      baseBranch: project.defaultBranch,
      baseHead,
      taskHead,
      mergeBase,
      aheadCount: item.aheadCount,
      behindCount: item.behindCount,
      dirtyState: item.gitDirtyState,
      merged: item.merged,
      conclusion,
      conclusionLabel,
      canConfirm,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      recentCommits,
      fileSummary: summarizeFileChanges(fileChanges),
      fileChanges,
      conflictPrediction,
      commands: item.branch
        ? [`git -C ${project.repoRoot} switch ${project.defaultBranch}`, `git -C ${project.repoRoot} merge --no-ff ${item.branch}`]
        : [],
      expectedBranchHead: taskHead ?? item.lastCommit,
      expectedBaseHead: baseHead,
      factory: item.factory,
    };
  }

  /** 执行合并。见维护提示 2：判据重跑 + 乐观并发比对，缺一不可。 */
  async merge(project: Project, input: WorktreeMergeInput): Promise<WorktreeMergeResult> {
    return this.withProjectLock(project.id, async () => {
      const preview = await this.preview(project, input.itemId);
      if (!preview.canConfirm) {
        throw new WorktreeError("WORKTREE_MERGE_BLOCKED", preview.blockers.join("\n"));
      }
      if (!preview.branch || !preview.expectedBranchHead) {
        throw new WorktreeError("WORKTREE_MERGE_BLOCKED", "缺少分支名，不能合并 detached worktree。");
      }
      if (input.expectedBaseHead !== preview.expectedBaseHead || input.expectedBranchHead !== preview.expectedBranchHead) {
        throw new WorktreeError("WORKTREE_STATE_CHANGED", "仓库状态在预览之后发生了变化，请重新预览再合并。");
      }

      const baseHeadBefore = preview.expectedBaseHead;
      const baseBranch = project.defaultBranch;
      const currentBranch = await this.git.currentBranch(project.repoRoot);
      const commands: string[] = [];
      if (currentBranch !== baseBranch) {
        commands.push(`git -C ${project.repoRoot} switch ${baseBranch}`);
        const switched = await this.git.switchBranch(project.repoRoot, baseBranch);
        if (!switched.ok) {
          throw new WorktreeError("WORKTREE_MERGE_BLOCKED", `无法切换到主分支 ${baseBranch}：${switched.message}`);
        }
      }
      commands.push(`git -C ${project.repoRoot} merge --no-ff ${preview.branch}`);

      const merged = await this.git.merge(project.repoRoot, preview.branch);
      if (merged.ok) {
        const baseHeadAfter = await this.git.resolveCommit(project.repoRoot, baseBranch);
        const factory = await this.syncFactoryAfterMerge(project, preview.branch, baseHeadAfter);
        this.appendEvent("worktree.merge.completed", project.id, {
          projectId: project.id,
          itemId: preview.itemId,
          branch: preview.branch,
          baseBranch,
          baseHeadBefore,
          baseHeadAfter,
        });
        return {
          status: "merged",
          message: merged.stdout || "合并完成。",
          branch: preview.branch,
          baseBranch,
          conflictFiles: [],
          baseHeadBefore,
          baseHeadAfter,
          commands,
          factory,
        };
      }

      // 失败：先分清"有冲突"与"别的错"。冲突留在工作区里，由人决定继续还是中止。
      const conflictFiles = await this.git.conflictFiles(project.repoRoot).catch(() => []);
      const stillMerging = Boolean(await this.git.mergeHead(project.repoRoot));
      if (conflictFiles.length > 0 || stillMerging) {
        this.appendEvent("worktree.merge.conflict", project.id, {
          projectId: project.id,
          itemId: preview.itemId,
          branch: preview.branch,
          baseBranch,
          conflictFiles,
        });
        return {
          status: "merge_conflict",
          message: merged.stderr || "合并产生冲突，请解决后继续合并，或中止本次合并。",
          branch: preview.branch,
          baseBranch,
          conflictFiles,
          baseHeadBefore,
          baseHeadAfter: await this.git.resolveCommit(project.repoRoot, baseBranch),
          commands,
          factory: null,
        };
      }
      return {
        status: "error",
        message: merged.stderr || "合并失败。",
        branch: preview.branch,
        baseBranch,
        conflictFiles,
        baseHeadBefore,
        baseHeadAfter: await this.git.resolveCommit(project.repoRoot, baseBranch),
        commands,
        factory: null,
      };
    });
  }

  /** 继续一次冲突中的合并。未解决完的冲突会让 git 直接报错，原样返回。 */
  async continueMerge(project: Project): Promise<WorktreeMergeResult> {
    return this.withProjectLock(project.id, async () => {
      const mergeHead = await this.git.mergeHead(project.repoRoot);
      if (!mergeHead) throw new WorktreeError("WORKTREE_NO_MERGE_IN_PROGRESS", "当前没有进行中的合并。");
      const sourceBranch = await this.branchAtCommit(project, mergeHead);
      const baseBranch = project.defaultBranch;
      const baseHeadBefore = await this.git.resolveCommit(project.repoRoot, baseBranch);
      const result = await this.git.continueMerge(project.repoRoot);
      if (result.ok) {
        const baseHeadAfter = await this.git.resolveCommit(project.repoRoot, baseBranch);
        const factory = sourceBranch ? await this.syncFactoryAfterMerge(project, sourceBranch, baseHeadAfter) : null;
        this.appendEvent("worktree.merge.continued", project.id, {
          projectId: project.id,
          branch: sourceBranch,
          baseBranch,
          baseHeadBefore,
          baseHeadAfter,
        });
        return {
          status: "merged",
          message: result.stdout || "合并继续完成。",
          branch: sourceBranch,
          baseBranch,
          conflictFiles: [],
          baseHeadBefore,
          baseHeadAfter,
          commands: [`git -C ${project.repoRoot} merge --continue`],
          factory,
        };
      }
      const conflictFiles = await this.git.conflictFiles(project.repoRoot).catch(() => []);
      return {
        status: conflictFiles.length > 0 ? "merge_conflict" : "error",
        message: result.stderr || "继续合并失败。",
        branch: sourceBranch,
        baseBranch,
        conflictFiles,
        baseHeadBefore,
        baseHeadAfter: baseHeadBefore,
        commands: [`git -C ${project.repoRoot} merge --continue`],
        factory: null,
      };
    });
  }

  /** 中止一次冲突中的合并，把工作区恢复到合并前。 */
  async abortMerge(project: Project): Promise<WorktreeMergeResult> {
    return this.withProjectLock(project.id, async () => {
      const mergeHead = await this.git.mergeHead(project.repoRoot);
      if (!mergeHead) throw new WorktreeError("WORKTREE_NO_MERGE_IN_PROGRESS", "当前没有进行中的合并。");
      const sourceBranch = await this.branchAtCommit(project, mergeHead);
      const baseHead = await this.git.resolveCommit(project.repoRoot, project.defaultBranch);
      const result = await this.git.abortMerge(project.repoRoot);
      if (!result.ok) {
        throw new WorktreeError("WORKTREE_GIT_FAILED", result.stderr || "中止合并失败。");
      }
      this.appendEvent("worktree.merge.aborted", project.id, {
        projectId: project.id,
        branch: sourceBranch,
        baseBranch: project.defaultBranch,
      });
      return {
        status: "aborted",
        message: "已中止合并，工作区恢复到合并前。",
        branch: sourceBranch,
        baseBranch: project.defaultBranch,
        conflictFiles: [],
        baseHeadBefore: baseHead,
        baseHeadAfter: baseHead,
        commands: [`git -C ${project.repoRoot} merge --abort`],
        factory: null,
      };
    });
  }

  /** 清理一个已合并且干净的 branch worktree。见维护提示 5。 */
  async cleanup(project: Project, input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
    return this.withProjectLock(project.id, async () => {
      const inventory = await this.list(project);
      const item = inventory.items.find((candidate) => candidate.itemId === input.itemId);
      if (!item) throw new WorktreeError("WORKTREE_NOT_FOUND", `分支或 worktree 不存在：${input.itemId}`);
      if (item.kind !== "branch_worktree" || !item.branch || !item.worktreePath) {
        throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", item.cleanupBlockers.join("\n") || "只有已创建 worktree 的分支可以清理。");
      }
      if (item.cleanupBlockers.length > 0) {
        throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", item.cleanupBlockers.join("\n"));
      }
      if (input.expectedBranchHead !== item.lastCommit) {
        throw new WorktreeError("WORKTREE_STATE_CHANGED", "分支在预览之后发生了变化，请刷新后再清理。");
      }

      if (!existsSync(item.worktreePath)) {
        // 目录已经不在了：把 git 的登记也清掉，否则后面的 branch -d 会一直说"被 worktree 占用"。
        await this.git.pruneWorktrees(project.repoRoot);
      } else {
        const removed = await this.git.removeWorktree(project.repoRoot, item.worktreePath);
        if (!removed.ok) throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", `worktree 删除失败：${removed.message}`);
      }
      // 走到这里目录一定已经不在（要么本来就没有，要么刚刚删掉）。
      const worktreeRemoved = true;

      // 目录确认删掉之后才清库里的 workspacePath：删除失败时那条记录仍是事实，不能提前抹掉。
      const runWorkspaceCleared = this.clearRunWorkspace(project.id, item.worktreePath);
      const deleted = await this.git.deleteBranch(project.repoRoot, item.branch);
      this.appendEvent("worktree.cleaned", project.id, {
        projectId: project.id,
        itemId: item.itemId,
        branch: item.branch,
        worktreePath: item.worktreePath,
        worktreeRemoved,
        branchDeleted: deleted.ok,
      });
      return {
        message: deleted.ok ? "清理完成：worktree 与分支都已删除。" : `worktree 已删除，但分支未能删除：${deleted.message}`,
        worktreeRemoved,
        branchDeleted: deleted.ok,
        runWorkspaceCleared,
      };
    });
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  /**
   * 合并成功后把事实追回 Factory。**任何失败都降级成返回值，不影响合并结果**（维护提示 4）。
   */
  private async syncFactoryAfterMerge(
    project: Project,
    branch: string,
    targetCommit: string | null,
  ): Promise<WorktreeMergeResult["factory"]> {
    const run = this.latestRunForBranch(project.id, branch);
    if (!run || !targetCommit)
      return { mergeRequest: "not_found", runId: run?.id ?? null, workspace: null, message: "该分支不属于任何 Factory Run。" };
    const mergeRequest = this.store.findMergeRequestByRun(run.id);
    if (!mergeRequest) {
      return {
        mergeRequest: "not_found",
        runId: run.id,
        workspace: null,
        message: "该 Run 还没有 MergeRequest（未通过验证或未进入 MERGE_READY），Plan 不会推进到 MERGED。",
      };
    }
    if (mergeRequest.status !== "OPEN") {
      return {
        mergeRequest: "not_found",
        runId: run.id,
        workspace: null,
        message: `MergeRequest 当前状态是 ${mergeRequest.status}，不会因为这次合并被承认。`,
      };
    }
    if (!this.options.merger) {
      return { mergeRequest: "not_found", runId: run.id, workspace: null, message: "本实例没有装配 MergeService，无法确认合并。" };
    }
    try {
      this.options.merger.confirmMerged(mergeRequest.id, targetCommit);
    } catch (error) {
      return {
        mergeRequest: "failed",
        runId: run.id,
        workspace: null,
        message: `确认 MergeRequest 失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let workspace: { released: boolean; worktreeRemoved: boolean } | null = null;
    let message: string | null = null;
    if (this.options.scheduler) {
      try {
        const hooks = this.store.getProject(run.projectId)?.settings.hooks ?? {};
        const released = await this.options.scheduler.releaseWorkspace(run.id, hooks);
        workspace = { released: released.released, worktreeRemoved: released.worktreeRemoved };
        if (released.error) message = `worktree 回收失败：${released.error}`;
      } catch (error) {
        message = `worktree 回收失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await this.options.onStateChanged?.();
    return { mergeRequest: "confirmed", runId: run.id, workspace, message };
  }

  private activeRuns(projectId: string): Run[] {
    return this.store.listRuns().filter((run) => run.projectId === projectId && EXECUTION_SLOT_RUN_STATUSES.has(run.status));
  }

  private runsByBranch(projectId: string): Map<string, WorktreeFactoryLink> {
    const byBranch = new Map<string, Run>();
    for (const run of this.store.listRuns()) {
      if (run.projectId !== projectId) continue;
      const existing = byBranch.get(run.branch);
      if (!existing || existing.createdAt < run.createdAt) byBranch.set(run.branch, run);
    }
    const links = new Map<string, WorktreeFactoryLink>();
    for (const [branch, run] of byBranch) {
      links.set(branch, {
        runId: run.id,
        planId: run.planId,
        planTitle: this.store.getPlan(run.planId)?.title ?? null,
        runStatus: run.status,
        verificationStatus: this.store.getVerificationRun(run.id)?.status ?? null,
        mergeRequestStatus: this.store.findMergeRequestByRun(run.id)?.status ?? null,
      });
    }
    return links;
  }

  private latestRunForBranch(projectId: string, branch: string): Run | undefined {
    return this.store
      .listRuns()
      .filter((run) => run.projectId === projectId && run.branch === branch)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
  }

  /** 合并中时从 `MERGE_HEAD` 反查源分支：恰好一个本地分支指向它才算数，否则宁可不联动。 */
  private async branchAtCommit(project: Project, commit: string): Promise<string | null> {
    try {
      const branches = await this.git.listBranches(project.repoRoot);
      const matches = branches.filter((branch) => branch.head === commit).map((branch) => branch.name);
      return matches.length === 1 ? (matches[0] ?? null) : null;
    } catch {
      return null;
    }
  }

  private isLiveWorkspace(worktreePath: string | null, activeRuns: readonly Run[]): boolean {
    if (!worktreePath) return false;
    return activeRuns.some((run) => samePath(run.workspacePath, worktreePath));
  }

  private clearRunWorkspace(projectId: string, worktreePath: string): boolean {
    let cleared = false;
    for (const run of this.store.listRuns()) {
      if (run.projectId !== projectId || !run.workspacePath) continue;
      if (!samePath(run.workspacePath, worktreePath)) continue;
      this.store.saveRun({ ...run, workspacePath: null });
      cleared = true;
    }
    return cleared;
  }

  /** repoRoot 的工作区干净检查；白名单只放行 Factory 自己的产物（Plan 留档目录）。 */
  private async inspectRepoRoot(project: Project) {
    const ignorePaths = this.options.ignoreDirtyPathsFor?.(project.repoRoot) ?? [];
    return inspectWorkingTree({
      repoRoot: project.repoRoot,
      ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
      runGit: (args, cwd) => this.runRawGit(args, cwd),
    });
  }

  private async runRawGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.options.git.runRaw(args, cwd);
  }

  /** 把端口抛出的普通错误收敛成带错误码的领域错误（路由据此给出 409 而不是 500）。 */
  private async readGit<T>(action: () => Promise<T>, description: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new WorktreeError("WORKTREE_GIT_FAILED", `${description}失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async dirtyState(
    worktreePath: string | null,
    missing: boolean,
    warnings: string[],
  ): Promise<{ dirty: WorktreeGitDirtyState; conflictFiles: string[] }> {
    if (!worktreePath) return { dirty: "clean", conflictFiles: [] };
    if (missing) {
      warnings.push(`worktree 目录已不存在：${worktreePath}`);
      return { dirty: "clean", conflictFiles: [] };
    }
    try {
      const conflicts = await this.git.conflictFiles(worktreePath);
      if (conflicts.length > 0) return { dirty: "conflict", conflictFiles: conflicts };
      const status = await this.git.statusShort(worktreePath);
      return { dirty: status.length > 0 ? "dirty" : "clean", conflictFiles: [] };
    } catch (error) {
      warnings.push(`无法读取 ${worktreePath} 的工作区状态：${error instanceof Error ? error.message : String(error)}`);
      return { dirty: "clean", conflictFiles: [] };
    }
  }

  private async aheadBehindSafe(
    repoRoot: string,
    baseBranch: string,
    ref: string,
    warnings: string[],
  ): Promise<{ ahead: number; behind: number }> {
    try {
      return await this.git.aheadBehind(repoRoot, baseBranch, ref);
    } catch (error) {
      warnings.push(`无法比较 ${ref} 与 ${baseBranch}：${error instanceof Error ? error.message : String(error)}`);
      return { ahead: 0, behind: 0 };
    }
  }

  /** 清单层面的廉价判据；完整判据（冲突预测、文件变更）留给 `preview()`。 */
  private cheapMergeVerdict(input: {
    branch: string | null;
    isBaseBranch: boolean;
    detached: boolean;
    ahead: number;
    merged: boolean;
    dirty: WorktreeGitDirtyState;
    worktreePath: string | null;
    missing: boolean;
    activeRunIds: readonly Run[];
    mergeInProgress: boolean;
    baseOccupiedElsewhere: string | null;
    /** repoRoot 的脏路径（白名单已排除 Plan 留档目录）。合并要 `switch`，非空时必须阻断。 */
    repoDirtyPaths: readonly string[];
  }): { blockers: string[]; cleanupBlockers: string[] } {
    const blockers: string[] = [];
    if (input.detached) blockers.push("detached worktree 没有分支名，不能合并。");
    if (input.isBaseBranch) blockers.push("不能合并主分支自身。");
    if (!input.branch && !input.detached) blockers.push("缺少分支名，不能合并。");
    if (input.ahead === 0 && !input.isBaseBranch) blockers.push("该分支没有领先主分支的提交。");
    if (input.merged && !input.isBaseBranch) blockers.push("该分支已经合并到主分支。");
    // `missing` 的 worktree 读不到工作区状态；分支本身仍可合并，所以不在这里阻断。
    if (!input.missing && input.dirty !== "clean") {
      blockers.push(`worktree 当前不是 clean 状态，未提交内容不会进入合并：${input.dirty}。`);
    }
    if (input.repoDirtyPaths.length > 0) {
      blockers.push(`仓库工作目录有未提交改动（${input.repoDirtyPaths.slice(0, 5).join("、")}），合并前需要先提交或 stash。`);
    }
    if (input.activeRunIds.length > 0) {
      blockers.push(
        `项目有 ${input.activeRunIds.length} 条活动 Run（${input.activeRunIds
          .slice(0, 3)
          .map((run) => run.id)
          .join("、")}），先等它们结束再合并。`,
      );
    }
    if (input.mergeInProgress) blockers.push("仓库里已有进行中的合并，请先继续或中止它。");
    if (input.baseOccupiedElsewhere) {
      blockers.push(`主分支正被另一个 worktree 占用（${input.baseOccupiedElsewhere}），无法切换过去执行合并。`);
    }

    const cleanupBlockers: string[] = [];
    if (input.detached) cleanupBlockers.push("detached worktree 没有分支可判定是否已合并，不能清理（会丢失提交）。");
    else if (input.isBaseBranch) cleanupBlockers.push("主分支不能清理。");
    else if (!input.worktreePath) cleanupBlockers.push("这条分支没有 worktree，没有可清理的东西。");
    else {
      if (!input.merged) cleanupBlockers.push("该分支当前未合并到主分支，不能清理。");
      if (!input.missing && input.dirty !== "clean") cleanupBlockers.push(`worktree 当前不是 clean 状态（${input.dirty}），不能清理。`);
      if (input.activeRunIds.length > 0) cleanupBlockers.push("项目有活动 Run，暂不能清理。");
      if (input.activeRunIds.some((run) => samePath(run.workspacePath, input.worktreePath))) {
        cleanupBlockers.push("这个 worktree 正被一条活动 Run 使用，不能清理。");
      }
    }
    return { blockers, cleanupBlockers };
  }

  private appendEvent(
    type: Parameters<PipelineStore["appendEvent"]>[0]["type"],
    aggregateId: string,
    payload: Record<string, unknown>,
  ): void {
    this.store.appendEvent({ type, aggregateId, payload });
  }

  /** 同一项目的写操作排队执行；第二个请求会看到新的 base HEAD 并拿到 WORKTREE_STATE_CHANGED。 */
  private async withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.locks.set(projectId, chained);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(projectId) === chained) this.locks.delete(projectId);
    }
  }
}

/**
 * 路径比较用的归一化：**优先解析符号链接**。
 *
 * 这条不是洁癖：macOS 上 `/var` 是指向 `/private/var` 的符号链接，而 `git worktree list` 打印的是
 * 解析后的路径、`Project.repoRoot` 是用户配置里的那个。只做字符串比较会把"主分支正被自己占用"
 * 判成"被另一个 worktree 占用"，于是**任何合并都做不了**（实测：全部用例被这条挡住）。
 */
function normalizeFsPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path.replace(/\/+$/, "") || path;
  }
}

/** 两个路径是否指向同一个目录（都会先解析符号链接）。任一为空即为 false。 */
function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return normalizeFsPath(left) === normalizeFsPath(right);
}
