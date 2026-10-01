/**
 * 测试职责：钉住 Plan 落盘目录的两条语义——缺省位置，以及"它对受管仓库而言是哪个相对路径"。
 *
 * 后者是工作区干净检查的白名单来源：目录解析一旦与白名单对不上，Factory 自己刚写的计划文件
 *   就会把下一次派发挡住（"确认时不脏、建 worktree 时脏"）。仓库外的绝对路径返回 null 也是结论，
 *   不是遗漏——那种目录本就不影响 git 状态。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_DIRECTORY, planDirectoryRepoPath, resolvePlanDirectory } from "./plan-directory.js";

describe("Plan 落盘目录", () => {
  it("缺省是受管工程根目录下的 docs/pipeline/plans", () => {
    expect(DEFAULT_PLAN_DIRECTORY).toBe("docs/pipeline/plans");
    expect(resolvePlanDirectory({ projectRoot: "/repo" })).toBe("/repo/docs/pipeline/plans");
  });

  it("相对路径以 projectRoot 为基准，绝对路径原样使用", () => {
    expect(resolvePlanDirectory({ projectRoot: "/repo", configured: "docs/plans" })).toBe("/repo/docs/plans");
    expect(resolvePlanDirectory({ projectRoot: "/repo", configured: "/elsewhere/plans" })).toBe("/elsewhere/plans");
  });

  it("空字符串按缺省处理，不落成仓库根目录", () => {
    expect(resolvePlanDirectory({ projectRoot: "/repo", configured: "   " })).toBe("/repo/docs/pipeline/plans");
  });

  it("给出相对受管仓库的路径，供干净检查做白名单", () => {
    expect(planDirectoryRepoPath({ projectRoot: "/repo", planDirectory: "/repo/docs/pipeline/plans" })).toBe("docs/pipeline/plans");
  });

  it("目录落在仓库外时返回 null（它不影响 git 状态，不需要排除）", () => {
    expect(planDirectoryRepoPath({ projectRoot: "/repo", planDirectory: "/elsewhere/plans" })).toBeNull();
  });

  it("目录恰好是仓库根自身时返回 null —— 没有可排除的相对路径", () => {
    expect(planDirectoryRepoPath({ projectRoot: "/repo", planDirectory: "/repo" })).toBeNull();
  });

  it("前缀相似的兄弟目录不算'之内'", () => {
    // /repo-other 与 /repo 只是前缀相同，不是包含关系——这条边界写错过就会把别人的目录当自己的。
    expect(planDirectoryRepoPath({ projectRoot: "/repo", planDirectory: "/repo-other/plans" })).toBeNull();
  });
});
