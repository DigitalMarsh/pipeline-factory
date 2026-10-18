/**
 * 模块职责：**项目视角**的 Worktree 管理契约 —— 分支 / worktree 清单、合并预览、合并与清理结果。
 *
 * 与 `git/worktree.ts` 的区别（同名但无关，读代码时先分清）：
 *   `git/worktree.ts` 是 **Run 的** WorkspaceAdapter，只负责"为一条 Run 建/收一个 worktree"；
 *   本域是**项目级**的只读盘点 + 人工触发的合并/清理，对象是仓库里已有的分支与 worktree，
 *   与 Plan / Run 没有生命周期绑定（只有 `WorktreeFactoryLink` 那一层可选标注）。
 *
 * 维护提示：
 *   1) **`status` 是"Git 现状 + 是否已合并"的分类，不是 Run 状态**。同一个 `merged_clean` 的
 *      分支可能属于一条已合并的 Run，也可能根本不属于 Factory；来源标注读 `factory`，不要把它
 *      混进 `status` —— 混进去之后，一个从未来过 Factory 的分支就没有合适的分类了。
 *   2) **`aheadCount` / `behindCount` 用一次 `rev-list --count --left-right base...branch` 拿到**，
 *      不要退回 worktree-manage 的两次 `rev-list --count`：两次数之间 base 可能已经前进，
 *      于是 ahead/behind 互相矛盾。
 *   3) **`mergeable` 只承载廉价判据**（分支存在、有领先提交、未合并、工作区干净、无活动 Run、
 *      无进行中的合并）。冲突预测要跑 `merge-tree`，**只在 preview 里做**：清单每刷新一次就对
 *      每条分支预测一次冲突，在几十条分支上会把刷新拖成秒级。
 *   4) **`expectedBranchHead` / `expectedBaseHead` 是乐观并发的凭据**，不是展示字段。
 *      preview 返回它们，merge / cleanup 必须带回；不一致时服务端拒绝，而不是"按最新状态继续"——
 *      "我审核的是这一版"与"实际合进去的是另一版"必须是同一版。
 *   5) `missing` 表示 Git 仍登记着这个 worktree、但目录已经不在。**它不等于可以删**：
 *      清理仍然要求分支已合并，否则会连提交一起丢掉。
 */

import type { RunStatus, VerificationStatus } from "../run/types.js";

/** 工作目录当前的脏状态：clean / 有未提交改动 / 存在未解决的合并冲突。 */
export type WorktreeGitDirtyState = "clean" | "dirty" | "conflict";

/** 清单项的类型：主分支、无 worktree 的本地分支、有 worktree 的分支、detached worktree。 */
export type WorktreeItemKind = "base_branch" | "local_branch" | "branch_worktree" | "detached_worktree";

/**
 * 清单项分类。命名沿用 worktree-manage（`ui/src/utils.js` 的 `statusLabel`），语义一一对应：
 * `dirty_uncommitted` 有改动未提交、`dirty_with_commits` 有提交但工作区还有改动、
 * `committed_unmerged` 有提交且干净、`merged_*` 是已合并后的两种残留状态。
 */
export type WorktreeItemStatus =
  | "no_updates"
  | "dirty_uncommitted"
  | "dirty_with_commits"
  | "committed_unmerged"
  | "merge_conflict"
  | "merged_dirty"
  | "merged_clean"
  | "detached_unmerged"
  | "detached_dirty_with_commits"
  | "detached_dirty"
  | "detached_clean";

/** 合并状态：当前已合并 / 当前未合并 / detached（没有可比较的分支）。 */
export type WorktreeMergeRelation = "current_merged" | "current_unmerged" | "detached";

/**
 * 该分支若属于一条 Factory Run，这里给出它的来源与当前生命周期。
 * **只是标注**：合并/清理的判据一律以 Git 事实为准，不用这里的 Run 状态替代。
 */
export type WorktreeFactoryLink = {
  runId: string;
  planId: string;
  planTitle: string | null;
  runStatus: RunStatus;
  verificationStatus: VerificationStatus | null;
  mergeRequestStatus: "OPEN" | "MERGED" | "SUPERSEDED" | null;
};

/** 清单里的一行：一条本地分支，或一个 detached worktree。 */
export type WorktreeItem = {
  /** `branch:<name>` 或 `detached:<绝对路径>`；由服务端生成，客户端只回传不解析。 */
  itemId: string;
  kind: WorktreeItemKind;
  /** detached worktree 没有分支名。 */
  branch: string | null;
  displayName: string;
  isBaseBranch: boolean;
  hasWorktree: boolean;
  isDetached: boolean;
  worktreePath: string | null;
  /** 实际操作目录：有 worktree 就是它，否则回落到 repoRoot（本地分支的合并仍在 repoRoot 里做）。 */
  effectivePath: string;
  /** Git 登记了该 worktree 但目录已不存在。 */
  missing: boolean;
  status: WorktreeItemStatus;
  mergeRelation: WorktreeMergeRelation;
  gitDirtyState: WorktreeGitDirtyState;
  conflictFiles: string[];
  aheadCount: number;
  behindCount: number;
  /** `merge-base --is-ancestor <branch> <base>`：这条分支当前是否已经全部进入主分支。 */
  merged: boolean;
  lastCommit: string | null;
  lastCommitAt: number | null;
  /** 廉价判据的结论；完整的阻断项与冲突预测由 preview 给出。 */
  mergeable: boolean;
  /** `mergeable === false` 时的原因（中文、可直接展示）；可合并时为空数组。 */
  blockers: string[];
  /** 严格按 `merged_clean` 规则；为 false 时原因见 `cleanupBlockers`。 */
  cleanupable: boolean;
  cleanupBlockers: string[];
  /** 该 worktree 正被一条活动 Run 使用（`workspacePath` 指向它且 Run 尚未结束）。 */
  isLiveRunWorkspace: boolean;
  factory: WorktreeFactoryLink | null;
};

/** 进行中的合并：`MERGE_HEAD` 存在时才有。冲突后 repoRoot 停在这个状态，界面必须显式提示。 */
export type WorktreeMergeInProgress = {
  mergeHead: string;
  currentBranch: string | null;
  conflictFiles: string[];
};

/** 一个项目的 Worktree 盘点结果。 */
export type WorktreeInventory = {
  projectId: string;
  repoRoot: string;
  baseBranch: string;
  baseHead: string | null;
  /** repoRoot 当前检出的分支（detached 时为 null）。 */
  currentBranch: string | null;
  mergeInProgress: WorktreeMergeInProgress | null;
  /** 占用执行槽位的 Run；非空时合并与清理一律被拒。 */
  activeRunIds: string[];
  items: WorktreeItem[];
  /** 分支数超过上限时只返回前 N 条并置为 true。 */
  truncated: boolean;
  /** 盘点层面的降级提示（例如某个 worktree 目录读不到状态）。 */
  warnings: string[];
};

/** 合并预览里的单条提交。 */
export type WorktreePreviewCommit = { hash: string; subject: string; author: string; relativeTime: string };

/** 文件变更计数。 */
export type WorktreeFileSummary = {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  typeChanged: number;
  unknown: number;
};

/** 文件变更明细；rename / copy 才有 `previousPath`。 */
export type WorktreeFileChange = { status: string; path: string; previousPath: string | null };

/**
 * 冲突预测。`unavailable` 表示**没能预测**（git 版本过旧或仓库暂不可读），
 * 与 `clean`（预测为无冲突）是两回事，不能合并成同一个值。
 */
export type WorktreeConflictPrediction = {
  status: "clean" | "conflicts" | "unavailable";
  hasConflicts: boolean;
  conflictFiles: string[];
  message: string | null;
};

/** 预览结论：可以合并 / 可能冲突 / 有阻断项。 */
export type WorktreeMergeConclusion = "ready" | "conflict_risk" | "blocked";

/** 一次合并预览；任何执行都以它为依据，确认时必须带回两个 expected SHA。 */
export type WorktreeMergePreview = {
  projectId: string;
  repoRoot: string;
  itemId: string;
  branch: string | null;
  baseBranch: string;
  baseHead: string | null;
  taskHead: string | null;
  mergeBase: string | null;
  aheadCount: number;
  behindCount: number;
  dirtyState: WorktreeGitDirtyState;
  merged: boolean;
  conclusion: WorktreeMergeConclusion;
  conclusionLabel: string;
  canConfirm: boolean;
  blockers: string[];
  warnings: string[];
  recentCommits: WorktreePreviewCommit[];
  fileSummary: WorktreeFileSummary;
  fileChanges: WorktreeFileChange[];
  conflictPrediction: WorktreeConflictPrediction;
  /** 将要执行的 git 命令；界面上原样展示，执行的就是这一串。 */
  commands: string[];
  /** 乐观并发凭据：确认时必须原样带回。 */
  expectedBranchHead: string | null;
  expectedBaseHead: string | null;
  factory: WorktreeFactoryLink | null;
};

/**
 * 合并成功后的 Factory 联动结果。
 * `not_found` 不是错误：这条分支可能不属于任何 Run，或那个 Run 还没验证通过。
 */
export type WorktreeFactorySync = {
  mergeRequest: "confirmed" | "not_found" | "failed";
  runId: string | null;
  workspace: { released: boolean; worktreeRemoved: boolean } | null;
  message: string | null;
};

/** 一次合并操作的结果。`merge_conflict` 时仓库停在合并中，需 continue 或 abort。 */
export type WorktreeMergeResult = {
  status: "merged" | "merge_conflict" | "aborted" | "error";
  message: string;
  branch: string | null;
  baseBranch: string;
  conflictFiles: string[];
  baseHeadBefore: string | null;
  baseHeadAfter: string | null;
  commands: string[];
  factory: WorktreeFactorySync | null;
};

/** 一次清理的结果。三个阶段各自可能失败，分开报告，不合并成一个布尔。 */
export type WorktreeCleanupResult = {
  message: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** 库里那条指向该目录的 Run 的 `workspacePath` 是否被清空。 */
  runWorkspaceCleared: boolean;
  /**
   * 该 worktree 属于某条 Run 时，回收走的是 `Scheduler.releaseWorkspace`，它会跑项目的 cleanup 钩子。
   * 钩子失败不会阻止删除（与 Factory 既有语义一致），但必须让调用方看见——否则"服务没停掉"这件事
   * 没有任何地方会提。
   */
  cleanupHookNeedsAttention: boolean;
};
