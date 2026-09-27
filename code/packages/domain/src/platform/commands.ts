/**
 * 模块职责：Registered Command 的类型端口与本地实现 —— 领域层唯一"如何起一个进程"的地方。
 *   内容包括：命令调用/结果的形状（CommandInvocation / CommandResult / CommandExecutor）、
 *   Project 快照里注册的命令定义（RegisteredCommandDefinition）、只执行已注册 argv 的
 *   RegisteredCommandExecutor，以及它的默认实现 defaultProcessRunner。
 *
 * 为什么从 index.ts 抽出来（批 D：IO 边界）：领域层的其余部分都是纯逻辑，只有这里真的去
 *   fork 一个进程。它原先混在 index.ts 里，导致任何想替换进程执行的测试都只能从 barrel 绕。
 *   抽出来之后它是一个**零领域依赖的叶子**（只 import node:child_process），可以单独阅读、
 *   单独注入。
 *
 * 维护提示：
 *   1) **模型永远不能提供 argv 字符串**。RegisteredCommandExecutor 只按 commandId 在构造时
 *      建立的 Map 里查表；这条不变量是"Executor 不能拿模型输出拼 Shell"的唯一保证，任何
 *      "顺手支持一下自定义命令"的改动都会拆掉它。未注册返回 127、被禁用返回 126，
 *      与 shell 的退出码语义对齐（127 = command not found，126 = found but not executable）。
 *   2) 环境变量分两层：definition.environment 是 Project 声明的，PIPELINE_* 是运行时注入的。
 *      注入顺序见 Object.assign —— **PIPELINE_* 会覆盖同名 Project 变量**，这是有意的：
 *      Run 身份不可被配置伪造。PATH/Path 单独兜底，因为它是进程解析的基础设施而不是项目数据，
 *      Project 留空时不能把 PATH 清掉。
 *   3) defaultProcessRunner 用 detached: true 起进程，超时后对**进程组**发 SIGTERM
 *      （-child.pid），1 秒后 SIGKILL。改成只 kill 子进程会留下项目命令自己 fork 出的孤儿进程；
 *      超时退出码用 124，与 GNU timeout 一致。exitCode === null 表示进程被信号打断，
 *      调用方不能把它当成 0。
 *   4) HookContext 定义在这里而不是 run/hooks.ts：它虽然叫 Hook，实际是"一次命令执行的 Run
 *      身份"，CommandInvocation.context 与 builtin-tool-executor 调 registeredCommandExecutor
 *      时构造的都是它。放在这里可以让本模块保持零领域依赖，避免与 run/hooks.ts 形成类型环。
 *      名字是历史遗留，不要按字面理解成"只给 Hook 用"。
 *   5) tools/builtin-tool-executor.ts 里有一个**同名但语义不同**的 defaultProcessRunner：
 *      它多一个 stdin 参数、把 env 合并进 process.env、且子进程 error 时 reject 而不是 resolve。
 *      两者不是重复实现，不要"顺手合并"。
 */
import { spawn } from "node:child_process";

/** Hook 执行上下文；路径固定指向当前 Run 的 Worktree。 */
export type HookContext = {
  projectId: string;
  runId: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  exitReason: string;
};

/** 已注册命令的一次确定性调用，不携带任意 shell 字符串。 */
export type CommandInvocation = {
  commandId: string;
  cwd: string;
  timeoutMs: number;
  context: HookContext;
};

/** 进程执行结果；exitCode 为 null 表示进程被信号或运行时中断。 */
export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** Hook/验证共用的命令执行端口。 */
export type CommandExecutor = (command: CommandInvocation) => Promise<CommandResult>;

/** Commands are policy objects, not model input. Unclassified legacy commands are disabled by migration. */
export type RegisteredCommandDefinition = {
  commandId: string;
  category?: "verification" | "lifecycle" | "executor-tool" | "unclassified";
  description?: string;
  enabled?: boolean;
  argv: readonly [string, ...string[]];
  environment?: Readonly<Record<string, string>> | undefined;
  timeoutMs?: number;
};
export type ProcessRunner = (argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>) => Promise<CommandResult>;

/** 只执行已注册的 argv 命令，禁止模型通过字符串拼接调用任意 Shell。 */
export class RegisteredCommandExecutor {
  private readonly commands = new Map<string, RegisteredCommandDefinition>();
  private readonly runProcess: ProcessRunner;

  constructor(commands: RegisteredCommandDefinition[], runProcess: ProcessRunner = defaultProcessRunner) {
    for (const command of commands) this.commands.set(command.commandId, command);
    this.runProcess = runProcess;
  }

  execute(command: CommandInvocation): Promise<CommandResult> {
    const definition = this.commands.get(command.commandId);
    if (!definition) return Promise.resolve({ exitCode: 127, stdout: "", stderr: `Command ${command.commandId} is not registered` });
    if (definition.enabled === false) return Promise.resolve({ exitCode: 126, stdout: "", stderr: `Command ${command.commandId} is disabled` });
    const env: Record<string, string> = { ...(definition.environment ?? {}) };
    // PATH is process resolution infrastructure, not project data; preserve it
    // when a Project command leaves the optional environment block empty.
    if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
    if (!env.Path && process.env.Path) env.Path = process.env.Path;
    Object.assign(env, {
      PIPELINE_PROJECT_ID: command.context.projectId,
      PIPELINE_RUN_ID: command.context.runId,
      PIPELINE_WORKSPACE_PATH: command.context.workspacePath,
      PIPELINE_BRANCH: command.context.branch,
      PIPELINE_BASE_COMMIT: command.context.baseCommit,
      PIPELINE_EXIT_REASON: command.context.exitReason,
    });
    return this.runProcess([...definition.argv], command.cwd, definition.timeoutMs ?? command.timeoutMs, env);
  }

  invoke(command: CommandInvocation): Promise<CommandResult> { return this.execute(command); }
}

function defaultProcessRunner(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(result); } };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => settle({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => settle({ exitCode: code, stdout, stderr }));
    const timer = setTimeout(() => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        setTimeout(() => { if (!settled) { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } } }, 1000);
      }
      settle({ exitCode: 124, stdout, stderr: `${stderr}Command timed out` });
    }, timeoutMs);
  });
}
