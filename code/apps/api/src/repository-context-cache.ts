import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Project } from "@pipeline-factory/domain";

export type RepositoryContext = { key: string; summary: string };

/**
 * Process-local, project-scoped index of stable repository facts. The cache key
 * includes the project configuration, HEAD and working-tree content fingerprints;
 * chat turns and generated plans are intentionally never indexed here.
 */
export class RepositoryContextCache {
  private readonly entries = new Map<string, RepositoryContext>();
  private readonly buildCounts = new Map<string, number>();

  get(project: Project): RepositoryContext {
    const root = project.repoRoot;
    const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || "detached";
    const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim() || "no-head";
    const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const trackedChangedPaths = git(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]).split("\0").filter(Boolean).sort();
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
    const changedFingerprints = [...new Set([...trackedChangedPaths, ...untracked])].map((path) => fingerprintPath(root, path));
    const key = sha256(JSON.stringify({ projectId: project.id, configVersion: project.configVersion, configHash: project.configHash, defaultBranch: project.defaultBranch, branch, head, status, changedFingerprints }));
    const cacheEntryKey = `${project.id}:${key}`;
    const cached = this.entries.get(cacheEntryKey);
    if (cached?.key === key) return cached;

    const topLevels = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const path of files) {
      const top = path.split("/")[0] || path;
      topLevels.set(top, (topLevels.get(top) ?? 0) + 1);
      const name = path.split("/").at(-1) ?? path;
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "[no extension]";
      extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    }
    const largest = (values: Map<string, number>, count: number) => [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count).map(([name, total]) => `${name} (${total})`).join(", ") || "none";
    // 验证 tag 词表：Plan 的 verification.suites 只能用这里列出的词。**只给 tag，不给命令 ID**——
    // 模型声明"要哪一类验证"，命令 ID 由 Factory 解析（见 plan/plan-spec.ts 的 selectVerificationCommands）。
    // `settings` 用可选链读：只读投影与测试替身可能不带它，缺了就是"没登记 tag"，不是错误。
    const declaredTags = [...new Set((project.settings?.commands ?? [])
      .filter((command) => command.category === "verification" && command.enabled !== false)
      .flatMap((command) => command.tags ?? []))].sort();
    const summary = [
      `Project: ${project.name} (${project.id})`,
      `Repository root: ${root}`,
      `Git branch and baseline: ${branch} @ ${head} (default ${project.defaultBranch})`,
      `Project configuration: version ${project.configVersion}, ${project.configHash}`,
      `Verification tags: ${declaredTags.join(", ") || "(none declared)"}`,
      `Tracked files: ${files.length}; changed paths: ${status.split("\n").filter(Boolean).length}; untracked paths: ${untracked.length}`,
      `Top-level areas: ${largest(topLevels, 12)}`,
      `Common file types: ${largest(extensions, 10)}`,
      `Representative tracked paths: ${files.slice(0, 80).join(", ") || "none"}`,
      "This is a repository index only; inspect specific files with authorized tools when needed. It contains no Explorer conversations or plans.",
    ].join("\n");
    const entry = { key, summary };
    const projectPrefix = `${project.id}:`;
    const previousVersions = [...this.entries.keys()].filter((entryKey) => entryKey.startsWith(projectPrefix));
    while (previousVersions.length >= 8) this.entries.delete(previousVersions.shift()!);
    this.entries.set(cacheEntryKey, entry);
    this.buildCounts.set(project.id, (this.buildCounts.get(project.id) ?? 0) + 1);
    return entry;
  }

  getBuildCount(projectId: string): number { return this.buildCounts.get(projectId) ?? 0; }
}

function git(cwd: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintPath(root: string, path: string): string {
  try {
    const target = `${root}/${path}`;
    const stat = lstatSync(target);
    return stat.isSymbolicLink() ? `${path}:symlink:${readlinkSync(target)}` : `${path}:${sha256(readFileSync(target))}`;
  } catch { return `${path}:missing-or-unreadable`; }
}
