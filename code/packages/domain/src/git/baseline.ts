/**
 * 模块职责：Project 的 Git 基线解析 —— 把 project.defaultBranch 解析成一个**确定存在**的
 *   commit SHA，作为 Plan 契约里的 baseCommit 与 Run 的起点。
 *
 * 为什么从 plan/service.ts 搬过来（批 D：IO 边界）：它原先挂在 PlanService 文件里，是
 *   "领域层混入 IO" 的典型 —— 一个纯业务类旁边藏着一个 execFileSync。它同时也不属于 Plan：
 *   Project 的基线是 git 层的概念，PlanService 只是它最频繁的调用方。搬进 git/ 之后它与
 *   worktree.ts、merge-inspector.ts 一起构成完整的 Git 边界。
 *
 * 维护提示：
 *   1) **它只解析，不校验仓库是否存在**：`git rev-parse` 失败、输出为空、或 repoRoot 不存在，
 *      统一收敛成一条 `Project <id> has no verified Git baseline: ...` 错误向上抛。
 *      不要把 catch 改成返回 null —— 调用方（PlanService 的 confirm/enqueue/revision 路径）
 *      全都把"拿不到基线"当成硬失败，返回 null 会让一个没有基线的 Plan 一路走到派发。
 *   2) 用 `rev-parse --verify <branch>^{commit}` 而不是 `rev-parse <branch>`：`^{commit}` 把
 *      结果剥到 commit 对象——带注解的 tag 会被解引用，指向 tree/blob 的 ref 会直接失败。
 *      这是"契约里的 baseCommit 一定是一个 commit"的保证，不是格式偏好。
 *   3) 它是**同步**的（execFileSync），而这不是可以随手改的：六个调用点（confirm、enqueue、
 *      两条 revision 路径等）全是**同步方法**，插进一个 await 会把它们全变成 async，
 *      进而改动 PlanService 的整个 API 面。真要异步化，得先决定这些方法是 async 还是
 *      在构造时就把基线读好缓存起来。
 *   4) 返回值里的 baseBranch 直接取 project.defaultBranch（校验通过的那一个），不是重新读
 *      git 的当前分支 —— 基线分支来自 Project 配置，与工作区的 HEAD 无关。
 *   5) 对 Project 的依赖是 `import type { Project } from "../project/project.js"` —— 直接从声明处取，
 *      不经 index.ts barrel。这既避免了 value 级环，也避免把 git/ 挂进那个类型强连通分量。
 */
import { execFileSync } from "node:child_process";
import type { Project } from "../project/project.js";

export function verifiedProjectBaseline(project: Project): { baseBranch: string; baseCommit: string } {
  try {
    const baseCommit = execFileSync("git", ["rev-parse", "--verify", `${project.defaultBranch}^{commit}`], { cwd: project.repoRoot, encoding: "utf8" }).trim();
    if (!baseCommit) throw new Error("empty commit");
    return { baseBranch: project.defaultBranch, baseCommit };
  } catch (error) {
    throw new Error(`Project ${project.id} has no verified Git baseline: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
