/**
 * 测试职责：**执行目录**（合并前验证的固定路径）—— 链接的创建、原子切换、清空，以及它与清理的互斥。
 *
 * 设计说明：全部用真文件系统与真软链接。这里最容易错的恰恰是文件系统语义（`readlink`、`rename`
 * 覆盖、真实目录 vs 链接），桩会把这一层抹掉。
 *
 * 维护提示：用例结束后 `afterAll` 统一删临时目录——软链接指向的 worktree 也在里面，
 * 顺序无所谓，`rm -rf` 不会跟随链接。
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { ProjectService } from "../project/project.js";
import type { Project } from "../project/project.js";
import { WorktreeService } from "./service.js";
import { createLocalWorktreeGit } from "./local-git.js";

const temporaryPaths: string[] = [];
afterAll(() => {
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(cwd: string, message: string): void {
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "-q", "-m", message], {
    cwd,
  });
}

type Fixture = { store: InMemoryPipelineStore; project: Project; repoRoot: string; worktreeRoot: string };

function setup(): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-runtime-repo-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "pipeline-runtime-wt-"));
  temporaryPaths.push(repoRoot, worktreeRoot);
  git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "base\n");
  git(repoRoot, ["add", "-A"]);
  commit(repoRoot, "init");
  const store = new InMemoryPipelineStore();
  const project = new ProjectService(store).create({
    id: "project-1",
    name: "project-1",
    repoRoot,
    defaultBranch: "main",
    worktreeRoot,
  });
  return { store, project, repoRoot, worktreeRoot };
}

function serviceFor(fixture: Fixture): WorktreeService {
  return new WorktreeService(fixture.store, { git: createLocalWorktreeGit() });
}

function createBranch(repoRoot: string, branch: string, file: string): void {
  git(repoRoot, ["switch", "-c", branch, "main"]);
  writeFileSync(join(repoRoot, file), `${branch}\n`);
  git(repoRoot, ["add", "-A"]);
  commit(repoRoot, branch);
  git(repoRoot, ["switch", "main"]);
}

function addWorktree(fixture: Fixture, branch: string, name: string): string {
  const path = join(fixture.worktreeRoot, name);
  git(fixture.repoRoot, ["worktree", "add", path, branch]);
  return path;
}

describe("补齐依赖软链", () => {
  it("把主仓库的依赖目录链到指定 worktree", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    const worktreePath = addWorktree(fixture, "feature/a", "a");
    mkdirSync(join(fixture.repoRoot, "node_modules"));
    const service = serviceFor(fixture);
    fixture.store.saveProject({ ...fixture.project, settings: { ...fixture.project.settings, linkedFolders: ["node_modules"] } });
    const project = fixture.store.getProject(fixture.project.id)!;

    const result = await service.linkDependencies(project, "branch:feature/a");

    expect(result.folders).toEqual(["node_modules"]);
    expect(result.linked).toEqual(["node_modules"]);
    expect(realpathSync(join(worktreePath, "node_modules"))).toBe(realpathSync(join(fixture.repoRoot, "node_modules")));
  });

  it("没有 worktree 的分支不能补链", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/local", "local.txt");

    await expect(serviceFor(fixture).linkDependencies(fixture.project, "branch:feature/local")).rejects.toMatchObject({
      code: "WORKTREE_DEPENDENCY_BLOCKED",
    });
  });
});

describe("执行目录", () => {
  it("初始为空：只有固定路径，没有链接", async () => {
    const fixture = setup();
    const runtime = await serviceFor(fixture).runtime(fixture.project);

    expect(runtime.path).toBe(join(fixture.worktreeRoot, ".runtime"));
    expect(runtime.exists).toBe(false);
    expect(runtime.link).toBeNull();
    expect(runtime.current).toBeNull();
  });

  it("切换到某个 worktree：创建链接并能反查出当前目标", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    const worktreePath = addWorktree(fixture, "feature/a", "a");
    const service = serviceFor(fixture);

    const result = await service.switchRuntime(fixture.project, "branch:feature/a");

    const repoLink = join(fixture.worktreeRoot, ".runtime", "repo");
    expect(lstatSync(repoLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(readlinkSync(repoLink))).toBe(realpathSync(worktreePath));
    expect(result.previousTarget).toBeNull();
    expect(result.runtime.current).toEqual({
      itemId: "branch:feature/a",
      branch: "feature/a",
      displayName: "feature/a",
      worktreePath: expect.stringContaining("a"),
    });
  });

  it("再切换：链接被替换，旧目标仍留在磁盘上", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    createBranch(fixture.repoRoot, "feature/b", "b.txt");
    const first = addWorktree(fixture, "feature/a", "a");
    const second = addWorktree(fixture, "feature/b", "b");
    const service = serviceFor(fixture);

    await service.switchRuntime(fixture.project, "branch:feature/a");
    const result = await service.switchRuntime(fixture.project, "branch:feature/b");

    const repoLink = join(fixture.worktreeRoot, ".runtime", "repo");
    expect(realpathSync(readlinkSync(repoLink))).toBe(realpathSync(second));
    expect(result.previousTarget && realpathSync(result.previousTarget)).toBe(realpathSync(first));
    expect(result.runtime.current?.itemId).toBe("branch:feature/b");
    // 旧目标没有被删除。
    expect(existsSync(first)).toBe(true);
  });

  it("没有 worktree 的本地分支不能设为目标", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/local", "local.txt");

    await expect(serviceFor(fixture).switchRuntime(fixture.project, "branch:feature/local")).rejects.toMatchObject({
      code: "WORKTREE_RUNTIME_BLOCKED",
    });
  });

  it("repo 是真实目录时拒绝切换与清空，且不动它", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    addWorktree(fixture, "feature/a", "a");
    const repoLink = join(fixture.worktreeRoot, ".runtime", "repo");
    mkdirSync(repoLink, { recursive: true });
    writeFileSync(join(repoLink, "user-file.txt"), "keep me\n");
    const service = serviceFor(fixture);

    await expect(service.switchRuntime(fixture.project, "branch:feature/a")).rejects.toMatchObject({
      code: "WORKTREE_RUNTIME_BLOCKED",
    });
    await expect(service.clearRuntime(fixture.project)).rejects.toMatchObject({ code: "WORKTREE_RUNTIME_BLOCKED" });
    expect(existsSync(join(repoLink, "user-file.txt"))).toBe(true);
  });

  it("清空只删链接", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    const worktreePath = addWorktree(fixture, "feature/a", "a");
    const service = serviceFor(fixture);
    await service.switchRuntime(fixture.project, "branch:feature/a");

    const result = await service.clearRuntime(fixture.project);

    expect(result.cleared).toBe(true);
    expect(existsSync(join(fixture.worktreeRoot, ".runtime", "repo"))).toBe(false);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("当前执行目录目标不能被清理；切走之后可以", async () => {
    const fixture = setup();
    createBranch(fixture.repoRoot, "feature/a", "a.txt");
    createBranch(fixture.repoRoot, "feature/b", "b.txt");
    addWorktree(fixture, "feature/a", "a");
    addWorktree(fixture, "feature/b", "b");
    git(fixture.repoRoot, ["merge", "--no-ff", "--no-edit", "feature/a"]);
    const service = serviceFor(fixture);
    await service.switchRuntime(fixture.project, "branch:feature/a");
    const item = (await service.list(fixture.project)).items.find((entry) => entry.branch === "feature/a");

    await expect(
      service.cleanup(fixture.project, { itemId: "branch:feature/a", expectedBranchHead: item?.lastCommit ?? null }),
    ).rejects.toMatchObject({ code: "WORKTREE_CLEANUP_BLOCKED" });

    await service.switchRuntime(fixture.project, "branch:feature/b");
    const cleaned = await service.cleanup(fixture.project, {
      itemId: "branch:feature/a",
      expectedBranchHead: item?.lastCommit ?? null,
    });
    expect(cleaned.worktreeRemoved).toBe(true);
  });
});
