/**
 * 模块职责：把一个受管工程的 Plan 落盘目录解析出来，并给出"工作区干净检查"要放行的 pathspec。
 *
 * 为什么两件事必须来自同一次解析：它们说的是同一个目录。分开解析迟早会分叉，表现就是
 *   "确认 Plan 时说工作区干净、建 worktree 时又说脏"——Factory 自己刚写的计划文件把自己挡住了。
 *   目录语义与缺省值定义在 domain 的 plan/plan-directory.ts，这里只负责把配置与当前工程的
 *   repoRoot 接上。
 *
 * 维护提示：`planDirectory` 是配置里**唯一不按配置文件所在目录解析**的路径字段——它相对的是
 *   **受管工程**的根目录，而每个 Project 可以有不同的根，所以只能在这里（拿到 repoRoot 之后）解析。
 */
import { planDirectoryRepoPath, resolvePlanDirectory } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";

/** 某个受管工程的 Plan 落盘目录与该目录对应的干净检查白名单。 */
export type PlanStorage = { directory: string; ignoreDirtyPaths: string[] };

/** 按受管工程根目录解析 Plan 落盘目录；目录落在仓库外时白名单为空（它本就不影响 git 状态）。 */
export function planStorageFor(config: FactoryConfig, repoRoot: string): PlanStorage {
  const directory = resolvePlanDirectory({ projectRoot: repoRoot, configured: config.project.planDirectory });
  const repoPath = planDirectoryRepoPath({ projectRoot: repoRoot, planDirectory: directory });
  return { directory, ignoreDirtyPaths: repoPath ? [repoPath] : [] };
}
