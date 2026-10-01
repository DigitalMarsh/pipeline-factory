/**
 * 测试职责：钉住"派发前工作区必须干净"这条闸门的三件事——判据、白名单、以及检查与建树的先后顺序。
 *
 * 为什么要这么细：这道闸门一边挡着"用户本地看到的树 ≠ Agent 改的树"（基线恒等于 baseCommit），
 *   另一边又必须放行 Factory 自己写的计划文件——放宽或收紧任何一点，表现都是"派发被莫名其妙挡住"
 *   或"带着说不清的基线起跑"。顺序尤其容易被后续改动调换掉，而调换后**功能仍然可用**，
 *   只是失败时会白建一个工作树再回滚，所以只能用测试钉住。
 */
import { describe, expect, it } from "vitest";
import { inspectWorkingTree, workingTreeDirtyError, WORKING_TREE_DIRTY } from "./working-tree.js";
import { LocalGitWorktreeAdapter } from "./worktree.js";
import type { CommandResult } from "../platform/commands.js";

/** 记录调用顺序的假 git；按命令首词返回预设结果。 */
function fakeGit(handler: (args: string[]) => Partial<CommandResult>) {
  const calls: string[][] = [];
  const runGit = async (args: string[]): Promise<CommandResult> => {
    calls.push(args);
    const result = handler(args);
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { calls, runGit };
}

describe("工作区干净检查", () => {
  it("干净时 clean 为真、路径为空", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    await expect(inspectWorkingTree({ repoRoot: "/repo", runGit: git.runGit })).resolves.toEqual({ clean: true, paths: [] });
  });

  it("把计划目录用 pathspec magic 排除，而不是自己解析 porcelain 再过滤", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    await inspectWorkingTree({ repoRoot: "/repo", ignorePaths: ["docs/pipeline/plans"], runGit: git.runGit });

    expect(git.calls[0]).toEqual(["status", "--porcelain", "-uall", "--", ".", ":(exclude)docs/pipeline/plans"]);
  });

  it("空白的排除项被丢掉，不会变成一个匹配一切的 pathspec", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    await inspectWorkingTree({ repoRoot: "/repo", ignorePaths: ["", "   "], runGit: git.runGit });

    expect(git.calls[0]).toEqual(["status", "--porcelain", "-uall", "--", "."]);
  });

  it("解析 porcelain：去掉状态前缀、处理引号路径与 rename 的箭头", async () => {
    const git = fakeGit(() => ({ stdout: ' M src/a.ts\n?? "docs/带空格 的文件.md"\nR  old/name.ts -> new/name.ts\n' }));
    const inspection = await inspectWorkingTree({ repoRoot: "/repo", runGit: git.runGit });

    expect(inspection.clean).toBe(false);
    expect(inspection.paths).toEqual(["src/a.ts", "docs/带空格 的文件.md", "new/name.ts"]);
  });

  it("git status 失败时明确报错，而不是把失败当成'干净'", async () => {
    const git = fakeGit(() => ({ exitCode: 128, stderr: "not a git repository" }));
    await expect(inspectWorkingTree({ repoRoot: "/repo", runGit: git.runGit })).rejects.toThrow(/工作区状态无法读取/);
  });

  it("错误信息带上具体文件——否则用户不知道该处理什么", () => {
    const error = workingTreeDirtyError(["src/a.ts", "src/b.ts"]);

    expect(error.message).toContain(WORKING_TREE_DIRTY);
    expect(error.message).toContain("src/a.ts");
    expect(error.message).toContain("src/b.ts");
  });
});

describe("Worktree 创建的干净闸门", () => {
  const input = { projectId: "project-1", runId: "run-1", branch: "factory/run-1", baseCommit: "abc123" };

  it("**先检查、再 worktree add** —— 顺序颠倒会白建一个工作树再回滚", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    await new LocalGitWorktreeAdapter({ projectRoot: "/repo", worktreeRoot: "/wt", runGit: git.runGit }).create(input);

    const checkIndex = git.calls.findIndex((args) => args[0] === "status");
    const addIndex = git.calls.findIndex((args) => args[0] === "worktree");
    expect(checkIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(checkIndex);
  });

  it("工作区不干净时抛错并且**不建工作树**", async () => {
    const git = fakeGit((args) => (args[0] === "status" ? { stdout: " M src/a.ts\n" } : {}));
    const adapter = new LocalGitWorktreeAdapter({ projectRoot: "/repo", worktreeRoot: "/wt", runGit: git.runGit });

    await expect(adapter.create(input)).rejects.toThrow(WORKING_TREE_DIRTY);
    expect(git.calls.some((args) => args[0] === "worktree")).toBe(false);
  });

  it("**基线恒等于 baseCommit** —— 不再把工作区改动搬到新工作树里", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    const workspace = await new LocalGitWorktreeAdapter({ projectRoot: "/repo", worktreeRoot: "/wt", runGit: git.runGit }).create(input);

    expect(workspace.baseCommit).toBe(input.baseCommit);
    // 只应有 rev-parse / status / worktree 三条；出现 diff / apply / ls-files 就说明搬运又回来了。
    expect(git.calls.map((args) => args[0])).toEqual(["rev-parse", "status", "worktree"]);
  });

  it("白名单一路传到 git 命令上（否则计划文件一落盘就锁死派发）", async () => {
    const git = fakeGit(() => ({ stdout: "" }));
    await new LocalGitWorktreeAdapter({ projectRoot: "/repo", worktreeRoot: "/wt", ignoreDirtyPaths: ["docs/pipeline/plans"], runGit: git.runGit }).create(input);

    expect(git.calls.find((args) => args[0] === "status")).toContain(":(exclude)docs/pipeline/plans");
  });
});
