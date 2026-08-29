import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile as readFileAsync, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import type { CommandExecutor, CommandResult, HookContext, ToolCall, ToolRole } from "./index.js";

export type BuiltinToolContext = {
  loopId?: string;
  role?: ToolRole;
  workspacePath: string;
  projectId?: string;
  runId?: string;
  branch?: string;
  baseCommit?: string;
  exitReason?: string;
};

export type BuiltinToolExecutorOptions = {
  workspaceRoot: string;
  registeredCommandExecutor?: CommandExecutor;
  mcpToolExecutor?: (name: string, input: Record<string, unknown>, context: BuiltinToolContext) => Promise<unknown>;
  pluginToolExecutor?: (name: string, input: Record<string, unknown>, context: BuiltinToolContext) => Promise<unknown>;
  computerUseExecutor?: (input: Record<string, unknown>, context: BuiltinToolContext) => Promise<unknown>;
  processRunner?: (argv: string[], cwd: string, timeoutMs: number, env?: Record<string, string>, stdin?: string) => Promise<CommandResult>;
};

const MAX_FILE_BYTES = 1_048_576;
const MAX_SEARCH_RESULTS = 200;
const DEFAULT_TIMEOUT_MS = 120_000;

export class BuiltinToolExecutor {
  private readonly workspaceRoot: string;
  private readonly processRunner: NonNullable<BuiltinToolExecutorOptions["processRunner"]>;

  constructor(private readonly options: BuiltinToolExecutorOptions) {
    const configuredRoot = resolve(options.workspaceRoot);
    try {
      this.workspaceRoot = realpathSync(configuredRoot);
    } catch {
      this.workspaceRoot = configuredRoot;
    }
    this.processRunner = options.processRunner ?? defaultProcessRunner;
  }

  async execute(call: ToolCall, context: BuiltinToolContext): Promise<unknown> {
    const requestedWorkspace = resolve(context.workspacePath || this.workspaceRoot);
    const workspacePath = await realpath(requestedWorkspace).catch(() => requestedWorkspace);
    if (!this.isInside(workspacePath)) throw new Error("Tool workspace is outside the configured workspace boundary");
    switch (call.tool) {
      case "read_file": return this.readFile(call.input);
      case "list_files": return this.listFiles(call.input);
      case "git_status": return this.git(["status", "--short", "--branch"], workspacePath);
      case "git_diff": return this.gitDiff(call.input, workspacePath);
      case "git_log": return this.gitLog(call.input, workspacePath);
      case "search_text": return this.searchText(call.input);
      case "write_file": return this.writeFile(call.input);
      case "apply_patch": return this.applyPatch(call.input, workspacePath);
      case "run_registered_command": return this.runRegistered(call.input, context);
      case "run_verification": return this.runRegistered(call.input, context);
      case "git_commit": return this.gitCommit(call.input, workspacePath);
      case "run_command": throw new Error("Arbitrary shell commands are not available through the ToolGateway");
      default:
        if (call.tool.startsWith("mcp:") && this.options.mcpToolExecutor) return this.options.mcpToolExecutor(call.tool, call.input, context);
        if (call.tool.startsWith("plugin:") && this.options.pluginToolExecutor) return this.options.pluginToolExecutor(call.tool, call.input, context);
        if (call.tool === "computer_use" && this.options.computerUseExecutor) return this.options.computerUseExecutor(call.input, context);
        throw new Error("Unsupported tool " + call.tool);
    }
  }

  private async readFile(input: Record<string, unknown>): Promise<{ path: string; content: string }> {
    const target = await this.safePath(requiredString(input, "path"), false);
    const metadata = await stat(target.absolute);
    if (!metadata.isFile()) throw new Error("Path " + target.relative + " is not a file");
    if (metadata.size > MAX_FILE_BYTES) throw new Error("File " + target.relative + " exceeds the " + MAX_FILE_BYTES + "-byte limit");
    return { path: target.relative, content: await readFileAsync(target.absolute, "utf8") };
  }

  private async listFiles(input: Record<string, unknown>): Promise<{ files: string[]; truncated: boolean }> {
    const target = await this.safePath(optionalString(input, "path") ?? ".", false);
    const metadata = await stat(target.absolute);
    if (!metadata.isDirectory()) throw new Error("Path " + target.relative + " is not a directory");
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      if (files.length >= MAX_SEARCH_RESULTS) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (isProtectedName(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        const relativePath = this.toRelative(absolute);
        if (entry.isSymbolicLink()) {
          files.push(relativePath);
        } else if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
        if (files.length >= MAX_SEARCH_RESULTS) return;
      }
    };
    await walk(target.absolute);
    return { files, truncated: files.length >= MAX_SEARCH_RESULTS };
  }

  private async gitDiff(input: Record<string, unknown>, cwd: string): Promise<unknown> {
    const args = ["diff"];
    if (input.staged === true) args.push("--cached");
    const path = optionalString(input, "path");
    if (path) args.push("--", (await this.safePath(path, true)).relative);
    return this.git(args, cwd);
  }

  private async gitLog(input: Record<string, unknown>, cwd: string): Promise<unknown> {
    const limit = boundedInteger(input.limit, 20, 1, 50);
    return this.git(["log", "-" + limit, "--oneline", "--decorate"], cwd);
  }

  private async searchText(input: Record<string, unknown>): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    const query = requiredString(input, "query");
    if (!query) throw new Error("Search query must not be empty");
    const root = await this.safePath(optionalString(input, "path") ?? ".", false);
    const caseSensitive = input.caseSensitive !== false;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const walk = async (directory: string): Promise<void> => {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (isProtectedName(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const metadata = await stat(absolute);
        if (metadata.size > MAX_FILE_BYTES) continue;
        const content = await readFileAsync(absolute);
        if (content.includes(0)) continue;
        const lines = content.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const haystack = caseSensitive ? lines[index]! : lines[index]!.toLocaleLowerCase();
          if (haystack.includes(needle)) matches.push({ path: this.toRelative(absolute), line: index + 1, text: lines[index]! });
          if (matches.length >= MAX_SEARCH_RESULTS) return;
        }
      }
    };
    await walk(root.absolute);
    return { matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
  }

  private async writeFile(input: Record<string, unknown>): Promise<{ path: string; bytes: number }> {
    const target = await this.safePath(requiredString(input, "path"), true);
    const content = requiredString(input, "content");
    await mkdir(dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, content, "utf8");
    return { path: target.relative, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async applyPatch(input: Record<string, unknown>, cwd: string): Promise<unknown> {
    const patch = requiredString(input, "patch");
    const paths = [...patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)(?:\t[^\n]*)?$/gm)].map((match) => match[1]!.trim());
    if (paths.length === 0) throw new Error("Patch does not contain file headers");
    for (const path of paths) {
      const normalized = path.replace(/^(?:a|b)\//, "");
      if (normalized === "/dev/null") continue;
      await this.safePath(normalized, true);
    }
    return this.processRunner(["git", "apply", "--whitespace=nowarn", "-"], cwd, timeout(input), undefined, patch);
  }

  private async runRegistered(input: Record<string, unknown>, context: BuiltinToolContext): Promise<CommandResult> {
    const commandId = requiredString(input, "commandId");
    if (!this.options.registeredCommandExecutor) throw new Error("No registered command executor is configured");
    const hookContext: HookContext = {
      projectId: context.projectId ?? optionalString(input, "projectId") ?? "unknown-project",
      runId: context.runId ?? optionalString(input, "runId") ?? context.loopId ?? "unknown-run",
      workspacePath: context.workspacePath,
      branch: context.branch ?? optionalString(input, "branch") ?? "unknown-branch",
      baseCommit: context.baseCommit ?? optionalString(input, "baseCommit") ?? "unknown-base",
      exitReason: context.exitReason ?? optionalString(input, "exitReason") ?? "tool",
    };
    return this.options.registeredCommandExecutor({ commandId, cwd: context.workspacePath, timeoutMs: timeout(input), context: hookContext });
  }

  private async gitCommit(input: Record<string, unknown>, cwd: string): Promise<unknown> {
    const message = requiredString(input, "message").trim();
    if (!message) throw new Error("Commit message must not be empty");
    const paths = input.paths === undefined ? [] : requiredStringArray(input, "paths");
    if (paths.length > 0) {
      const safePaths = [];
      for (const path of paths) safePaths.push((await this.safePath(path, true)).relative);
      const staged = await this.processRunner(["git", "add", "--", ...safePaths], cwd, timeout(input));
      if (staged.exitCode !== 0) return staged;
    }
    return this.processRunner(["git", "commit", "-m", message], cwd, timeout(input));
  }

  private async git(args: string[], cwd: string): Promise<unknown> {
    return this.processRunner(["git", ...args], cwd, DEFAULT_TIMEOUT_MS);
  }

  private async safePath(inputPath: string, allowMissing: boolean): Promise<{ absolute: string; relative: string }> {
    const absolute = resolve(this.workspaceRoot, inputPath);
    if (!this.isInside(absolute)) throw new Error("Path is outside the configured workspace boundary");
    const existing = await realpath(absolute).catch(async () => allowMissing ? this.realPathOfExistingParent(dirname(absolute)) : Promise.reject(new Error("Path " + inputPath + " does not exist")));
    if (!this.isInside(existing)) throw new Error("Path resolves outside the configured workspace boundary");
    if (isProtectedName(relative(this.workspaceRoot, absolute))) throw new Error("Protected secrets and repository internals are not accessible");
    return { absolute, relative: this.toRelative(absolute) };
  }

  private async realPathOfExistingParent(path: string): Promise<string> {
    let current = path;
    while (this.isInside(current)) {
      if (resolve(current) === this.workspaceRoot) return this.workspaceRoot;
      try {
        return await realpath(current);
      } catch {
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    throw new Error("Path resolves outside the configured workspace boundary");
  }

  private toRelative(path: string): string {
    return relative(this.workspaceRoot, path).split(sep).join("/") || ".";
  }

  private isInside(path: string): boolean {
    const target = resolve(path);
    return target === this.workspaceRoot || target.startsWith(this.workspaceRoot + sep);
  }
}

function isProtectedName(path: string): boolean {
  const normalized = path.split(sep).join("/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return normalized === ".git" || normalized.startsWith(".git/") || basename.startsWith(".env");
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error("Tool input " + key + " must be a string");
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] as string : undefined;
}

function requiredStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Tool input " + key + " must be an array of strings");
  return value as string[];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function timeout(input: Record<string, unknown>): number {
  return boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 600_000);
}

function defaultProcessRunner(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}, stdin?: string): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (!settled) reject(error);
    });
    child.once("close", (code) => settle({ exitCode: code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ exitCode: 124, stdout, stderr: stderr + "Command timed out" });
    }, timeoutMs);
  });
}
