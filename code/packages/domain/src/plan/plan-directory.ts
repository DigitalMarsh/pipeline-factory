/**
 * 模块职责：Plan 落盘目录的**唯一**定义与解析——缺省位置、相对 project.root 的语义，以及
 *   "它对受管仓库而言是哪个相对路径"（供工作区干净检查做白名单）。
 *
 * 为什么集中在这里：这个目录有两个互不相干的消费方，它们必须对同一个目录得出同一个结论——
 *   1) 写盘（plan/plan-archive.ts）；
 *   2) 工作区干净检查的白名单（git/working-tree.ts 的 ignorePaths）——Factory 自己写的计划文件
 *      不该把用户的工作区判成"脏"，否则一落盘就把下一次派发锁死。
 *   两处各解析一次，迟早会出现"确认时不脏、建 worktree 时脏"这种自相矛盾的状态。
 *
 * 维护提示：**目录外的绝对路径是合法配置**（用户可以指定仓库外的位置）。那时它对 git 状态毫无影响，
 *   白名单也就不需要它——`planDirectoryRepoPath` 用 null 表达这件事，而不是编一个相对路径出来。
 */
import { relative, resolve } from "node:path";
import { isInsideRoot } from "../platform/paths.js";

/** Plan 落盘目录的缺省值：受管工程根目录下的 `docs/pipeline/plans`。 */
export const DEFAULT_PLAN_DIRECTORY = "docs/pipeline/plans";

/** 把配置值解析成绝对路径：相对路径以 projectRoot 为基准，绝对路径原样使用（缺省走 DEFAULT_PLAN_DIRECTORY）。 */
export function resolvePlanDirectory(input: { projectRoot: string; configured?: string | undefined }): string {
  const configured = input.configured?.trim();
  return resolve(input.projectRoot, configured ? configured : DEFAULT_PLAN_DIRECTORY);
}

/**
 * planDirectory 相对 projectRoot 的路径（git pathspec 可用的形式）；目录落在仓库外时返回 null。
 * 目录恰好就是仓库根自身时同样返回 null——没有可排除的相对路径。
 */
export function planDirectoryRepoPath(input: { projectRoot: string; planDirectory: string }): string | null {
  if (!isInsideRoot(input.projectRoot, input.planDirectory)) return null;
  const relativePath = relative(resolve(input.projectRoot), resolve(input.planDirectory)).replaceAll("\\", "/");
  return relativePath ? relativePath : null;
}
