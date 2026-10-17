/**
 * 模块职责：Worktree 域的 **Git IO 端口**（`WorktreeGitPort`）与它的本地实现
 *   `createLocalWorktreeGit`，以及这些 git 输出里用到的纯解析函数。
 *
 * 为什么单独成模块：本域的其余部分（`worktree/service.ts`）只做判据与状态转换，一行 git 都不跑；
 *   这样它可以在测试里被一个确定性的端口替换，而不必为了"分支已合并"这种情形真的去造仓库。
 *   与 `git/worktree.ts` 的 `GitCommandRunner` / `defaultGitCommand` 是同一种边界，但**不是同一个**：
 *   那个服务的是 Run 的 workspace 建/收，本文件服务的是项目级盘点与合并。
 *
 * 维护提示：
 *   1) **`runGit` 永远 resolve，非 0 退出码用 `exitCode` 表达**（与 `git/worktree.ts` 的
 *      `defaultGitCommand` 同一条约定）。调用方一律读 `exitCode`；改成 reject 会让"用退出码
 *      回答是/否"的那些方法（`isAncestor`、`hasCommit`、`predictConflicts`）在异常里丢掉答案。
 *   2) **所有参数都走 argv，不经 shell**；分支名在拼进 ref 前还要过 `assertSafeRef`——
 *      `execFile` 已经挡掉注入，这一层挡的是"以 `-` 开头的名字被 git 当成选项"
 *      （`merge-inspector.ts` 用 `--end-of-options` 解决同一个问题；这里选择先校验再传）。
 *   3) **`merge --continue` 不接受 `--no-edit`**（实测 git 2.55：`致命错误：--continue 不带参数`）。
 *      正确写法是 `-c core.editor=true merge --continue` —— 没有编辑器时 git 直接用 `MERGE_MSG`。
 *   4) `predictConflicts` 用 `merge-tree --write-tree`（git ≥ 2.38）。**失败一律降级成
 *      `unavailable`，不抛错**：预测只是提示，不该把一次合并变成不可进行。输出格式是
 *      "tree OID → 冲突文件若干 → 空行 → 说明文字"，解析见 `parseMergeTreeConflicts`。
 *   5) `statusShort` / `conflictFiles` 跑在**目标目录**上（worktree 自己），其余命令跑在
 *      repoRoot 上。把 cwd 搞混的后果是"worktree 看起来永远干净"或"仓库看起来永远脏"。
 */
import { execFile } from "node:child_process";

/** 一次 git 调用的结果；`exitCode` 非 0 时 stdout 仍可能有内容（`merge-tree` 就是这样回答冲突的）。 */
export type WorktreeGitResult = { exitCode: number; stdout: string; stderr: string };
/** 可注入的 git 执行端口：工作目录 + argv，返回结果而不抛错。 */
export type WorktreeGitRunner = (args: string[], cwd: string) => Promise<WorktreeGitResult>;

/** `git worktree list --porcelain` 的一项。 */
export type GitWorktreeEntry = { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean };
/** `refs/heads` 的一条分支。 */
export type GitBranchEntry = { name: string; head: string | null; committedAt: number | null };
/** 合并预览里的单条提交（端口层形状，与 `WorktreePreviewCommit` 同形）。 */
export type GitLogEntry = { hash: string; subject: string; author: string; relativeTime: string };
/** `--name-status` 的一行。 */
export type GitNameStatus = { status: string; path: string; previousPath: string | null };

/** 本域需要的全部 Git 事实。实现必须遵守 `runGit` 的"永远 resolve"约定。 */
export type WorktreeGitPort = {
  /**
   * 原样执行一条 git 命令。**只给 `inspectWorkingTree` 这类"需要自己拼 pathspec"的调用方用**：
   * 带 `:(exclude)` 白名单的 `status` 参数由 `git/working-tree.ts` 统一给出，端口再包一层
   * `statusShort` 会把白名单丢掉，于是 Plan 留档目录被误判成脏。
   */
  runRaw(args: string[], cwd: string): Promise<WorktreeGitResult>;
  listWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]>;
  listBranches(repoRoot: string): Promise<GitBranchEntry[]>;
  mergedBranches(repoRoot: string, baseBranch: string): Promise<string[]>;
  /** 一次 `rev-list --count --left-right base...branch` 同时拿到 ahead/behind。 */
  aheadBehind(repoRoot: string, baseBranch: string, branch: string): Promise<{ ahead: number; behind: number }>;
  statusShort(worktreePath: string): Promise<string[]>;
  conflictFiles(worktreePath: string): Promise<string[]>;
  resolveCommit(repoPath: string, ref: string): Promise<string | null>;
  currentBranch(repoRoot: string): Promise<string | null>;
  mergeHead(repoRoot: string): Promise<string | null>;
  isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean>;
  hasCommit(repoRoot: string, commit: string): Promise<boolean>;
  mergeBase(repoRoot: string, left: string, right: string): Promise<string | null>;
  recentCommits(repoRoot: string, fromRef: string, toRef: string, limit: number): Promise<GitLogEntry[]>;
  diffNameStatus(repoRoot: string, fromRef: string, toRef: string): Promise<GitNameStatus[]>;
  predictConflicts(
    repoRoot: string,
    baseBranch: string,
    branch: string,
  ): Promise<{ status: "clean" | "conflicts" | "unavailable"; conflictFiles: string[]; message: string | null }>;
  switchBranch(repoRoot: string, branch: string): Promise<{ ok: boolean; message: string }>;
  merge(repoRoot: string, branch: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  continueMerge(repoRoot: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  abortMerge(repoRoot: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  removeWorktree(repoRoot: string, worktreePath: string): Promise<{ ok: boolean; message: string }>;
  deleteBranch(repoRoot: string, branch: string): Promise<{ ok: boolean; message: string }>;
  pruneWorktrees(repoRoot: string): Promise<void>;
};

/** `git` 版本号探针的返回；解析失败时返回 null（调用方据此给出"无法预测冲突"的提示）。 */
export type GitVersion = { major: number; minor: number } | null;

/** 分支名 / 路径参数的安全校验：非空、不以 `-` 开头、不含 `..`、无空白与控制字符。 */
export function assertSafeRef(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空`);
  if (trimmed.startsWith("-")) throw new Error(`${field} 不能以 - 开头：${value}`);
  if (trimmed.includes("..")) throw new Error(`${field} 不能包含 ..：${value}`);
  // eslint-disable-next-line no-control-regex -- 这里的目的就是拒绝控制字符（含换行）
  if (/[\s\x00-\x1f]/.test(trimmed)) throw new Error(`${field} 不能包含空白或控制字符：${value}`);
  return trimmed;
}

/** 解析 `git worktree list --porcelain`。空行分隔条目，与 `git/worktree.ts` 的解析保持同形。 */
export function parseWorktreePorcelain(input: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, head: null, branch: null, detached: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

/** 解析 `for-each-ref --format=%(refname:short)%00%(objectname)%00%(committerdate:unix)`。 */
export function parseBranchDetails(input: string): GitBranchEntry[] {
  const entries = input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name = "", head = "", committedAt = ""] = line.split("\0");
      return {
        name: name.trim(),
        head: head.trim() || null,
        committedAt: committedAt.trim() ? Number(committedAt.trim()) : null,
      };
    })
    .filter((entry) => entry.name.length > 0);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

/** 解析 `rev-list --count --left-right base...branch`：左 = base 独有（behind），右 = 分支独有（ahead）。 */
export function parseAheadBehind(input: string): { ahead: number; behind: number } {
  const [left, right] = input.trim().split(/\s+/);
  const behind = Number.parseInt(left ?? "0", 10);
  const ahead = Number.parseInt(right ?? "0", 10);
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

/** 解析 `--name-status`；rename / copy 的第二列是原路径。 */
export function parseNameStatus(input: string): GitNameStatus[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const parts = line.split("\t");
      if (parts.length < 2) return [];
      const status = parts[0] ?? "";
      const kind = status.charAt(0);
      if ((kind === "R" || kind === "C") && parts.length >= 3) {
        return [{ status, previousPath: parts[1] ?? null, path: parts[2] ?? "" }];
      }
      return [{ status, path: parts[1] ?? "", previousPath: null }];
    });
}

/**
 * 解析 `merge-tree --write-tree --name-only --messages` 的输出。
 * 第一行是树 OID（成功与冲突都会打印），随后是冲突文件，遇到第一个空行就是说明文字。
 */
export function parseMergeTreeConflicts(input: string): string[] {
  const lines = input.split("\n");
  const first = (lines[0] ?? "").trim();
  const firstIsTreeOid = /^[0-9a-f]{40,64}$/.test(first);
  const files: string[] = [];
  if (!firstIsTreeOid && first) files.push(first);
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) break;
    files.push(trimmed);
  }
  return [...new Set(files)].sort();
}

/** 解析 git 版本；`git version 2.55.0 (Apple Git-…)` → `{ major: 2, minor: 55 }`。 */
export function parseGitVersion(input: string): GitVersion {
  const match = input.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  return Number.isFinite(major) && Number.isFinite(minor) ? { major, minor } : null;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** 默认执行器：与 `git/worktree.ts` 的 `defaultGitCommand` 同一条约定（永远 resolve、保留 stdout）。 */
function defaultGitRunner(args: string[], cwd: string): Promise<WorktreeGitResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) =>
      resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** 用本地 `git` 命令实现端口；`runGit` 仅供测试替换。 */
export function createLocalWorktreeGit(options: { runGit?: WorktreeGitRunner | undefined } = {}): WorktreeGitPort {
  const runGit = options.runGit ?? defaultGitRunner;

  /** 需要 stdout 的读操作：非 0 退出码直接抛错（调用方都是"读不到就没法继续"的场景）。 */
  async function read(args: string[], cwd: string): Promise<string> {
    const result = await runGit(args, cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 失败`);
    return result.stdout;
  }

  /** 用退出码回答是/否的操作：非 0 一律当"否"，不抛错。 */
  async function answersYes(args: string[], cwd: string): Promise<boolean> {
    const result = await runGit(args, cwd);
    return result.exitCode === 0;
  }

  return {
    runRaw: (args, cwd) => runGit(args, cwd),

    async listWorktrees(repoRoot) {
      return parseWorktreePorcelain(await read(["worktree", "list", "--porcelain"], repoRoot));
    },

    async listBranches(repoRoot) {
      return parseBranchDetails(
        await read(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)", "refs/heads"], repoRoot),
      );
    },

    async mergedBranches(repoRoot, baseBranch) {
      const output = await read(
        ["for-each-ref", "--merged", assertSafeRef(baseBranch, "主分支"), "--format=%(refname:short)", "refs/heads"],
        repoRoot,
      );
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },

    async aheadBehind(repoRoot, baseBranch, branch) {
      const base = assertSafeRef(baseBranch, "主分支");
      const ref = assertSafeRef(branch, "分支");
      const output = await read(["rev-list", "--count", "--left-right", `${base}...${ref}`], repoRoot);
      return parseAheadBehind(output);
    },

    async statusShort(worktreePath) {
      const output = await read(["status", "--short"], worktreePath);
      return output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
    },

    async conflictFiles(worktreePath) {
      const output = await read(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },

    async resolveCommit(repoPath, ref) {
      const result = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoPath);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },

    async currentBranch(repoRoot) {
      const result = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], repoRoot);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },

    async mergeHead(repoRoot) {
      const result = await runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repoRoot);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },

    async isAncestor(repoRoot, ancestor, descendant) {
      return answersYes(["merge-base", "--is-ancestor", assertSafeRef(ancestor, "提交"), assertSafeRef(descendant, "提交")], repoRoot);
    },

    async hasCommit(repoRoot, commit) {
      return answersYes(["cat-file", "-e", `${assertSafeRef(commit, "提交")}^{commit}`], repoRoot);
    },

    async mergeBase(repoRoot, left, right) {
      const result = await runGit(["merge-base", assertSafeRef(left, "提交"), assertSafeRef(right, "提交")], repoRoot);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },

    async recentCommits(repoRoot, fromRef, toRef, limit) {
      const output = await read(
        [
          "log",
          "--format=%h%x09%s%x09%an%x09%cr",
          "-n",
          String(Math.max(1, Math.min(limit, 50))),
          `${assertSafeRef(fromRef, "起始提交")}..${assertSafeRef(toRef, "结束提交")}`,
        ],
        repoRoot,
      );
      return output
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [hash, subject, author, relativeTime] = line.split("\t");
          return hash ? [{ hash, subject: subject ?? "", author: author ?? "", relativeTime: relativeTime ?? "" }] : [];
        });
    },

    async diffNameStatus(repoRoot, fromRef, toRef) {
      return parseNameStatus(
        await read(["diff", "--name-status", assertSafeRef(fromRef, "起始提交"), assertSafeRef(toRef, "结束提交")], repoRoot),
      );
    },

    async predictConflicts(repoRoot, baseBranch, branch) {
      const result = await runGit(
        ["merge-tree", "--write-tree", "--name-only", "--messages", assertSafeRef(baseBranch, "主分支"), assertSafeRef(branch, "分支")],
        repoRoot,
      );
      if (result.exitCode === 0) {
        return { status: "clean", conflictFiles: [], message: "未预测到文本级合并冲突。" };
      }
      const conflictFiles = parseMergeTreeConflicts(result.stdout);
      if (conflictFiles.length > 0) {
        return { status: "conflicts", conflictFiles, message: "merge-tree 预测到冲突文件。" };
      }
      // 走到这里说明不是"有冲突"，而是"跑不了"（git 版本过旧 / 仓库读不到）。
      const detail = (result.stderr || result.stdout).trim();
      return { status: "unavailable", conflictFiles: [], message: detail || "冲突预测不可用。" };
    },

    async switchBranch(repoRoot, branch) {
      const result = await runGit(["switch", assertSafeRef(branch, "分支")], repoRoot);
      return { ok: result.exitCode === 0, message: (result.stderr || result.stdout).trim() };
    },

    async merge(repoRoot, branch) {
      const result = await runGit(["merge", "--no-ff", "--no-edit", assertSafeRef(branch, "分支")], repoRoot);
      return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    },

    async continueMerge(repoRoot) {
      // 见维护提示 3：`--continue` 不能带 `--no-edit`，用 core.editor 关掉编辑器。
      const result = await runGit(["-c", "core.editor=true", "merge", "--continue"], repoRoot);
      return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    },

    async abortMerge(repoRoot) {
      const result = await runGit(["merge", "--abort"], repoRoot);
      return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    },

    async removeWorktree(repoRoot, worktreePath) {
      if (!worktreePath.trim()) return { ok: false, message: "worktree 路径为空" };
      const result = await runGit(["worktree", "remove", worktreePath], repoRoot);
      return { ok: result.exitCode === 0, message: (result.stderr || result.stdout).trim() };
    },

    async deleteBranch(repoRoot, branch) {
      // `-d` 而不是 `-D`：未合并时 git 自己会拒绝，这是最后一道保险。
      const result = await runGit(["branch", "-d", assertSafeRef(branch, "分支")], repoRoot);
      return { ok: result.exitCode === 0, message: (result.stderr || result.stdout).trim() };
    },

    async pruneWorktrees(repoRoot) {
      await runGit(["worktree", "prune"], repoRoot);
    },
  };
}
