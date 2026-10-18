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

/**
 * 具体形状定义在 `@pipeline-factory/contracts`（Web / API / core 共用），这里只做转发，
 * 让既有 `from "../worktree/types.js"` 的调用点保持不变。
 */
import type {
  RuntimeClearResult,
  RuntimeSwitchResult,
  WorktreeCleanupResult,
  WorktreeConflictPrediction,
  WorktreeDependencyLinkResult,
  WorktreeFactoryLink,
  WorktreeFactorySync,
  WorktreeFileChange,
  WorktreeFileSummary,
  WorktreeGitDirtyState,
  WorktreeInProgressOperation,
  WorktreeInventory,
  WorktreeItem,
  WorktreeItemKind,
  WorktreeItemStatus,
  WorktreeLogCommit,
  WorktreeMergeConclusion,
  WorktreeMergeInProgress,
  WorktreeMergePreview,
  WorktreeMergeRelation,
  WorktreeMergeResult,
  WorktreePreviewCommit,
  WorktreeRuntimeInfo,
  WorktreeServiceConfig,
  WorktreeServiceLogEntry,
  WorktreeServiceState,
  WorktreeServiceStatus,
  WorktreeServices,
} from "@pipeline-factory/contracts";

export type {
  RuntimeClearResult,
  RuntimeSwitchResult,
  WorktreeCleanupResult,
  WorktreeConflictPrediction,
  WorktreeDependencyLinkResult,
  WorktreeFactoryLink,
  WorktreeFactorySync,
  WorktreeFileChange,
  WorktreeFileSummary,
  WorktreeGitDirtyState,
  WorktreeInProgressOperation,
  WorktreeInventory,
  WorktreeItem,
  WorktreeItemKind,
  WorktreeItemStatus,
  WorktreeLogCommit,
  WorktreeMergeConclusion,
  WorktreeMergeInProgress,
  WorktreeMergePreview,
  WorktreeMergeRelation,
  WorktreeMergeResult,
  WorktreePreviewCommit,
  WorktreeRuntimeInfo,
  WorktreeServiceConfig,
  WorktreeServiceLogEntry,
  WorktreeServiceState,
  WorktreeServiceStatus,
  WorktreeServices,
};
