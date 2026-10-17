/**
 * 测试职责：钉住 Plan 落盘目录的两条语义——缺省位置，以及"它对受管仓库而言是哪个相对路径"。
 *
 * 后者是工作区干净检查的白名单来源：目录解析一旦与白名单对不上，Factory 自己刚写的计划文件
 *   就会把下一次派发挡住（"确认时不脏、建 worktree 时脏"）。仓库外的绝对路径返回 null 也是结论，
 *   不是遗漏——那种目录本就不影响 git 状态。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_DIRECTORY, pathTargetsPlanDirectory, planDirectoryRepoPath, resolvePlanDirectory } from "./plan-directory.js";

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

/**
 * 这条判据挡的是 2026-10-11 的真实事故：Explorer 把留档目录写成了方案的 artifact 与改动目标，
 * Executor 于是在那里创建了与 Factory 同名同路径的文件，提交后把 Factory 自己的留档顶掉。
 *
 * 边界要分清：**指向**（就是它 / 在它里面）算；**包含它**（`docs/**` 之于
 * `docs/pipeline/plans`）不算——后者放行，由执行侧的排除路径兜底，否则所有写 docs 的计划都过不了确认。
 */
describe("路径是否指向 Plan 留档目录", () => {
  const directory = "docs/pipeline/plans";
  const hit = (path: string) => pathTargetsPlanDirectory({ path, repoRelativePlanDirectory: directory });

  it("就是目录本身、或带 glob 的目录本身，都算指向", () => {
    expect(hit("docs/pipeline/plans")).toBe(true);
    expect(hit("docs/pipeline/plans/")).toBe(true);
    expect(hit("docs/pipeline/plans/**")).toBe(true);
    expect(hit("docs/pipeline/plans/*")).toBe(true);
  });

  it("落在目录里的具体文件算指向", () => {
    expect(hit("docs/pipeline/plans/plan-0c924e6d-f52-v2.md")).toBe(true);
    expect(hit("docs/pipeline/plans/nested/anything.md")).toBe(true);
  });

  it("更宽的范围不算指向（由执行侧的排除路径兜底，不在这里拦）", () => {
    expect(hit("docs/**")).toBe(false);
    expect(hit("docs")).toBe(false);
    expect(hit("**")).toBe(false);
  });

  it("兄弟目录、其它目录与空值都不算", () => {
    expect(hit("docs/pipeline/plan")).toBe(false);
    expect(hit("code/src/app.ts")).toBe(false);
    expect(hit("docs/pipeline/plans-archive/x.md")).toBe(false);
    expect(hit("")).toBe(false);
    expect(pathTargetsPlanDirectory({ path: "docs/pipeline/plans", repoRelativePlanDirectory: "" })).toBe(false);
  });

  it("反斜杠与首尾空白按 Windows 路径归一化", () => {
    expect(hit(" docs\\pipeline\\plans\\plan-1.md ")).toBe(true);
  });
});
