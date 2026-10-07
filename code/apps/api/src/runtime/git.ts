/**
 * 模块职责：Git 仓库的探查与校验 —— 项目导入时的 canonicalize、默认分支探测与分支存在性校验。
 *
 * 为什么单独成模块：这三件事全是 **Git 子进程 IO**，与 domain 里 `LocalGitWorktreeAdapter` /
 *   `localGitMergeInspector` 是同一类"领域逻辑混入 IO"的坏味道在 api 侧的对应物。
 *   抽出来后它们可被替换、可被单测，组合根也不再持有子进程细节。
 *
 * 维护提示：
 *   1) `inspectGitRepository` **只接受 Git 仓库根目录**：子目录会被 `repoRoot !== candidate`
 *      拒绝。这不是可以放宽的校验——工作树/分支操作全都假设根目录，放进来一个子目录会在
 *      后续 Run 里以更难查的方式失败。
 *   2) `detectDefaultBranch` 是**同步**的，且失败一律回退 `"main"`。它被组合根的默认 Project
 *      播种路径调用（那里不能 await）。它探测的是"当前 HEAD 指向的分支"，与
 *      `inspectGitRepository` 返回的 `defaultBranch` 语义相同但实现不同：后者还带一层
 *      `rev-parse --abbrev-ref` 兜底，用于能 await 的导入路径。**不要为了统一而合并两者**，
 *      合并必然要把同步那侧改成异步。
 *   3) `assertGitBranch` 先做字符串白名单（非空、不以 `-` 开头、不含 `..`）再查 `refs/heads`：
 *      前半段挡的是把分支名当参数注入的风险，后半段挡的是"分支不存在但配置看起来没问题"。
 *      两道都要留。
 */
import { execFile, execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** canonicalize 并校验 Git 根目录；子目录、非 Git 目录和不可读路径均拒绝导入。 */
export async function inspectGitRepository(inputPath: string): Promise<{ repoRoot: string; defaultBranch: string }> {
  const candidate = await realpath(resolvePath(inputPath));
  let gitRoot: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: candidate });
    gitRoot = await realpath(String(result.stdout).trim());
  } catch (error) {
    throw new Error(`Path is not a Git repository: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (gitRoot !== candidate) throw new Error(`Path must be the Git repository root: ${gitRoot}`);
  let defaultBranch = "main";
  try {
    const result = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: gitRoot });
    const branch = String(result.stdout).trim();
    if (branch) defaultBranch = branch;
  } catch {
    try {
      const result = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitRoot });
      const branch = String(result.stdout).trim();
      if (branch && branch !== "HEAD") defaultBranch = branch;
    } catch {
      /* Detached or unavailable branch metadata keeps the safe default. */
    }
  }
  return { repoRoot: gitRoot, defaultBranch };
}

export async function assertGitBranch(repoRoot: string, branch: string): Promise<void> {
  const normalized = branch.trim();
  if (!normalized || normalized.startsWith("-") || normalized.includes("..")) throw new Error(`Invalid default branch ${branch}`);
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${normalized}`], { cwd: repoRoot });
  } catch {
    throw new Error(`Default branch ${normalized} does not exist in ${repoRoot}`);
  }
}

export function detectDefaultBranch(repoRoot: string): string {
  try {
    const value = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return value || "main";
  } catch {
    return "main";
  }
}
