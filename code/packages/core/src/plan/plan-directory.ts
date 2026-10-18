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

/**
 * 这个项目相对路径（或 glob）是否**指向 Factory 的留档目录**：它就是那个目录，或者落在它里面。
 *
 * 为什么需要这个判据：2026-10-11 的真实事故——Explorer 把 `docs/pipeline/plans/**` 写成了方案的
 * `artifact.path` 与改动目标，Executor 于是在留档目录里创建了一个与 Factory **同名同路径**的文件
 * （`plan-<id>-v<rev>.md`），提交后随合并进了主干，Factory 自己的留档被一份执行报告顶掉。
 *
 * **更宽的范围不算"指向"**：`docs/**` 把留档目录包含在内，但把它一并拒掉会让所有写 docs 的计划都
 * 过不了确认。那种情况由执行侧的排除路径兜底——`PlanService.confirm` 会把留档目录永远并进
 * `scope.excludePaths`，执行者的提示词与工作区范围检查都读它。
 */
export function pathTargetsPlanDirectory(input: { path: string; repoRelativePlanDirectory: string }): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replaceAll("\\", "/")
      .replace(/\/\*\*?$/, "")
      .replace(/\/+$/, "");
  const target = normalize(input.path);
  const directory = normalize(input.repoRelativePlanDirectory);
  if (!target || !directory) return false;
  return target === directory || target.startsWith(`${directory}/`);
}
