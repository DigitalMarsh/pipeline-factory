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
import { DEFAULT_WORKTREE_FILTER, EXECUTION_SLOT_RUN_STATUSES } from "../project/project.js";
import type { Project, ProjectWorktreeFilter } from "../project/project.js";
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
  WorktreeInProgressOperation,
  WorktreeItemStatus,
  WorktreeLogCommit,
} from "./types.js";
import { WORKTREE_METADATA_DIRS } from "./local-git.js";
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
/**
 * 并发执行的 git 子进程上限。清单的每条分支要跑一次 `rev-list`，串行时 300 条分支就是 300 次
 * 进程往返（实测在主仓库上要好几秒）。并发 8 条能把墙钟时间压到 1/5 左右，同时不至于把
 * 机器打满（每个 git 进程自己也会再起线程）。
 */
const GIT_CONCURRENCY = 8;

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

/** worktree-manage 的分支模式匹配：`*` = 全部、`prefix*` = 前缀、其余精确匹配。 */
export function matchesBranchPattern(branch: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return branch.startsWith(pattern.slice(0, -1));
  return branch === pattern;
}

/** 分支是否命中项目设置的默认范围（模式之外的一律视为命中）。 */
export function matchesBranchScope(filter: ProjectWorktreeFilter, branch: string): boolean {
  if (filter.filterMode !== "patterns") return true;
  return filter.branchPatterns.some((pattern) => matchesBranchPattern(branch, pattern));
}

/** 有界并发的 map；用于把"每条分支一次 git 调用"摊开到几个进程上。 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 进行中的 Git 操作在界面/错误里的人话名字。 */
const OPERATION_LABEL: Record<WorktreeInProgressOperation, string> = {
  merge: "合并",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

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

  /**
   * 盘点一个项目的分支与 worktree。只读；不跑冲突预测。
   *
   * `includeFiltered` 为 true 时**忽略项目设置的默认范围**（模式/忽略/ detached 开关）。
   * 写操作（preview / merge / cleanup）一律用它解析目标——被项目隐藏的分支不该变成"不存在"。
   */
  async list(project: Project, options: { includeFiltered?: boolean } = {}): Promise<WorktreeInventory> {
    const repoRoot = project.repoRoot;
    const baseBranch = project.defaultBranch;
    const warnings: string[] = [];
    // 仓库不可读时给一句能看懂的话：`SmokeRun` 这类项目删掉目录后，git 只会回一句
    // "git worktree list --porcelain 失败"，用户无从判断是路径没了还是 git 坏了。
    if (!existsSync(repoRoot)) {
      throw new WorktreeError("WORKTREE_GIT_FAILED", `仓库目录不存在：${repoRoot}（请检查项目设置里的仓库路径）`);
    }
    const filter = project.settings.worktree ?? DEFAULT_WORKTREE_FILTER;
    const worktrees = await this.readGit(() => this.git.listWorktrees(repoRoot), "读取 worktree 列表");
    const branches = await this.readGit(() => this.git.listBranches(repoRoot), "读取本地分支");
    const baseHead = await this.git.resolveCommit(repoRoot, baseBranch);
    const currentBranch = await this.git.currentBranch(repoRoot);
    // 不只 merge：rebase / cherry-pick / revert / bisect 都会让 `git switch` 失败。
    const operation = await this.git.inProgressOperation(repoRoot).catch(() => null);
    const mergeHead = operation === "merge" ? await this.git.mergeHead(repoRoot) : null;
    const conflictFiles = operation ? await this.git.conflictFiles(repoRoot).catch(() => []) : [];
    const activeRuns = this.activeRuns(project.id);
    const everMerged = this.everMergedBranches(project.id);

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
    const includeFiltered = Boolean(options.includeFiltered);
    /** 先算范围（纯内存判断），再决定要不要为它跑 git —— 这是大仓库首屏开销的主要来源。 */
    const inScope = (branch: string, isBaseBranch: boolean): boolean =>
      isBaseBranch || (!filter.ignoredBranches.includes(branch) && matchesBranchScope(filter, branch));

    const named = await mapWithConcurrency(
      visibleBranches.filter((branch) => includeFiltered || inScope(branch.name, branch.name === baseBranch)),
      GIT_CONCURRENCY,
      async (branch): Promise<WorktreeItem> => {
        const worktree = worktreeByBranch.get(branch.name);
        // 展示与 `git worktree remove` 都用 git 自报的路径；**比较**一律走 `samePath`。
        const worktreePath = worktree ? worktree.path : null;
        const missing = worktreePath ? !existsSync(worktreePath) : false;
        const { dirty, conflictFiles: itemConflicts } = await this.dirtyState(worktreePath, missing, warnings);
        const isBaseBranch = branch.name === baseBranch;
        const { ahead, behind } = isBaseBranch
          ? { ahead: 0, behind: 0 }
          : await this.aheadBehindSafe(repoRoot, baseBranch, branch.name, warnings);
        const merged = isBaseBranch || mergedBranches.has(branch.name);
        const wasMerged = everMerged.has(branch.name);
        const status = classifyNamedBranch(dirty, ahead, merged, isBaseBranch);
        const isIgnored = !isBaseBranch && filter.ignoredBranches.includes(branch.name);
        const matchesScope = isBaseBranch || matchesBranchScope(filter, branch.name);

        const verdict = this.mergeAndCleanupVerdict({
          branch: branch.name,
          kind: isBaseBranch ? "base_branch" : worktreePath ? "branch_worktree" : "local_branch",
          detached: false,
          containedInBranch: true,
          ahead,
          merged,
          dirty,
          worktreePath,
          missing,
          currentBranch,
          activeRunIds: activeRuns,
          operation,
          baseOccupiedElsewhere,
          repoDirtyPaths: repoDirty.clean ? [] : repoDirty.paths,
        });

        return {
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
          mergeRelation: merged ? "current_merged" : wasMerged ? "was_merged_before" : "current_unmerged",
          gitDirtyState: dirty,
          conflictFiles: itemConflicts,
          aheadCount: ahead,
          behindCount: behind,
          merged,
          lastCommit: branch.head,
          lastCommitAt: branch.committedAt,
          mergeable: verdict.blockers.length === 0,
          blockers: verdict.blockers,
          cleanupable: verdict.cleanupBlockers.length === 0,
          cleanupBlockers: verdict.cleanupBlockers,
          isLiveRunWorkspace: this.isLiveWorkspace(worktreePath, activeRuns),
          everMerged: wasMerged,
          isIgnored,
          matchesScope,
          containedInBranch: true,
          factory: runsByBranch.get(branch.name) ?? null,
        };
      },
    );

    const detached = await mapWithConcurrency(
      includeFiltered || filter.includeDetachedWorktrees ? detachedWorktrees : [],
      GIT_CONCURRENCY,
      async (worktree): Promise<WorktreeItem> => {
        const worktreePath = worktree.path;
        const missing = !existsSync(worktreePath);
        const { dirty, conflictFiles: itemConflicts } = await this.dirtyState(worktreePath, missing, warnings);
        const head = worktree.head;
        const { ahead, behind } =
          head && baseHead ? await this.aheadBehindSafe(repoRoot, baseBranch, head, warnings) : { ahead: 0, behind: 0 };
        const live = this.isLiveWorkspace(worktreePath, activeRuns);
        /**
         * 只有"干净、目录在、没被 Run 占用"的 detached worktree 才值得去问"它的提交有没有别处收着"：
         * 脏的那几个连清都不能清，多跑一次 `for-each-ref` 只是浪费。
         */
        let containedInBranch = false;
        if (!missing && dirty === "clean" && !live && head) {
          containedInBranch = (await this.git.branchesContaining(repoRoot, head).catch(() => [])).length > 0;
        }
        const status = classifyDetached(dirty, ahead);
        const verdict = this.mergeAndCleanupVerdict({
          branch: null,
          kind: "detached_worktree",
          detached: true,
          containedInBranch,
          ahead,
          merged: false,
          dirty,
          worktreePath,
          missing,
          currentBranch,
          activeRunIds: activeRuns,
          operation,
          baseOccupiedElsewhere,
          repoDirtyPaths: repoDirty.clean ? [] : repoDirty.paths,
        });

        return {
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
          mergeable: verdict.blockers.length === 0,
          blockers: verdict.blockers,
          cleanupable: verdict.cleanupBlockers.length === 0,
          cleanupBlockers: verdict.cleanupBlockers,
          isLiveRunWorkspace: live,
          everMerged: false,
          isIgnored: false,
          matchesScope: filter.includeDetachedWorktrees,
          containedInBranch,
          factory: null,
        };
      },
    );

    if (!repoDirty.clean) {
      warnings.push(`仓库工作目录不是 clean 状态（${repoDirty.paths.slice(0, 5).join("、")}），合并前需要先提交或 stash。`);
    }
    const items = [...named, ...detached].sort((left, right) => {
      if (left.isBaseBranch !== right.isBaseBranch) return left.isBaseBranch ? -1 : 1;
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      return left.displayName.localeCompare(right.displayName);
    });
    const filteredOutCount = includeFiltered
      ? 0
      : visibleBranches.filter((branch) => branch.name !== baseBranch && !inScope(branch.name, false)).length +
        (filter.includeDetachedWorktrees ? 0 : detachedWorktrees.length);

    return {
      projectId: project.id,
      repoRoot,
      baseBranch,
      baseHead,
      currentBranch,
      mergeInProgress: operation ? { kind: operation, mergeHead, currentBranch, conflictFiles } : null,
      activeRunIds: activeRuns.map((run) => run.id),
      filter,
      filteredOutCount,
      items,
      truncated,
      warnings,
    };
  }

  /** 合并预览：跑全部阻断判据 + 提交/文件变更 + 冲突预测。**确认合并的唯一依据。** */
  async preview(project: Project, itemId: string): Promise<WorktreeMergePreview> {
    // 目标解析必须看**全量**清单：被项目范围隐藏的分支仍然可以被预览/合并。
    const inventory = await this.list(project, { includeFiltered: true });
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

    /**
     * 这条分支若挂着 `OPEN` 的 MergeRequest，**合并目标必须是那个请求的目标分支**。
     * 项目默认分支可以被改，而已确认的 Revision 冻结的是**当时**的 base branch；两者不一致时，
     * 在这里合并会合进另一条分支，随后的 `confirmMerged` 必然失败（target branch does not contain
     * the reviewed source commit）。与其合错地方再报错，不如先拦住。
     */
    if (item.factory?.mergeRequestStatus === "OPEN" && item.factory.runId) {
      const request = this.store.findMergeRequestByRun(item.factory.runId);
      if (request && request.targetBranch && request.targetBranch !== project.defaultBranch) {
        blockers.push(
          `该 Run 的 MergeRequest 目标是 ${request.targetBranch}，而项目默认分支是 ${project.defaultBranch}；请在 Git 侧按 MergeRequest 的目标分支合并。`,
        );
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

  /**
   * 清理一个"已合并 / 可安全删除"的项。三种 kind 走不同路径（判据见 `mergeAndCleanupVerdict`）：
   * branch worktree（删目录 + 删分支）、无 worktree 的本地分支（只删分支）、
   * detached worktree（只删目录，且要求提交已被某个本地分支包含）。
   */
  async cleanup(project: Project, input: WorktreeCleanupInput): Promise<WorktreeCleanupResult> {
    return this.withProjectLock(project.id, async () => {
      const inventory = await this.list(project, { includeFiltered: true });
      const item = inventory.items.find((candidate) => candidate.itemId === input.itemId);
      if (!item) throw new WorktreeError("WORKTREE_NOT_FOUND", `分支或 worktree 不存在：${input.itemId}`);
      if (item.cleanupBlockers.length > 0) {
        throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", item.cleanupBlockers.join("\n"));
      }
      if (input.expectedBranchHead !== item.lastCommit) {
        throw new WorktreeError("WORKTREE_STATE_CHANGED", "分支或 worktree 在预览之后发生了变化，请刷新后再清理。");
      }

      if (item.kind === "detached_worktree") {
        if (!item.worktreePath) throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", "detached worktree 缺少目录路径。");
        await this.removeWorktreePath(project.repoRoot, item.worktreePath);
        this.appendEvent("worktree.cleaned", project.id, {
          projectId: project.id,
          itemId: item.itemId,
          branch: null,
          worktreePath: item.worktreePath,
          worktreeRemoved: true,
          branchDeleted: false,
        });
        return {
          message: "清理完成：detached worktree 目录已删除（它的提交仍被本地分支包含）。",
          worktreeRemoved: true,
          branchDeleted: false,
          runWorkspaceCleared: this.clearRunWorkspace(project.id, item.worktreePath),
          cleanupHookNeedsAttention: false,
        };
      }

      if (!item.branch) throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", "缺少分支名，不能清理。");

      let worktreeRemoved = false;
      let cleanupHookNeedsAttention = false;
      if (item.worktreePath) {
        /**
         * 这个 worktree 若还是某条 Run 的 workspace，就走 Factory 自己的回收路径：
         * `releaseWorkspace` 会跑项目的 cleanup 钩子并把 `run.workspacePath` 清空。
         * **不能只是删目录**——那样这条 Run 的 cleanup 钩子永远不会执行（项目可能靠它停服务），
         * 而 `workspacePath` 还得我们另外去抹。没有 scheduler 的实例（测试/只读）仍走直接删除。
         */
        const ownerRun = this.runHoldingWorkspace(project.id, item.worktreePath);
        if (ownerRun && this.options.scheduler) {
          const hooks = this.store.getProject(project.id)?.settings.hooks ?? {};
          const released = await this.options.scheduler.releaseWorkspace(ownerRun.id, hooks);
          if (!released.worktreeRemoved) {
            throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", `worktree 回收失败：${released.error ?? "未知原因"}`);
          }
          cleanupHookNeedsAttention = released.cleanupNeedsAttention;
        } else {
          await this.removeWorktreePath(project.repoRoot, item.worktreePath);
        }
        worktreeRemoved = true;
      }

      // 目录确认删掉之后才清库里的 workspacePath：删除失败时那条记录仍是事实，不能提前抹掉。
      const runWorkspaceCleared = item.worktreePath ? this.clearRunWorkspace(project.id, item.worktreePath) : false;
      const deleted = await this.git.deleteBranch(project.repoRoot, item.branch);
      this.appendEvent("worktree.cleaned", project.id, {
        projectId: project.id,
        itemId: item.itemId,
        branch: item.branch,
        worktreePath: item.worktreePath,
        worktreeRemoved,
        branchDeleted: deleted.ok,
      });

      const message = !deleted.ok
        ? `${worktreeRemoved ? "worktree 已删除，但" : ""}分支未能删除：${deleted.message}`
        : cleanupHookNeedsAttention
          ? "清理完成：分支已删除；cleanup 钩子需要关注（见项目设置）。"
          : worktreeRemoved
            ? "清理完成：worktree 与分支都已删除。"
            : "清理完成：已删除本地分支。";
      return {
        message,
        worktreeRemoved,
        branchDeleted: deleted.ok,
        runWorkspaceCleared,
        cleanupHookNeedsAttention,
      };
    });
  }

  /**
   * 某条分支/ref 的提交历史（界面上的「提交历史」）。
   * 先 `resolveCommit` 确认 ref 真实存在：既挡掉拼错的参数，也避免把任意字符串当 rev 传给 git。
   */
  async log(project: Project, input: { ref: string; limit?: number | undefined }): Promise<WorktreeLogCommit[]> {
    const ref = input.ref.trim();
    if (!ref) throw new WorktreeError("WORKTREE_NOT_FOUND", "分支或提交不能为空。");
    const resolved = await this.git.resolveCommit(project.repoRoot, ref);
    if (!resolved) throw new WorktreeError("WORKTREE_NOT_FOUND", `仓库里没有这个分支或提交：${ref}`);
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return this.git.logCommits(project.repoRoot, ref, limit);
  }

  /** 按 itemId 解析一个清单项（全量清单，不受项目范围过滤影响）。 */
  async item(project: Project, itemId: string): Promise<WorktreeItem> {
    const inventory = await this.list(project, { includeFiltered: true });
    const item = inventory.items.find((candidate) => candidate.itemId === itemId);
    if (!item) throw new WorktreeError("WORKTREE_NOT_FOUND", `分支或 worktree 不存在：${itemId}`);
    return item;
  }

  /** 某个提交改了哪些文件。 */
  async commitFiles(project: Project, commit: string): Promise<WorktreeFileChange[]> {
    const sha = await this.requireCommit(project, commit);
    return this.git.commitFiles(project.repoRoot, sha);
  }

  /** 某个提交里单个文件的文本 diff；没有可显示的差异时返回空串（由界面给提示）。 */
  async commitDiff(project: Project, input: { commit: string; path: string; previousPath?: string | null | undefined }): Promise<string> {
    const sha = await this.requireCommit(project, input.commit);
    const path = input.path.trim();
    if (!path) throw new WorktreeError("WORKTREE_NOT_FOUND", "文件路径不能为空。");
    return this.git.commitFileDiff(project.repoRoot, sha, path, input.previousPath?.trim() || null);
  }

  /** 校验一个提交确实存在于该项目仓库，返回它解析后的 SHA。 */
  private async requireCommit(project: Project, commit: string): Promise<string> {
    const value = commit.trim();
    if (!value) throw new WorktreeError("WORKTREE_NOT_FOUND", "提交不能为空。");
    if (!(await this.git.hasCommit(project.repoRoot, value))) {
      throw new WorktreeError("WORKTREE_NOT_FOUND", `仓库里没有这个提交：${value}`);
    }
    return value;
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
        // 钩子失败不阻止合并，也不回滚——但必须说出来，否则"服务没停掉"没有任何地方会提。
        else if (released.cleanupNeedsAttention) message = "cleanup 钩子需要关注（见项目设置）。";
      } catch (error) {
        message = `worktree 回收失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await this.options.onStateChanged?.();
    return { mergeRequest: "confirmed", runId: run.id, workspace, message };
  }

  /**
   * "曾经合并过"的分支集合，来自 Factory 自己记的合并事件。
   *
   * 为什么不问 Git：历史合并没有留下可查询的标记（`--merged` 只回答"现在是否已合并"）。
   * 也不单独建表：事件已经是审计事实，而 `worktree.merge.*` 不在可裁剪白名单里，不会被清掉。
   * **边界**：只覆盖从这个面板执行过的合并；在 Git 侧手合并的历史不在其中。
   */
  private everMergedBranches(projectId: string): Set<string> {
    const branches = new Set<string>();
    const events = this.store.listEvents({
      aggregateId: projectId,
      types: ["worktree.merge.completed", "worktree.merge.continued"],
    });
    for (const event of events) {
      const branch = event.payload.branch;
      if (typeof branch === "string" && branch) branches.add(branch);
    }
    return branches;
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

  /** 删除一个 worktree 目录；目录已经不在了就把 Git 的登记清掉。 */
  private async removeWorktreePath(repoRoot: string, worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) {
      // 目录已经不在了：把 git 的登记也清掉，否则后面的 branch -d 会一直说"被 worktree 占用"。
      await this.git.pruneWorktrees(repoRoot);
      return;
    }
    const removed = await this.git.removeWorktree(repoRoot, worktreePath);
    if (!removed.ok) throw new WorktreeError("WORKTREE_CLEANUP_BLOCKED", `worktree 删除失败：${removed.message}`);
  }

  /** 找一条 `workspacePath` 指向这个目录的 Run（用于走它自己的回收路径）。 */
  private runHoldingWorkspace(projectId: string, worktreePath: string): Run | undefined {
    return this.store
      .listRuns()
      .filter((run) => run.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .find((run) => samePath(run.workspacePath, worktreePath));
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
    // Plan 留档目录 + 工具自己的元数据目录都放行：前者是 Factory 的产物，后者是服务配置。
    const ignorePaths = [...(this.options.ignoreDirtyPathsFor?.(project.repoRoot) ?? []), ...WORKTREE_METADATA_DIRS];
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
      // 一次 `status --porcelain -z` 同时回答脏不脏与冲突文件——此前是两次调用。
      const state = await this.git.worktreeState(worktreePath);
      if (state.conflictFiles.length > 0) return { dirty: "conflict", conflictFiles: state.conflictFiles };
      return { dirty: state.dirty ? "dirty" : "clean", conflictFiles: [] };
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

  /**
   * 清单层面的判据（合并与清理各一组）。完整判据（冲突预测、文件变更）留给 `preview()`。
   *
   * 清理按 kind 分三档，这是本次扩出来的两档（此前只有 branch_worktree）：
   * - `branch_worktree`：分支已合并 + 工作区干净 + 不是活动 Run 的 workspace。
   * - `local_branch`：分支已合并 + **不是仓库当前检出的分支**（git 不允许删它）。
   * - `detached_worktree`：工作区干净 + HEAD 已被某个本地分支包含（否则删掉就丢提交）。
   * 三档共同前提：项目没有活动 Run。
   */
  private mergeAndCleanupVerdict(input: {
    branch: string | null;
    kind: "base_branch" | "local_branch" | "branch_worktree" | "detached_worktree";
    detached: boolean;
    /** detached：HEAD 是否已被某个本地分支包含。 */
    containedInBranch: boolean;
    ahead: number;
    merged: boolean;
    dirty: WorktreeGitDirtyState;
    worktreePath: string | null;
    missing: boolean;
    currentBranch: string | null;
    activeRunIds: readonly Run[];
    operation: WorktreeInProgressOperation | null;
    baseOccupiedElsewhere: string | null;
    /** repoRoot 的脏路径（白名单已排除 Plan 留档目录）。合并要 `switch`，非空时必须阻断。 */
    repoDirtyPaths: readonly string[];
  }): { blockers: string[]; cleanupBlockers: string[] } {
    const blockers: string[] = [];
    const operationLabel = input.operation ? OPERATION_LABEL[input.operation] : null;

    if (input.detached) blockers.push("detached worktree 没有分支名，不能合并。");
    if (input.kind === "base_branch") blockers.push("不能合并主分支自身。");
    if (!input.branch && !input.detached) blockers.push("缺少分支名，不能合并。");
    if (input.ahead === 0 && input.kind !== "base_branch") blockers.push("该分支没有领先主分支的提交。");
    if (input.merged && input.kind !== "base_branch") blockers.push("该分支已经合并到主分支。");
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
    if (operationLabel) blockers.push(`仓库里正在进行 ${operationLabel}，请先处理完再合并。`);
    if (input.baseOccupiedElsewhere) {
      blockers.push(`主分支正被另一个 worktree 占用（${input.baseOccupiedElsewhere}），无法切换过去执行合并。`);
    }

    const cleanupBlockers: string[] = [];
    if (input.activeRunIds.length > 0) cleanupBlockers.push("项目有活动 Run，暂不能清理。");
    if (input.operation) cleanupBlockers.push(`仓库里正在进行 ${operationLabel}，先处理完再清理。`);
    if (input.kind === "base_branch") cleanupBlockers.push("主分支不能清理。");
    else if (input.detached) {
      if (input.missing) cleanupBlockers.push("worktree 目录已不存在，刷新后会自动从 Git 里清掉。");
      if (!input.missing && input.dirty !== "clean") cleanupBlockers.push(`worktree 当前不是 clean 状态（${input.dirty}），不能清理。`);
      if (!input.containedInBranch)
        cleanupBlockers.push("这个 detached worktree 的提交不属于任何本地分支，删除会丢提交；先给它建一条分支再清理。");
      if (input.activeRunIds.some((run) => samePath(run.workspacePath, input.worktreePath))) {
        cleanupBlockers.push("这个 worktree 正被一条活动 Run 使用，不能清理。");
      }
    } else if (input.kind === "local_branch") {
      if (!input.merged) cleanupBlockers.push("该分支当前未合并到主分支，不能删除。");
      if (input.branch && input.branch === input.currentBranch) cleanupBlockers.push("该分支正被仓库检出，先切换到别的分支再删除。");
    } else {
      if (!input.merged) cleanupBlockers.push("该分支当前未合并到主分支，不能清理。");
      if (!input.missing && input.dirty !== "clean") cleanupBlockers.push(`worktree 当前不是 clean 状态（${input.dirty}），不能清理。`);
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
