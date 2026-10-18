/**
 * 模块职责：**工作区干净检查** —— Run 的 worktree 只能建立在"受管工程没有未提交改动"之上。
 *
 * 为什么要有这道检查：worktree 的基线现在恒等于 `baseCommit`（见 git/worktree.ts）。如果工作区里有
 *   未提交的改动，那些改动**不会**进入 Run 的工作树，用户在本地看到的代码与 Agent 实际改的代码就是
 *   两棵不同的树——"我本地明明是好的"这类纠纷全部来自这里。与其让 Run 带着一个说不清的基线起跑，
 *   不如在派发前把话说明白：先提交或 stash，再派发。
 *
 * 维护提示：
 *   1) **白名单只放行 Factory 自己写的产物**（Plan 落盘目录，见 plan/plan-directory.ts）。它的位置
 *      由调用方以 git pathspec 的形式传进来；这里不解析配置，也不猜目录。
 *   2) 用 `:(exclude)` **pathspec magic** 做白名单，而不是自己解析 porcelain 文本再过滤：后者要处理
 *      rename 的 `orig -> new`、带引号的路径和八进制转义，漏一个就会把 Factory 自己的文件算成脏。
 *   3) 判定是 `-uall`（逐个未跟踪文件，而不是折叠成目录）——报错时要能列出具体文件，否则用户
 *      拿到一句"工作区不干净"却不知道该处理什么。
 *   4) **只回答"干净/不干净 + 有哪些路径"，不做任何自动清理**。stash / checkout 是用户对自己
 *      工作的处置权，Factory 不代劳。
 */
import type { CommandResult } from "../platform/commands.js";

/** 工作区检查结果；`paths` 是未忽略的脏路径（已去掉 git 的状态前缀）。 */
export type WorkingTreeInspection = { clean: boolean; paths: string[] };

/** 工作区不干净时抛出的错误码前缀；Run 把它落成 BLOCKED 的原因。 */
export const WORKING_TREE_DIRTY = "PROJECT_WORKING_TREE_DIRTY";

/** 检查工作区是否干净；`ignorePaths` 是相对 repoRoot 的 git pathspec（不含 `:(exclude)` 前缀）。 */
export async function inspectWorkingTree(input: {
  repoRoot: string;
  ignorePaths?: readonly string[] | undefined;
  runGit: (args: string[], cwd: string) => Promise<CommandResult>;
}): Promise<WorkingTreeInspection> {
  const result = await input.runGit(workingTreeStatusArgs(input.ignorePaths), input.repoRoot);
  if (result.exitCode !== 0) throw new Error(`工作区状态无法读取：${result.stderr.trim() || "git status 失败"}`);
  const paths = parseWorkingTreeStatus(result.stdout);
  return { clean: paths.length === 0, paths };
}

/**
 * `git status` 的参数。抽出来是给**同步**调用点复用的：预检（plan/preflight.ts）跑在
 * `PlanService.confirm` 这条同步短路径上（同 git/merge-inspector.ts 的理由），
 * 它需要同一套判据但用 execFileSync 执行——参数与解析必须与异步版完全一致，否则两处会分叉。
 */
export function workingTreeStatusArgs(ignorePaths?: readonly string[] | undefined): string[] {
  const exclusions = (ignorePaths ?? []).filter((path) => path.trim().length > 0).map((path) => `:(exclude)${path}`);
  return ["status", "--porcelain", "-uall", "--", ".", ...exclusions];
}

/** 工作区不干净时统一用它拼错误信息：**带具体文件**，否则用户不知道该处理什么。 */
export function workingTreeDirtyError(paths: readonly string[]): Error {
  const sample = paths.slice(0, 10).join("、");
  const more = paths.length > 10 ? ` 等 ${paths.length} 个文件` : "";
  return new Error(`${WORKING_TREE_DIRTY}: 受管工程有未提交改动（${sample}${more}）。请先提交或 stash 后再派发 Run。`);
}

/**
 * 解析 `git status --porcelain -v1` 的输出。
 * 每行形如 `XY path` 或 `XY "quoted path"`；rename/copy 还会写成 `XY orig -> new`——取箭头后的新路径。
 */
export function parseWorkingTreeStatus(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const body = line.slice(3);
      const arrow = body.lastIndexOf(" -> ");
      return unquote(arrow >= 0 ? body.slice(arrow + 4) : body);
    });
}

function unquote(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}
