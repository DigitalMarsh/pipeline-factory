/**
 * 测试职责：Worktree 面板的纯展示逻辑 —— 状态/类型文案、来源标注、筛选谓词，以及
 *   "为什么不能合并/清理"的文案。
 *
 * 设计说明：这里断言的是**用户据此做判断的那几个词与分组**。判定本身（`mergeable` /
 *   `cleanupable`）来自服务端，本文件不重算——测试也不去替服务端断言它。
 */
import { describe, expect, it } from "vitest";
import type { WorktreeItem } from "../types";
import {
  cleanupDisabledReason,
  matchesWorktreeFilters,
  mergeDisabledReason,
  worktreeHasConflict,
  worktreeKindLabel,
  worktreeNeedsAttention,
  worktreeSourceLabel,
  worktreeStatusLabel,
  worktreeStatusTagType,
} from "./worktreeStatus";

function item(overrides: Partial<WorktreeItem> = {}): WorktreeItem {
  return {
    itemId: "branch:feature/a",
    kind: "branch_worktree",
    branch: "feature/a",
    displayName: "feature/a",
    isBaseBranch: false,
    hasWorktree: true,
    isDetached: false,
    worktreePath: "/repo-wt/a",
    effectivePath: "/repo-wt/a",
    missing: false,
    status: "committed_unmerged",
    mergeRelation: "current_unmerged",
    gitDirtyState: "clean",
    conflictFiles: [],
    aheadCount: 2,
    behindCount: 0,
    merged: false,
    lastCommit: "abc1234",
    lastCommitAt: 1_760_000_000,
    mergeable: true,
    blockers: [],
    cleanupable: false,
    cleanupBlockers: ["该分支当前未合并到主分支，不能清理。"],
    isLiveRunWorkspace: false,
    factory: null,
    ...overrides,
  };
}

describe("状态文案", () => {
  it("区分「已合并但还有未提交更新」与「已提交已合并」", () => {
    expect(worktreeStatusLabel("merged_clean")).toBe("已提交已合并");
    expect(worktreeStatusLabel("merged_dirty")).toBe("已合并但有未提交更新");
    expect(worktreeStatusTagType("merged_clean")).toBe("success");
    expect(worktreeStatusTagType("merged_dirty")).toBe("warning");
  });

  it("工作区冲突用危险色，Detached 只提示不吓人", () => {
    expect(worktreeStatusLabel("merge_conflict")).toBe("合并冲突");
    expect(worktreeStatusTagType("merge_conflict")).toBe("danger");
    expect(worktreeStatusLabel("detached_clean")).toBe("Detached / Clean");
    expect(worktreeStatusTagType("detached_clean")).toBe("info");
  });

  it("类型文案覆盖四种 kind", () => {
    expect(worktreeKindLabel("base_branch")).toBe("主分支");
    expect(worktreeKindLabel("local_branch")).toBe("本地分支");
    expect(worktreeKindLabel("branch_worktree")).toBe("Worktree");
    expect(worktreeKindLabel("detached_worktree")).toBe("Detached");
  });
});

describe("来源标注", () => {
  it("不是 Factory 的分支明确写「手动分支」", () => {
    expect(worktreeSourceLabel(null)).toBe("手动分支");
  });

  it("属于 Run 时优先显示计划标题，没有标题回落到 runId", () => {
    const link = {
      runId: "run-1",
      planId: "plan-1",
      planTitle: "修复项目校验",
      runStatus: "MERGE_READY" as const,
      verificationStatus: "PASSED" as const,
      mergeRequestStatus: "OPEN" as const,
    };
    expect(worktreeSourceLabel(link)).toBe("修复项目校验");
    expect(worktreeSourceLabel({ ...link, planTitle: null })).toContain("run-1");
  });
});

describe("筛选", () => {
  it("未合并只看需要注意的状态，不含无更新与已合并", () => {
    expect(worktreeNeedsAttention(item())).toBe(true);
    expect(worktreeNeedsAttention(item({ status: "no_updates", aheadCount: 0 }))).toBe(false);
    expect(worktreeNeedsAttention(item({ status: "merged_clean", merged: true }))).toBe(false);
    expect(matchesWorktreeFilters(item({ status: "merged_clean" }), { status: "no-updates", kind: "all" })).toBe(true);
  });

  it("冲突筛选只认工作区里真实的冲突，不认「可能冲突」", () => {
    expect(worktreeHasConflict(item({ status: "merge_conflict" }))).toBe(true);
    expect(worktreeHasConflict(item({ conflictFiles: ["README.md"] }))).toBe(true);
    expect(worktreeHasConflict(item({ status: "committed_unmerged" }))).toBe(false);
    expect(matchesWorktreeFilters(item({ status: "committed_unmerged" }), { status: "conflict", kind: "all" })).toBe(false);
  });

  it("可清理筛选读服务端的 cleanupable", () => {
    expect(matchesWorktreeFilters(item({ cleanupable: false }), { status: "cleanup", kind: "all" })).toBe(false);
    expect(matchesWorktreeFilters(item({ cleanupable: true }), { status: "cleanup", kind: "all" })).toBe(true);
  });

  it("类型筛选把 worktree 与 detached 分开，本地分支含主分支", () => {
    expect(matchesWorktreeFilters(item(), { status: "all", kind: "worktree" })).toBe(true);
    expect(matchesWorktreeFilters(item({ kind: "detached_worktree", isDetached: true }), { status: "all", kind: "worktree" })).toBe(true);
    expect(matchesWorktreeFilters(item({ kind: "detached_worktree" }), { status: "all", kind: "local" })).toBe(false);
    expect(matchesWorktreeFilters(item({ kind: "local_branch" }), { status: "all", kind: "local" })).toBe(true);
    expect(matchesWorktreeFilters(item({ kind: "base_branch", isBaseBranch: true }), { status: "all", kind: "local" })).toBe(true);
  });
});

describe("不能做时的原因", () => {
  it("优先展示服务端给的阻断项", () => {
    expect(mergeDisabledReason(item({ blockers: ["项目有 1 条活动 Run"] }))).toBe("项目有 1 条活动 Run");
    expect(cleanupDisabledReason(item())).toBe("该分支当前未合并到主分支，不能清理。");
  });

  it("detached 没有分支名，合并原因直接说明", () => {
    const detached = item({ kind: "detached_worktree", branch: null, isDetached: true, conflictFiles: [] });
    expect(mergeDisabledReason(detached)).toContain("detached");
  });
});
