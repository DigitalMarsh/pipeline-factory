/**
 * 模块职责：Merge 前的 Git 证据端口 —— GitMergeInspector 接口、本地实现
 *   localGitMergeInspector，以及它使用的两个同步 git 辅助 gitCommand / gitResolveCommit。
 *
 * 为什么从 index.ts 抽出来（批 D：IO 边界）：这是领域层里最"安静"的一块 IO —— 它不起
 *   长驻进程、没有异步，只是同步 execFileSync 反复问 Git 四个问题。正因为安静，它之前混在
 *   index.ts 里很难被注意到；搬出来之后它与同目录的 worktree.ts、worktree-snapshot.ts
 *   一起构成完整的 Git 边界，而 run/merge.ts 只透过 GitMergeInspector 接口与它相连。
 *
 * 维护提示：
 *   1) **四个方法各自的"仓库不存在时返回什么"不一样，这是有意的，不要统一**：
 *      commitExists 与 isAncestor 在 repoRoot 不存在时返回 **true**（放行），
 *      resolveCommit 返回 **null**；branchContains 同样返回 true。
 *      放行的理由是类头注释写的那句：无效的旧测试路径交由 Project API 的仓库校验拦截 ——
 *      这里不是那一道防线。反过来把这里改成 false，会让"仓库暂不可用"被误报成"提交不存在"，
 *      从而把 Run 判成 STALE。
 *   2) gitResolveCommit 用 `rev-parse --verify --end-of-options`，`--end-of-options` 不能去掉：
 *      它保证以 `-` 开头的 ref 不会被当成 git 的选项解析（否则模型/配置里一个叫 `--help`
 *      的分支名就能改变命令语义）。
 *   3) gitCommand 把非 0 退出码与调用失败**都**映射成 false（它只在 `git cat-file -e` /
 *      `merge-base --is-ancestor` 这两种"用退出码回答问题"的场景使用，两者的语义都是
 *      "是/否"）。不要拿它去跑有输出内容的命令 —— 它把 stdout 丢掉了。
 *   4) 这两个辅助与 defaultGitCommand（git/worktree.ts）**不是同类**：那个是异步、走
 *      execFile、永远 resolve 并保留 stdout；这里是有意同步的。Merge 检查发生在一次请求
 *      的短路径上，异步化只会把错误处理推给调用方。
 *   5) MergeReconciliation* 三个类型**不在这里**，它们仍属于 Merge 业务形状（引用
 *      MergeRequest），留在 index.ts 等待批 E 按域拆分。本文件对领域类型零依赖。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Merge 前必须由 Git 证明源提交和目标分支的关系；测试可注入确定性实现。 */
export type GitMergeInspector = {
  commitExists(repoRoot: string, commit: string): boolean;
  resolveCommit(repoRoot: string, ref: string): string | null;
  isAncestor(repoRoot: string, sourceCommit: string, targetCommit: string): boolean;
  branchContains(repoRoot: string, targetBranch: string, targetCommit: string): boolean;
};

function gitCommand(repoRoot: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function gitResolveCommit(repoRoot: string, ref: string): string | null {
  if (!existsSync(repoRoot)) return null;
  try {
    return (
      execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** 默认 Git 证据实现；无效的旧测试路径交由 Project API 的仓库校验拦截。 */
export const localGitMergeInspector: GitMergeInspector = {
  commitExists(repoRoot, commit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  },
  resolveCommit(repoRoot, ref) {
    return gitResolveCommit(repoRoot, ref);
  },
  isAncestor(repoRoot, sourceCommit, targetCommit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["merge-base", "--is-ancestor", sourceCommit, targetCommit]);
  },
  branchContains(repoRoot, targetBranch, targetCommit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["merge-base", "--is-ancestor", targetCommit, targetBranch]);
  },
};
