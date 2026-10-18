/**
 * 测试职责：依赖文件夹软链的判据 —— 建链、跳过、拒绝与"不覆盖"。
 *
 * 设计说明：全部在真临时目录上跑，因为要断言的正是文件系统语义（符号链接、已存在、坏链接）。
 * 这些规则同时被两条路复用：Run 创建 worktree 时的自动建链，与面板里的「补齐依赖软链」。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLinkableFolder, linkFolders } from "./linked-folders.js";

const temporaryPaths: string[] = [];
afterAll(() => {
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

function makeTemporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

describe("assertLinkableFolder", () => {
  it("拒绝绝对路径、.. 与空值", () => {
    expect(() => assertLinkableFolder("/abs/path")).toThrow(/相对/);
    expect(() => assertLinkableFolder("../outside")).toThrow(/\.\./);
    expect(() => assertLinkableFolder("a/../b")).toThrow(/\.\./);
    expect(() => assertLinkableFolder("   ")).toThrow(/空路径/);
    expect(() => assertLinkableFolder(".")).toThrow(/根目录/);
  });

  it("放行普通的相对路径", () => {
    expect(assertLinkableFolder("node_modules")).toBe("node_modules");
    expect(assertLinkableFolder("packages/web/node_modules")).toBe("packages/web/node_modules");
  });
});

describe("linkFolders", () => {
  it("源存在、目标不存在时建链", () => {
    const source = makeTemporary("pipeline-link-src-");
    const target = makeTemporary("pipeline-link-dst-");
    mkdirSync(join(source, "node_modules"));

    const result = linkFolders({ sourceRoot: source, targetRoot: target, folders: ["node_modules"] });

    expect(result.linked).toEqual(["node_modules"]);
    expect(realpathSync(readlinkSync(join(target, "node_modules")))).toBe(realpathSync(join(source, "node_modules")));
  });

  it("目标已存在时跳过，绝不覆盖", () => {
    const source = makeTemporary("pipeline-link-src2-");
    const target = makeTemporary("pipeline-link-dst2-");
    mkdirSync(join(source, "node_modules"));
    mkdirSync(join(target, "node_modules"));
    writeFileSync(join(target, "node_modules", "keep.txt"), "keep\n");

    const result = linkFolders({ sourceRoot: source, targetRoot: target, folders: ["node_modules"] });

    expect(result.linked).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("已存在");
    expect(existsSync(join(target, "node_modules", "keep.txt"))).toBe(true);
    expect(lstatSync(join(target, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("主仓库里没有该目录时跳过；源等于目标时全部跳过", () => {
    const source = makeTemporary("pipeline-link-src3-");
    const target = makeTemporary("pipeline-link-dst3-");

    expect(linkFolders({ sourceRoot: source, targetRoot: target, folders: ["node_modules"] }).skipped[0]?.reason).toContain("没有这个目录");

    const same = linkFolders({ sourceRoot: source, targetRoot: source, folders: ["node_modules"] });
    expect(same.linked).toEqual([]);
    expect(same.skipped[0]?.reason).toContain("主仓库本身");
  });

  it("越界路径记失败且不会真的建链", () => {
    const source = makeTemporary("pipeline-link-src4-");
    const target = makeTemporary("pipeline-link-dst4-");

    const result = linkFolders({ sourceRoot: source, targetRoot: target, folders: ["../escape"] });

    expect(result.linked).toEqual([]);
    expect(result.failed[0]?.path).toBe("../escape");
    expect(existsSync(join(target, "..", "escape"))).toBe(false);
  });

  it("嵌套路径会创建父目录", () => {
    const source = makeTemporary("pipeline-link-src5-");
    const target = makeTemporary("pipeline-link-dst5-");
    mkdirSync(join(source, "packages", "web"), { recursive: true });
    mkdirSync(join(source, "packages", "web", "node_modules"), { recursive: true });

    const result = linkFolders({ sourceRoot: source, targetRoot: target, folders: ["packages/web/node_modules"] });

    expect(result.linked).toEqual(["packages/web/node_modules"]);
    expect(lstatSync(join(target, "packages", "web", "node_modules")).isSymbolicLink()).toBe(true);
  });
});

/**
 * 与 Run 创建路径的接线：`LocalGitWorktreeAdapter.create` 建完 worktree 后用同一套判据建链。
 * 它保证"新建的 Run worktree 里已经有依赖"，而不是只靠用户记得点手动补链。
 */
describe("创建 Run 的 worktree 时自动建链", () => {
  it("自动把配置的依赖目录链过去，并通过回调报告结果", async () => {
    const { LocalGitWorktreeAdapter } = await import("./worktree.js");
    const projectRoot = makeTemporary("pipeline-link-adapter-src-");
    const worktreeRoot = makeTemporary("pipeline-link-adapter-dst-");
    mkdirSync(join(projectRoot, "node_modules"));
    mkdirSync(join(projectRoot, "target"));
    const results: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot,
      worktreeRoot,
      linkedFolders: ["node_modules", "target", "missing"],
      // 这里只关心建链：git 子命令全部成功，且不真的创建目录（git 在真实路径上会建）。
      runGit: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      onLinkedFolders: (result) => results.push(result.linked),
    });

    const workspace = await adapter.create({ projectId: "p", runId: "run-1", branch: "factory/x", baseCommit: "abc" });

    expect(results).toEqual([["node_modules", "target"]]);
    expect(lstatSync(join(workspace.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(workspace.path, "target")).isSymbolicLink()).toBe(true);
    // 主仓库里没有的目录被跳过，不会凭空建。
    expect(existsSync(join(workspace.path, "missing"))).toBe(false);
  });
});

describe("自动提交排除依赖软链", () => {
  it("commit 的 add 参数里带上 linkedFolders 的 exclude", async () => {
    const { LocalGitWorktreeAdapter } = await import("./worktree.js");
    const commands: string[][] = [];
    const adapter = new LocalGitWorktreeAdapter({
      projectRoot: "/repo",
      worktreeRoot: "/worktrees",
      linkedFolders: ["node_modules", "packages/web/node_modules"],
      runGit: async (args) => {
        commands.push(args);
        if (args[0] === "status") return { exitCode: 0, stdout: " M src/a.ts\\n", stderr: "" };
        if (args[0] === "rev-parse") return { exitCode: 0, stdout: "newsha\\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await adapter.commit({ path: "/worktrees/run-1", branch: "factory/run-1", baseCommit: "abc" }, "title");

    expect(commands[1]).toEqual([
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).pipeline-factory",
      ":(exclude).worktree-manage",
      ":(exclude)node_modules",
      ":(exclude)packages/web/node_modules",
    ]);
  });
});
