/**
 * 模块职责：Plan 的**派发前预检** —— 在冻结 Revision 之前，把"这个计划假设的东西现实里不存在"
 *   这类事实查出来，而不是等 Run 跑起来再阻塞。
 *
 * 为什么做这件事：全库 Run 的阻塞原因高度集中，且**没有一条是"模型不会写代码"**——
 *   `package.json remains missing in expected project directory`、`index.html 缺失`、
 *   `工作树为空`、`基线不含目标文件`。它们全是"计划假设的前置条件与现实不符"。而 Explorer 是只读的、
 *   读得到仓库，这些事实在生成 Plan 时就能查出来。docs/execution-preflight-and-recovery.md 是上次同类
 *   事故的人工复盘，但**它只是文档**——这里把它变成产品里的一道闸门。
 *
 * 判定规则（**边界即正确性，逐条都有理由**）：
 *   1) 基线 = `baseCommit`。这不是省略：worktree 的基线恒等于 baseCommit（见 git/worktree.ts，
 *      派发要求工作区干净），所以"文件在不在"就是"在 baseCommit 里在不在"。
 *   2) **只查具体文件路径**（无通配、最后一段带扩展名）。通配（`dir/**`）描述的是"在哪个范围里干活"，
 *      范围内的东西可以新建 —— 查它必然误伤"新建一个目录树"这类正常计划。
 *   3) **产物路径（artifactPath）缺失只警告、不阻断**：产物天然可能是要新建的文件
 *      （"添加甘特图"就要新建组件）。而 include 里那些**具体的输入文件**不存在，几乎一定是
 *      计划建立在一个幻觉上——那才是要挡住的。
 *   4) 工作区不干净只警告：它由建 worktree 时的那道硬闸门负责（见 git/working-tree.ts），
 *      这里提前告知，让用户在点"确认"之前就知道派发会被挡。
 *
 * 为什么是**同步**的：它跑在 `PlanService.confirm` 这条同步短路径上，与 git/merge-inspector.ts 同样
 *   的理由——异步化只会把错误处理推给 22 个调用方。回调式 IO 在这里不值得换来同步/异步的分裂。
 *
 * 维护提示：本模块**不改任何状态**，也不自动修复；它只产出结论。确认闸门由 plan/service.ts 落。
 */
import { execFileSync } from "node:child_process";
import { workingTreeStatusArgs, parseWorkingTreeStatus } from "../git/working-tree.js";
import { planDirectoryRepoPath, resolvePlanDirectory } from "./plan-directory.js";
import type { CommandResult } from "../platform/commands.js";

/** 预检发现的一条问题。`blocking` 会阻断确认，`warning` 只提示。 */
export type PlanPreflightIssue = {
  severity: "blocking" | "warning";
  code: "PATH_MISSING" | "ARTIFACT_MISSING" | "WORKING_TREE_DIRTY" | "INSPECTION_UNAVAILABLE";
  message: string;
  paths: string[];
};

/** 预检结论；按严重度分好组，调用方不需要自己过滤。 */
export type PlanPreflightResult = { blocking: PlanPreflightIssue[]; warnings: PlanPreflightIssue[] };

/** 预检输入：足够回答"这个计划要处理的文件在基线里存在吗"。 */
export type PlanPreflightInput = {
  repoRoot: string;
  baseCommit: string;
  includePaths: readonly string[];
  artifactPath?: string | undefined;
};

export type PlanPreflightInspector = (input: PlanPreflightInput) => PlanPreflightResult;

/** 未配置 inspector 时的结论：什么都没查出来（测试与 V1 遗留路径用）。 */
export const emptyPlanPreflight: PlanPreflightInspector = () => ({ blocking: [], warnings: [] });

/** 同步 git 执行端口；`input` 供需要 stdin 的命令（`cat-file --batch-check`）使用。 */
type SyncGitRunner = (args: string[], cwd: string, input?: string) => CommandResult;

/**
 * 本地实现：用 `git cat-file -e <baseCommit>:<path>` 问"这个路径在基线上存在吗"。
 * 一个命令同时覆盖文件与目录（git 对目录解析到 tree），不需要先判断类型。
 *
 * `configuredPlanDirectory` 由组合根传入：工作区检查的白名单必须与"Plan 落盘目录"同源，
 * 否则 Factory 自己写的计划文件会让每次确认都报"工作区脏"。
 */
export function createLocalPlanPreflightInspector(
  options: { configuredPlanDirectory?: string | undefined; runGit?: SyncGitRunner | undefined } = {},
): PlanPreflightInspector {
  const runGit = options.runGit ?? defaultSyncGit;

  return (input) => {
    const blocking: PlanPreflightIssue[] = [];
    const warnings: PlanPreflightIssue[] = [];

    // 仓库本身读不到时不做任何路径判断——"查不出来"和"不存在"是两件事，
    // 把它们混为一谈会用一条误报挡住整个确认流程。
    if (!isRepository(input.repoRoot, runGit)) {
      warnings.push({
        severity: "warning",
        code: "INSPECTION_UNAVAILABLE",
        message: `无法读取受管工程的 Git 状态（${input.repoRoot}），本次未做路径预检。`,
        paths: [],
      });
      return { blocking, warnings };
    }

    const artifactPath = normalizeRepoPath(input.artifactPath);
    // **一次进程问完所有路径**：`cat-file --batch-check` 按行读入、按行输出，顺序一一对应。
    // 逐个 spawn 是这条同步路径上最容易被忽略的开销——每个进程 5~10ms，include 一多就是几百毫秒，
    // 而且全都卡在事件循环上。产物路径一起问，省掉第二次 spawn。
    const includeFiles = collectConcreteFiles(input.includePaths, artifactPath);
    const queried = artifactPath ? [...includeFiles, artifactPath] : includeFiles;
    const batch = existingPaths(input.repoRoot, input.baseCommit, queried, runGit);
    if (!batch.available) {
      // 查不出来 ≠ 不存在：宁可只出一句"本次未做路径预检"，也不要凭一次失败的 git 调用
      // 把每个 Plan 都判成非法。工作区检查照做——它是独立的一次调用。
      warnings.push({
        severity: "warning",
        code: "INSPECTION_UNAVAILABLE",
        message: "无法读取 Git 基线内容，本次未做路径预检。",
        paths: [],
      });
    } else {
      const missing = includeFiles.filter((path) => !batch.existing.has(path));
      if (missing.length > 0) {
        blocking.push({
          severity: "blocking",
          code: "PATH_MISSING",
          message: `计划要处理的文件在基线里不存在：${missing.join("、")}。若这些是要新建的文件，请改写成所在目录的通配范围（如 \`dir/**\`）后重新生成计划。`,
          paths: missing,
        });
      }

      if (artifactPath && !batch.existing.has(artifactPath)) {
        warnings.push({
          severity: "warning",
          code: "ARTIFACT_MISSING",
          message: `产物路径在基线里不存在，Run 会新建它：${artifactPath}`,
          paths: [artifactPath],
        });
      }
    }

    const planDirectory = resolvePlanDirectory({ projectRoot: input.repoRoot, configured: options.configuredPlanDirectory });
    const repoRelative = planDirectoryRepoPath({ projectRoot: input.repoRoot, planDirectory });
    const status = runGit(workingTreeStatusArgs(repoRelative ? [repoRelative] : undefined), input.repoRoot);
    if (status.exitCode !== 0) {
      warnings.push({
        severity: "warning",
        code: "INSPECTION_UNAVAILABLE",
        message: "无法读取工作区状态，本次未判断工作区是否干净。",
        paths: [],
      });
    } else {
      const dirty = parseWorkingTreeStatus(status.stdout);
      if (dirty.length > 0) {
        warnings.push({
          severity: "warning",
          code: "WORKING_TREE_DIRTY",
          message: `受管工程有 ${dirty.length} 个未提交改动，派发 Run 会被阻塞；请先提交或 stash。`,
          paths: dirty,
        });
      }
    }

    return { blocking, warnings };
  };
}

/** 去重后的"具体文件"清单（产物路径单独判、只警告，所以排除在外）。 */
function collectConcreteFiles(includePaths: readonly string[], artifactPath: string | undefined): string[] {
  const files = new Set<string>();
  for (const candidate of includePaths) {
    const path = normalizeRepoPath(candidate);
    if (!path || !isConcreteFile(path) || path === artifactPath) continue;
    files.add(path);
  }
  return [...files];
}

/**
 * **一次进程**问出哪些路径在 `baseCommit` 上存在。
 * `git cat-file --batch-check` 按行读入 `<commit>:<path>`、按行输出对应记录（**顺序一一对应**），
 * 不存在的记录以 ` missing` 结尾。空清单直接返回、不 spawn 进程。
 *
 * `available` 是"这次查询本身有没有成功"：命令失败时**不能**把返回值当成"全都不存在"——
 * 那会让每个 Plan 都被判成非法。调用方据此只出一句"本次未做路径预检"。
 */
function existingPaths(
  repoRoot: string,
  baseCommit: string,
  paths: readonly string[],
  runGit: SyncGitRunner,
): { available: boolean; existing: Set<string> } {
  const existing = new Set<string>();
  if (paths.length === 0) return { available: true, existing };
  const result = runGit(["cat-file", "--batch-check"], repoRoot, `${paths.map((path) => `${baseCommit}:${path}`).join("\n")}\n`);
  if (result.exitCode !== 0) return { available: false, existing };
  const lines = result.stdout.split("\n");
  paths.forEach((path, index) => {
    const line = (lines[index] ?? "").trim();
    if (line && !line.endsWith(" missing")) existing.add(path);
  });
  return { available: true, existing };
}

function isRepository(repoRoot: string, runGit: SyncGitRunner): boolean {
  return runGit(["rev-parse", "--is-inside-work-tree"], repoRoot).exitCode === 0;
}

/** 与 git/merge-inspector.ts 的 gitCommand 同一形态：非 0 退出码走 exitCode，不 reject。`input` 供 stdin 用。 */
function defaultSyncGit(args: string[], cwd: string, input?: string): CommandResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

/**
 * 归一到仓库相对路径；空、绝对、含 `..` 的一律返回 undefined —— 这些不是"仓库里的某个路径"，
 * 拿去问 git 只会得到误导性的答案（`cat-file` 对越界路径同样以非 0 退出）。
 */
function normalizeRepoPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) return undefined;
  return trimmed;
}

/** 具体文件 = 无通配，且最后一段带扩展名。见模块注释的判定规则 2。 */
function isConcreteFile(path: string): boolean {
  if (path.includes("*")) return false;
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(leaf);
}
