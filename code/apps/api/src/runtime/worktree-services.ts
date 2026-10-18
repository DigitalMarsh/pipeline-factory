/**
 * 模块职责：**项目 Worktree 内的服务启停** —— 读取 worktree 根目录下的服务配置，按需启动 / 停止
 *   子进程，保留最近若干行日志，并在进程退出时更新状态。
 *
 * 边界（为什么在 apps/api 的 runtime 而不是 domain）：
 *   domain 里能跑进程的只有 `platform/commands.ts` 的短命令执行器（跑完即返回）。这里管理的是
 *   **长驻进程**：PID、进程组、日志环形缓冲、退出码、应用关闭时的统一回收。这些是宿主进程的
 *   职责，和 `runtime/model-gateway.ts` 一样属于"组合根可以换掉的实现"。
 *
 * 维护提示：
 *   1) **只停我们自己启动的进程**，绝不按端口或名字去杀。`pid` 记录在内存里，重启服务后旧进程
 *      不在管理范围内——这是有意的：误杀用户终端里起的 Java 比"停不掉"糟糕得多。
 *   2) **配置只从 worktree 内部读**（`.pipeline-factory/services.json`，兼容
 *      `.worktree-manage/services.json`），`workdir` 解析后必须仍在该 worktree 内。配置文件是
 *      用户自己写的，但仍不该成为"从任意目录启动任意命令"的入口。
 *   3) 原生格式只接受 `argv`（不经 shell）；兼容格式的 `start_command` 走 `sh -lc`——那是
 *      worktree-manage 既有文件的语义。**两条路径都要过同一道"目录必须在 worktree 内"的检查。**
 *   4) 日志按行切分并按条数封顶（默认 500 行）：不封顶的长驻服务会把内存吃光，而界面也只需要尾部。
 *   5) 停止用"先 SIGTERM 整个进程组、3 秒后 SIGKILL"：`start_command` 常常是
 *      `mvn spring-boot:run` 这类会再 fork 的壳，只杀父进程会留下孤儿。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import type { WorktreeServiceConfig, WorktreeServiceLogEntry, WorktreeServiceState, WorktreeServices } from "@pipeline-factory/domain";

/** 单个服务保留的日志行数上限。 */
const DEFAULT_MAX_LOG_LINES = 500;
/** SIGTERM 之后等这么久再 SIGKILL。 */
const KILL_GRACE_MS = 3_000;

type ManagedProcess = {
  key: string;
  child: ChildProcess;
  pid: number | null;
  config: WorktreeServiceConfig;
  state: WorktreeServiceState;
  logs: WorktreeServiceLogEntry[];
  sequence: number;
  pending: { stdout: string; stderr: string };
  exitTimer: NodeJS.Timeout | null;
  /** 用户点了停止：退出是由我们发起的，不该在状态里显示成"被信号结束"的异常。 */
  intentionalStop: boolean;
};

export type WorktreeServiceRunnerOptions = { maxLogLines?: number | undefined };

/** 一个 worktree 的服务配置文件位置。 */
export type WorktreeServiceConfigSource = { path: string; format: "pipeline-factory" | "worktree-manage" } | null;

/** 从 `<worktree>/.pipeline-factory/services.json` 开始找，找不到再看兼容的 `.worktree-manage`。 */
export function locateServiceConfig(worktreePath: string): WorktreeServiceConfigSource {
  const native = resolvePath(worktreePath, ".pipeline-factory", "services.json");
  if (existsSync(native)) return { path: native, format: "pipeline-factory" };
  const legacy = resolvePath(worktreePath, ".worktree-manage", "services.json");
  if (existsSync(legacy)) return { path: legacy, format: "worktree-manage" };
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 解析服务配置。两种形状都接受，但**失败一律抛错**（由调用方转成 `configError` 显示给用户）：
 * 静默跳过坏配置会让人以为"这个 worktree 没配服务"。
 */
export function parseServiceConfig(input: unknown, format: "pipeline-factory" | "worktree-manage"): WorktreeServiceConfig[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { services?: unknown }).services)) {
    throw new Error("services.json 必须是 { services: [...] }");
  }
  const seen = new Set<string>();
  return (input as { services: unknown[] }).services.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 个服务不是对象`);
    const record = raw as Record<string, unknown>;
    const serviceId = readString(record.serviceId) ?? readString(record.service_id);
    if (!serviceId) throw new Error(`第 ${index + 1} 个服务缺少 serviceId`);
    if (seen.has(serviceId)) throw new Error(`serviceId 重复：${serviceId}`);
    seen.add(serviceId);
    const argvRaw = record.argv;
    const argv =
      Array.isArray(argvRaw) && argvRaw.length > 0
        ? argvRaw.map((part) => {
            if (typeof part !== "string" || !part.trim()) throw new Error(`服务 ${serviceId} 的 argv 必须是非空字符串数组`);
            return part;
          })
        : null;
    const shellCommand = readString(record.start_command) ?? readString(record.command);
    if (!argv && !shellCommand) throw new Error(`服务 ${serviceId} 需要 argv（原生格式）或 start_command（兼容格式）`);
    const repoPath = readString(record.repo_path);
    const workdir = [repoPath && repoPath !== "." ? repoPath : "", readString(record.workdir) ?? ""].filter(Boolean).join("/") || ".";
    return {
      serviceId,
      name: readString(record.name) ?? serviceId,
      role: readString(record.role) ?? "worker",
      workdir,
      argv,
      shellCommand: argv ? null : shellCommand,
      healthUrl: readString(record.health_url) ?? readString(record.healthUrl),
      enabled: record.enabled === undefined ? true : record.enabled === true,
      source: format,
    } satisfies WorktreeServiceConfig;
  });
}

/** `child` 解析后的路径是否仍在 `root` 之内（含 root 自己）。 */
function isInside(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(rootWithSep);
}

/** 每个 worktree 一组服务进程；键是 `projectId:itemId:serviceId`。 */
export class WorktreeServiceRunner {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly maxLogLines: number;

  constructor(options: WorktreeServiceRunnerOptions = {}) {
    this.maxLogLines = Math.max(50, options.maxLogLines ?? DEFAULT_MAX_LOG_LINES);
  }

  /** 读取一个 worktree 的服务配置并拼上当前运行状态。配置错误进 `configError`，不抛。 */
  inspect(projectId: string, itemId: string, worktreePath: string): WorktreeServices {
    const source = locateServiceConfig(worktreePath);
    if (!source) {
      return { itemId, worktreePath, configPath: null, configError: null, services: [], states: this.states(projectId, itemId) };
    }
    try {
      const parsed = JSON.parse(readFileSync(source.path, "utf8")) as unknown;
      const services = parseServiceConfig(parsed, source.format);
      return {
        itemId,
        worktreePath,
        configPath: source.path,
        configError: null,
        services,
        states: this.states(projectId, itemId),
      };
    } catch (error) {
      return {
        itemId,
        worktreePath,
        configPath: source.path,
        configError: error instanceof Error ? error.message : String(error),
        services: [],
        states: this.states(projectId, itemId),
      };
    }
  }

  /** 启动一个服务。同一 serviceId 已在跑时直接返回现状（幂等）。 */
  start(projectId: string, itemId: string, worktreePath: string, config: WorktreeServiceConfig): WorktreeServiceState {
    const key = this.key(projectId, itemId, config.serviceId);
    const existing = this.processes.get(key);
    if (existing && existing.state.status === "running") return existing.state;
    if (!config.enabled) throw new Error(`服务 ${config.name} 在配置里被禁用（enabled: false）。`);

    const root = resolvePath(worktreePath);
    const cwd = resolvePath(root, config.workdir);
    if (!isInside(root, cwd)) throw new Error(`服务 ${config.name} 的工作目录不在 worktree 内：${cwd}`);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`服务 ${config.name} 的工作目录不存在：${cwd}`);

    const [command, args] = config.argv ? [config.argv[0] ?? "", config.argv.slice(1)] : ["/bin/sh", ["-lc", config.shellCommand ?? ""]];
    if (!command) throw new Error(`服务 ${config.name} 缺少启动命令。`);

    const child = spawn(command, args, {
      cwd,
      // 继承宿主环境：服务通常需要 PATH / JAVA_HOME 之类（worktree-manage 的 `sh -lc` 同样继承）。
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state: WorktreeServiceState = {
      serviceId: config.serviceId,
      status: "running",
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      exitCode: null,
      error: null,
    };
    const managed: ManagedProcess = {
      key,
      child,
      pid: child.pid ?? null,
      config,
      state,
      logs: [],
      sequence: 0,
      pending: { stdout: "", stderr: "" },
      exitTimer: null,
      intentionalStop: false,
    };
    this.processes.set(key, managed);
    this.capture(managed, "stdout", child.stdout);
    this.capture(managed, "stderr", child.stderr);
    child.on("error", (error) => {
      managed.state = { ...managed.state, status: "failed", error: error.message, pid: null };
      this.pushLine(managed, "stderr", `启动失败：${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.flush(managed);
      const intentional = managed.intentionalStop;
      managed.state = {
        ...managed.state,
        status: intentional ? "stopped" : code === 0 || code === null ? "stopped" : "failed",
        exitCode: code,
        pid: null,
        error: intentional ? null : signal ? `进程被信号 ${signal} 结束` : code && code !== 0 ? `退出码 ${code}` : null,
      };
      this.pushLine(managed, "stdout", signal ? `进程结束（信号 ${signal}）` : `进程结束（退出码 ${code ?? "unknown"}）`);
      if (managed.exitTimer) {
        clearTimeout(managed.exitTimer);
        managed.exitTimer = null;
      }
    });
    this.pushLine(managed, "stdout", `启动：${[command, ...args].join(" ")}（cwd=${cwd}）`);
    return state;
  }

  /** 停止一个服务：先 SIGTERM 整个进程组，3 秒后 SIGKILL。只处理本实例启动的进程。 */
  async stop(projectId: string, itemId: string, serviceId: string): Promise<WorktreeServiceState> {
    const key = this.key(projectId, itemId, serviceId);
    const managed = this.processes.get(key);
    if (!managed || managed.state.status !== "running") {
      return managed?.state ?? { serviceId, status: "stopped", pid: null, startedAt: null, exitCode: null, error: null };
    }
    await this.terminate(managed);
    managed.state = { ...managed.state, status: "stopped", pid: null };
    this.pushLine(managed, "stdout", "已停止（本应用发起的停止）。");
    return managed.state;
  }

  /** 某个 item 下全部服务的状态。 */
  states(projectId: string, itemId: string): WorktreeServiceState[] {
    return [...this.processes.values()]
      .filter((managed) => managed.key.startsWith(`${projectId}:${itemId}:`))
      .map((managed) => managed.state);
  }

  /** 某个服务最近的日志（按序号升序）。 */
  logs(projectId: string, itemId: string, serviceId: string): WorktreeServiceLogEntry[] {
    return this.processes.get(this.key(projectId, itemId, serviceId))?.logs ?? [];
  }

  /** 应用关闭时统一回收；返回被停掉的数量。 */
  async stopAll(): Promise<number> {
    const running = [...this.processes.values()].filter((managed) => managed.state.status === "running");
    await Promise.all(running.map((managed) => this.terminate(managed)));
    return running.length;
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private key(projectId: string, itemId: string, serviceId: string): string {
    return `${projectId}:${itemId}:${serviceId}`;
  }

  private capture(managed: ManagedProcess, stream: "stdout" | "stderr", readable: NodeJS.ReadableStream | null): void {
    readable?.setEncoding("utf8");
    readable?.on("data", (chunk: string) => this.pushChunk(managed, stream, chunk));
  }

  /** 按行切分；不完整的尾行留在 `pending` 里等下一块。 */
  private pushChunk(managed: ManagedProcess, stream: "stdout" | "stderr", chunk: string): void {
    const combined = managed.pending[stream] + chunk;
    const lines = combined.split("\n");
    managed.pending[stream] = lines.pop() ?? "";
    for (const line of lines) this.pushLine(managed, stream, line);
  }

  private flush(managed: ManagedProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = managed.pending[stream];
      managed.pending[stream] = "";
      if (rest) this.pushLine(managed, stream, rest);
    }
  }

  private pushLine(managed: ManagedProcess, stream: "stdout" | "stderr", text: string): void {
    managed.sequence += 1;
    managed.logs.push({ sequence: managed.sequence, stream, text });
    if (managed.logs.length > this.maxLogLines) managed.logs.splice(0, managed.logs.length - this.maxLogLines);
  }

  private async terminate(managed: ManagedProcess): Promise<void> {
    const pid = managed.pid;
    if (!pid) return;
    managed.intentionalStop = true;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        // detached: true 让子进程成为独立进程组的组长，于是 -pid 就是"整组"。
        process.kill(-pid, signal);
      } catch {
        try {
          managed.child.kill(signal);
        } catch {
          /* 已经退出 */
        }
      }
    };
    signalGroup("SIGTERM");
    await new Promise<void>((resolveDone) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveDone();
      };
      managed.exitTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        finish();
      }, KILL_GRACE_MS);
      managed.child.once("exit", finish);
    });
    if (managed.exitTimer) {
      clearTimeout(managed.exitTimer);
      managed.exitTimer = null;
    }
    managed.pid = null;
    managed.state = { ...managed.state, pid: null };
  }
}

/** 进程是否还在（给测试与"重启后状态修正"用）。 */
export function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
