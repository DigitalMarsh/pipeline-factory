import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

type GitResult = { exitCode: number | null; stdout: string; stderr: string };
type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/**
 * Snapshots Git-visible project changes into the fresh run worktree as its baseline.
 * Ignored files stay out, while tracked edits and ordinary untracked source files become
 * available to build/test commands without being counted as changes made by the run.
 */
export async function snapshotProjectWorkingTree(input: {
  projectRoot: string;
  worktreeRoot: string;
  workspacePath: string;
  baseCommit: string;
  runGit: GitRunner;
}): Promise<string> {
  const projectRoot = resolve(input.projectRoot);
  const worktreeRoot = resolve(input.worktreeRoot);
  const workspacePath = resolve(input.workspacePath);
  const projectStat = await stat(projectRoot).catch(() => null);
  if (!projectStat?.isDirectory()) return input.baseCommit;

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-factory-run-snapshot-"));
  try {
    const patchPath = join(temporaryRoot, "project-working-tree.patch");
    await writeFile(patchPath, "");
    const patchResult = await input.runGit(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", `--output=${patchPath}`, input.baseCommit], projectRoot);
    if (patchResult.exitCode !== 0) throw new Error(`Project changes could not be read: ${patchResult.stderr || "git diff failed"}`);

    const untrackedResult = await input.runGit(["ls-files", "--others", "--exclude-standard", "-z"], projectRoot);
    if (untrackedResult.exitCode !== 0) throw new Error(`Untracked project files could not be listed: ${untrackedResult.stderr || "git ls-files failed"}`);

    const patchStat = await stat(patchPath);
    if (patchStat.size > 0) {
      const applied = await input.runGit(["apply", "--binary", "--whitespace=nowarn", patchPath], workspacePath);
      if (applied.exitCode !== 0) throw new Error(`Project changes could not be applied to the run worktree: ${applied.stderr || "git apply failed"}`);
    }

    let copiedFiles = 0;
    for (const rawPath of untrackedResult.stdout.split("\0")) {
      const projectPath = rawPath.replace(/\/+$/, "");
      if (!projectPath || shouldSkipPath(projectPath)) continue;
      const sourcePath = resolve(projectRoot, projectPath);
      if (!isInside(projectRoot, sourcePath)) throw new Error(`Untracked path escapes the project root: ${projectPath}`);
      if (isInside(workspacePath, sourcePath)) continue;
      if (isInside(projectRoot, worktreeRoot) && isInside(worktreeRoot, sourcePath)) continue;
      const targetPath = resolve(workspacePath, projectPath);
      if (!isInside(workspacePath, targetPath)) throw new Error(`Untracked path escapes the run worktree: ${projectPath}`);
      copiedFiles += await copyUntrackedFile(projectRoot, workspacePath, sourcePath, targetPath, projectPath);
    }

    if (patchStat.size === 0 && copiedFiles === 0) return input.baseCommit;

    const staged = await input.runGit(["add", "-A"], workspacePath);
    if (staged.exitCode !== 0) throw new Error(`Project snapshot could not be staged: ${staged.stderr || "git add failed"}`);
    const hasChanges = await input.runGit(["diff", "--cached", "--quiet"], workspacePath);
    if (hasChanges.exitCode === 0) {
      if (patchStat.size > 0 || copiedFiles > 0) throw new Error("Project files were copied, but Git excluded them from the run baseline");
      return input.baseCommit;
    }
    if (hasChanges.exitCode !== 1) throw new Error(`Project snapshot could not be checked: ${hasChanges.stderr || "git diff --cached failed"}`);

    const hooksPath = join(temporaryRoot, "empty-git-hooks");
    await mkdir(hooksPath);
    const committed = await input.runGit([
      "-c", "user.name=Pipeline Factory",
      "-c", "user.email=pipeline-factory@local",
      "-c", "commit.gpgsign=false",
      "-c", `core.hooksPath=${hooksPath}`,
      "commit", "-m", "Snapshot project working tree for run",
    ], workspacePath);
    if (committed.exitCode !== 0) throw new Error(`Project snapshot could not be recorded: ${committed.stderr || "git commit failed"}`);
    const head = await input.runGit(["rev-parse", "--verify", "HEAD"], workspacePath);
    const snapshotCommit = head.stdout.trim();
    if (head.exitCode !== 0 || !snapshotCommit) throw new Error(`Project snapshot commit could not be verified: ${head.stderr || "HEAD is unavailable"}`);
    return snapshotCommit;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function copyUntrackedFile(projectRoot: string, workspacePath: string, sourcePath: string, targetPath: string, projectPath: string): Promise<number> {
  const sourceStat = await lstat(sourcePath).catch(() => null);
  if (!sourceStat) throw new Error(`Project file changed while the run baseline was being created: ${projectPath}`);
  if (sourceStat.isDirectory()) {
    const nestedGitMetadata = await lstat(join(sourcePath, ".git")).catch(() => null);
    if (nestedGitMetadata) throw new Error(`Nested Git repositories must be committed or handled separately before execution: ${projectPath}`);
    return 0;
  }

  const existingTarget = await lstat(targetPath).catch(() => null);
  if (existingTarget) throw new Error(`Untracked project file conflicts with the selected Git baseline: ${projectPath}`);
  await mkdir(dirname(targetPath), { recursive: true });

  if (sourceStat.isSymbolicLink()) {
    const resolvedSource = await realpath(sourcePath);
    if (!isInside(projectRoot, resolvedSource)) throw new Error(`Untracked symlink points outside the project root: ${projectPath}`);
    const targetForLink = resolve(workspacePath, relative(projectRoot, resolvedSource));
    const linkTarget = relative(dirname(targetPath), targetForLink) || ".";
    await symlink(linkTarget, targetPath);
    return 1;
  }
  if (!sourceStat.isFile()) throw new Error(`Unsupported untracked project entry: ${projectPath}`);

  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, sourceStat.mode & 0o777);
  return 1;
}

function shouldSkipPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => {
    const name = segment.toLocaleLowerCase();
    if (name === ".git") return true;
    if (/^\.env(?:\..*)?$/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
    return /^(?:id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i.test(segment);
  });
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}
