/**
 * 模块职责：Worktree 面板的**纯展示与筛选逻辑** —— 状态/类型的文案与标签色、来源标注、
 *   以及列表的筛选谓词。
 *
 * 为什么单独成模块：这些映射是 worktree-manage 里最容易"看起来只是文案"、实则决定用户判断的部分
 *   （`merged_clean` 与 `merged_dirty` 只差一个词，但一个可以清理、一个不行）。抽成纯函数就能
 *   在测试里逐条钉住，不用挂载组件。
 *
 * 维护提示：
 *   1) **判定"能不能做"一律读服务端的 `mergeable` / `cleanupable`，不要在这里重算**。
 *      本文件只负责"为什么不能"的文案（`*DisabledReason`）与分组筛选。
 *   2) `merge_conflict` 是**工作区里真的有未解决冲突**，不是"预测会冲突"——后者只在预览的
 *      `conflictPrediction` 里出现。两者不能共用同一个标签色。
 *   3) `no_updates` 与 `detached_clean` 都算"无事可做"，但分属不同 kind；筛选 `no-updates`
 *      把它们都收进来是**给用户省一次点击**，不是把它们当成同一个状态。
 */
import type { WorktreeFactoryLink, WorktreeItem, WorktreeItemKind, WorktreeItemStatus, WorktreeMergeRelation } from "../types";

export type WorktreeStatusFilter = "all" | "unmerged" | "conflict" | "cleanup" | "no-updates";
export type WorktreeKindFilter = "all" | "worktree" | "local" | "detached";

/** `el-tag` 接受的语义色。 */
export type TagType = "primary" | "success" | "info" | "warning" | "danger";

export function worktreeStatusLabel(status: WorktreeItemStatus): string {
  const labels: Record<WorktreeItemStatus, string> = {
    no_updates: "无更新",
    dirty_uncommitted: "已完成未提交",
    dirty_with_commits: "已提交但有未提交变更",
    committed_unmerged: "有新提交未合并",
    merge_conflict: "合并冲突",
    merged_dirty: "已合并但有未提交更新",
    merged_clean: "已提交已合并",
    detached_unmerged: "Detached / 有未合并提交",
    detached_dirty_with_commits: "Detached / 提交后又有修改",
    detached_dirty: "Detached / 有修改",
    detached_clean: "Detached / Clean",
  };
  return labels[status] ?? "异常";
}

export function worktreeStatusTagType(status: WorktreeItemStatus): TagType {
  const types: Record<WorktreeItemStatus, TagType> = {
    no_updates: "info",
    dirty_uncommitted: "warning",
    dirty_with_commits: "warning",
    committed_unmerged: "primary",
    merge_conflict: "danger",
    merged_dirty: "warning",
    merged_clean: "success",
    detached_unmerged: "primary",
    detached_dirty_with_commits: "warning",
    detached_dirty: "warning",
    detached_clean: "info",
  };
  return types[status] ?? "danger";
}

export function worktreeKindLabel(kind: WorktreeItemKind): string {
  const labels: Record<WorktreeItemKind, string> = {
    base_branch: "主分支",
    local_branch: "本地分支",
    branch_worktree: "Worktree",
    detached_worktree: "Detached",
  };
  return labels[kind] ?? "未知";
}

export function worktreeKindTagType(kind: WorktreeItemKind): TagType {
  const types: Record<WorktreeItemKind, TagType> = {
    base_branch: "primary",
    local_branch: "info",
    branch_worktree: "success",
    detached_worktree: "warning",
  };
  return types[kind] ?? "info";
}

export function worktreeMergeRelationLabel(relation: WorktreeMergeRelation): string {
  const labels: Record<WorktreeMergeRelation, string> = {
    current_merged: "当前已合并",
    current_unmerged: "当前未合并",
    detached: "Detached",
  };
  return labels[relation] ?? "未知关系";
}

export function worktreeMergeRelationTagType(relation: WorktreeMergeRelation): TagType {
  return relation === "current_merged" ? "success" : "info";
}

/** 来源一栏：属于 Factory 的 Run 就显示计划标题，否则明确写"手动分支"。 */
export function worktreeSourceLabel(factory: WorktreeFactoryLink | null): string {
  if (!factory) return "手动分支";
  return factory.planTitle?.trim() || `${factory.runId}（无标题）`;
}

export function worktreeRunStatusLabel(status: WorktreeFactoryLink["runStatus"]): string {
  const labels: Record<WorktreeFactoryLink["runStatus"], string> = {
    QUEUED: "排队中",
    STARTING: "启动中",
    IN_PROGRESS: "执行中",
    READY_FOR_VERIFY: "待验证",
    VERIFYING: "验证中",
    MERGE_READY: "待合并",
    BLOCKED: "已阻断",
    STALE: "已过期",
    RECOVERING: "恢复中",
    CANCELLED: "已取消",
  };
  return labels[status] ?? status;
}

/** 有未合并成果、值得注意的状态。 */
export function worktreeNeedsAttention(item: WorktreeItem): boolean {
  return !["no_updates", "detached_clean", "merged_clean"].includes(item.status);
}

/** 工作区里有真实冲突文件（不是"预测会冲突"）。 */
export function worktreeHasConflict(item: WorktreeItem): boolean {
  return item.status === "merge_conflict" || item.gitDirtyState === "conflict" || item.conflictFiles.length > 0;
}

export function matchesWorktreeStatusFilter(item: WorktreeItem, filter: WorktreeStatusFilter): boolean {
  switch (filter) {
    case "unmerged":
      return worktreeNeedsAttention(item);
    case "conflict":
      return worktreeHasConflict(item);
    case "cleanup":
      return item.cleanupable;
    case "no-updates":
      return item.status === "no_updates" || item.status === "detached_clean" || item.status === "merged_clean";
    default:
      return true;
  }
}

export function matchesWorktreeKindFilter(item: WorktreeItem, filter: WorktreeKindFilter): boolean {
  switch (filter) {
    case "worktree":
      return item.kind === "branch_worktree" || item.kind === "detached_worktree";
    case "local":
      return item.kind === "local_branch" || item.kind === "base_branch";
    case "detached":
      return item.kind === "detached_worktree";
    default:
      return true;
  }
}

export function matchesWorktreeFilters(item: WorktreeItem, filters: { status: WorktreeStatusFilter; kind: WorktreeKindFilter }): boolean {
  return matchesWorktreeStatusFilter(item, filters.status) && matchesWorktreeKindFilter(item, filters.kind);
}

/** 预览/合并按钮不可用的原因（服务端判据的文案由 `blockers` 给出）。 */
export function mergeDisabledReason(item: WorktreeItem): string {
  if (item.blockers.length > 0) return item.blockers.join("；");
  if (item.isDetached) return "detached worktree 没有分支名，不能合并。";
  return "";
}

/** 清理按钮不可用的原因。 */
export function cleanupDisabledReason(item: WorktreeItem): string {
  if (item.cleanupBlockers.length > 0) return item.cleanupBlockers.join("；");
  if (item.kind !== "branch_worktree") return "只有已创建 worktree 的分支可以清理。";
  return "";
}
