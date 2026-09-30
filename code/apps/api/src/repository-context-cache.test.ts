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
