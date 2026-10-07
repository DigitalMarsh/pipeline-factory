import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@pipeline-factory/domain";
import { RepositoryContextCache } from "./repository-context-cache.js";

const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repositoryProject(): Project {
  const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-repository-context-"));
  temporaryRepositories.push(repoRoot);
  execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "pipeline-test@example.invalid"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Pipeline test"], { cwd: repoRoot });
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "README.md"), "repository facts\n");
  writeFileSync(join(repoRoot, "src", "entry.ts"), "export const entry = true;\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repoRoot });
  return { id: "project-cache-test", name: "Cache fixture", repoRoot, configVersion: 1, configHash: "config-a" } as Project;
}

describe("RepositoryContextCache", () => {
  it("injects only the declared verification tag vocabulary, never command ids", () => {
    const project = repositoryProject();
    const withCommands = {
      ...project,
      settings: {
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["pnpm", "test"], tags: ["unit", "types"] },
          { commandId: "docs.validate", category: "verification", enabled: true, argv: ["pnpm", "docs"], tags: ["docs"] },
          { commandId: "project.lint", category: "verification", enabled: false, argv: ["pnpm", "lint"], tags: ["lint"] },
          { commandId: "project.start", category: "lifecycle", enabled: true, argv: ["node", "start.mjs"], tags: ["ignored"] },
        ],
      },
    } as unknown as Project;
    const summary = new RepositoryContextCache().get(withCommands).summary;

    // 只有启用中的 verification 命令的 tag 进入词表；禁用的与 lifecycle 命令的 tag 不算。
    expect(summary).toContain("Verification tags: docs, types, unit");
    // 命令 ID 不进提示词：模型声明"要哪一类验证"，解析成 ID 是 Factory 的事。
    expect(summary).not.toContain("project.test");
    expect(summary).not.toContain("docs.validate");
  });

  /**
   * 默认产物模式必须出现在这份上下文里——它是唯一按 Project 注入模型的通道，而探索提示词明确
   * 写着"见仓库上下文里 `Plan artifact mode` 那一行，按它走、不要再问"。这一行丢了，模型就退回
   * "每次问一遍"，而那是用户报的噪音来源。
   */
  it("injects the project's default plan artifact mode, defaulting to REPOSITORY_FILE", () => {
    const cache = new RepositoryContextCache();

    // 老配置行没有这一格：读路径按缺省补上，不给模型一个 undefined。
    expect(cache.get(repositoryProject()).summary).toContain("Plan artifact mode: REPOSITORY_FILE");

    // 改了设置就是另一个配置版本：缓存键含 configVersion/configHash，真实系统里这两样必然一起变
    // （否则这个缓存就会把旧摘要发给模型）。这里照实写，不靠"换个临时目录碰巧换 key"。
    const reviewOnly = { ...repositoryProject(), configVersion: 2, configHash: "config-b", settings: { defaultArtifactMode: "CONVERSATION" } } as unknown as Project;
    expect(cache.get(reviewOnly).summary).toContain("Plan artifact mode: CONVERSATION");
  });

  it("reuses the project index and invalidates on working-tree, Git baseline, or config changes", () => {
    const project = repositoryProject();
    const cache = new RepositoryContextCache();
    const initial = cache.get(project);
    expect(cache.get(project)).toEqual(initial);
    expect(cache.getBuildCount(project.id)).toBe(1);

    writeFileSync(join(project.repoRoot, "src", "new-requirement.ts"), "DO_NOT_COPY_FILE_CONTENT_TO_SUMMARY\n");
    const untracked = cache.get(project);
    expect(untracked.key).not.toBe(initial.key);
    expect(untracked.summary).not.toContain("DO_NOT_COPY_FILE_CONTENT_TO_SUMMARY");
    expect(cache.get(project)).toEqual(untracked);

    writeFileSync(join(project.repoRoot, "src", "new-requirement.ts"), "changed content\n");
    const changedFile = cache.get(project);
    expect(changedFile.key).not.toBe(untracked.key);

    execFileSync("git", ["add", "."], { cwd: project.repoRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "add requirement"], { cwd: project.repoRoot });
    const newBaseline = cache.get(project);
    expect(newBaseline.key).not.toBe(changedFile.key);

    const changedConfig = cache.get({ ...project, configVersion: 2, configHash: "config-b" });
    expect(changedConfig.key).not.toBe(newBaseline.key);
    expect(cache.getBuildCount(project.id)).toBe(5);
  });
});
