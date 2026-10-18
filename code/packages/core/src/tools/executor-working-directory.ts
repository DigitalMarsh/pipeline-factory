/**
 * Resolve a safe command working directory from the approved repository-relative scope.
 * A single artifact subtree becomes the command root; disjoint scopes fall back to the
 * worktree root so commands never start in an arbitrary included directory.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, posix } from "node:path";

export async function resolveExecutorWorkingDirectory(
  workspaceRoot: string,
  includePaths: string[],
  artifactPath?: string,
): Promise<string> {
  const root = await realpath(workspaceRoot);
  const relativeDirectory = artifactPath ? scopeDirectory(artifactPath) : commonScopeDirectory(includePaths);
  const target = resolve(root, relativeDirectory);
  assertInsideWorkspace(root, target);

  let current = root;
  const remaining = relative(root, target).split(sep).filter(Boolean);
  for (const part of remaining) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw new Error("EXECUTOR_WORKING_DIRECTORY_SYMLINK_BLOCKED");
    if (!info.isDirectory()) throw new Error("EXECUTOR_WORKING_DIRECTORY_NOT_DIRECTORY");
  }

  const resolvedTarget = await realpath(target);
  assertInsideWorkspace(root, resolvedTarget);
  return resolvedTarget;
}

function commonScopeDirectory(includePaths: string[]): string {
  if (includePaths.length === 0) return ".";
  const directories = includePaths.map(scopeDirectory).map((value) => (value === "." ? [] : value.split("/")));
  const common: string[] = [];
  for (let index = 0; index < Math.min(...directories.map((parts) => parts.length)); index += 1) {
    const part = directories[0]?.[index];
    if (!part || directories.some((parts) => parts[index] !== part)) break;
    common.push(part);
  }
  return common.length > 0 ? posix.join(...common) : ".";
}

function scopeDirectory(scopePath: string): string {
  const normalized = scopePath.replace(/\\/g, "/");
  if (isAbsolute(scopePath) || /^[A-Za-z]:\//.test(normalized)) throw new Error("EXECUTOR_SCOPE_PATH_MUST_BE_RELATIVE");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error("EXECUTOR_SCOPE_PATH_ESCAPES_WORKSPACE");

  const wildcardIndex = normalized.search(/[?*[\]{}]/);
  const directory =
    wildcardIndex >= 0
      ? normalized.slice(0, wildcardIndex).replace(/\/+$/, "")
      : posix.extname(normalized)
        ? posix.dirname(normalized)
        : normalized;
  const safeDirectory = directory || ".";
  const normalizedDirectory = posix.normalize(safeDirectory);
  if (
    normalizedDirectory === ".git" ||
    normalizedDirectory.startsWith(".git/") ||
    normalizedDirectory === ".env" ||
    normalizedDirectory.startsWith(".env/")
  ) {
    throw new Error("EXECUTOR_WORKING_DIRECTORY_PROTECTED");
  }
  return normalizedDirectory;
}

function assertInsideWorkspace(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("EXECUTOR_WORKING_DIRECTORY_ESCAPES_WORKSPACE");
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
