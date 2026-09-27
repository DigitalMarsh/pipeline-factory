/**
 * 模块职责：工具调用的统一入口——把 Builtin / MCP / Plugin / Computer Use 四类工具收敛到一次调用，
 *   并在调用前执行角色白名单、工作区边界与受保护路径检查。
 *
 * 为什么从 index.ts 抽出来：tool-runtime.ts（DurableToolRuntime）从 index.ts 取值导入 ToolGateway，
 *   这是 index.ts 与兄弟模块之间**最后一条**回流边。本模块的运行时依赖只有 node:path 与
 *   builtin-tool-executor.js（后者早已是独立模块），搬出后该边被切断，整个值级强连通分量解散。
 *
 * 维护提示（安全相关，改动前务必读完）：
 *   1) 这是**唯一的授权判定点**。新增工具时必须同时决定：它属于 READ_ONLY_TOOLS 还是 EXECUTOR_TOOLS，
 *      以及它是否读路径（要过 isInsideWorkspace/isProtectedPath）还是读 commandId（要过 registeredCommandIds）。
 *      漏掉任何一项，新工具就是无条件放行的。
 *   2) PROTECTED_PATHS 同时按**全路径**与**文件名**匹配：`.git`、`.env*` 是按前缀判的，
 *      而 package.json/锁文件/tsconfig.json 无论出现在哪一层目录都被拦截。放开这条会把
 *      "改依赖清单绕过审批"变成一条可走的路径。
 *   3) isInsideWorkspace 用 resolve 后的字符串前缀比较，不是 realpath。符号链接可以逃逸出工作区——
 *      这是已知限制，不要以为这里的检查能替代容器/沙箱隔离。
 *   4) call() 有重放保护：同一个 callId 第二次进来直接返回上一次的结果，不会重复执行副作用。
 *      去掉它会让恢复流程里的重试变成真的重复写文件。
 *   5) 错误分类决定了失败是"结果"还是"异常"：匹配 isToolExecutionFailure 的（文件不存在、spawn 失败）
 *      作为工具结果返回让模型自行修正；匹配边界/受保护路径的转成 DENIED；其余原样抛出。
 *      在 catch 里缩小异常范围会把真正的实现 bug 静默成模型可见的工具错误。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BuiltinToolExecutor } from "./builtin-tool-executor.js";
import type { BuiltinToolContext, BuiltinToolExecutorOptions } from "./builtin-tool-executor.js";
import type { ToolCall, ToolCallResult, ToolName, ToolRole } from "../index.js";

/** ToolGateway 的角色白名单、工作区边界和外部工具桥接配置。 */
export type ToolGatewayOptions = {
  role: ToolRole;
  workspaceRoot: string;
  registeredCommandIds?: ReadonlySet<string>;
  mcpAllowedTools?: ReadonlySet<string>;
  pluginAllowedTools?: ReadonlySet<string>;
  computerUseAllowed?: boolean;
  builtin?: Omit<BuiltinToolExecutorOptions, "workspaceRoot">;
  handler?: (call: ToolCall, context?: BuiltinToolContext) => Promise<unknown>;
};

const READ_ONLY_TOOLS = new Set<ToolName>(["read_file", "list_files", "git_status", "git_diff", "git_log", "search_text"]);
const EXECUTOR_TOOLS = new Set<ToolName>([...READ_ONLY_TOOLS, "write_file", "apply_patch", "run_registered_command", "run_verification", "git_commit"]);
const PROTECTED_PATHS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "tsconfig.json"]);

/** 汇总 Builtin、MCP、Plugin 和 Computer Use 工具，并执行统一白名单检查。 */
export class ToolGateway {
  private readonly calls = new Map<string, ToolCallResult>();
  private readonly workspaceRoot: string;
  private readonly registeredCommandIds: ReadonlySet<string>;
  private readonly mcpAllowedTools: ReadonlySet<string>;
  private readonly pluginAllowedTools: ReadonlySet<string>;
  private readonly builtin: BuiltinToolExecutor;

  constructor(private readonly options: ToolGatewayOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.registeredCommandIds = options.registeredCommandIds ?? new Set();
    this.mcpAllowedTools = options.mcpAllowedTools ?? new Set();
    this.pluginAllowedTools = options.pluginAllowedTools ?? new Set();
    this.builtin = new BuiltinToolExecutor({ workspaceRoot: this.workspaceRoot, ...(options.builtin ?? {}) });
  }

  async call(call: ToolCall, context?: BuiltinToolContext): Promise<ToolCallResult> {
    const previous = this.calls.get(call.callId);
    if (previous) return previous;
    const denied = this.validate(call);
    if (denied) {
      const result = this.save({ callId: call.callId, allowed: false, status: "DENIED", reason: denied, result: null, audited: true });
      return result;
    }
    try {
      const value = this.options.handler ? await this.options.handler(call, context) : await this.builtin.execute(call, { workspacePath: context?.workspacePath ?? this.workspaceRoot, ...(context ?? {}) });
      return this.save({ callId: call.callId, allowed: true, reason: null, result: value, audited: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isToolExecutionFailure(reason)) return this.save({ callId: call.callId, allowed: true, reason: null, result: { error: reason }, audited: true });
      if (/outside the configured workspace boundary|Protected secrets|repository internals/i.test(reason)) return this.save({ callId: call.callId, allowed: false, status: "DENIED", reason, result: null, audited: true });
      throw error;
    }
  }

  private validate(call: ToolCall): string | null {
    if (call.tool.startsWith("mcp:")) {
      if (!this.mcpAllowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer MCP tool is not explicitly allowed" : "MCP tool is not allowed by Executor policy";
      if (!this.options.builtin?.mcpToolExecutor && !this.options.handler) return "MCP tool executor is not configured";
      return null;
    }
    if (call.tool.startsWith("plugin:")) {
      if (!this.pluginAllowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer plugin tool is not explicitly allowed" : "Plugin tool is not allowed by Executor policy";
      if (!this.options.builtin?.pluginToolExecutor && !this.options.handler) return "Plugin tool executor is not configured";
      return null;
    }
    if (call.tool === "computer_use") {
      if (this.options.computerUseAllowed !== true) return "Computer Use is denied by host policy";
      if (!this.options.builtin?.computerUseExecutor && !this.options.handler) return "Computer Use host adapter is not configured";
      return null;
    }
    const allowedTools = this.options.role === "explorer" ? READ_ONLY_TOOLS : EXECUTOR_TOOLS;
    if (!allowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer is read-only; this tool is disabled" : "Tool is not allowed by Executor policy";
    if (["read_file", "write_file", "apply_patch"].includes(call.tool)) {
      const path = call.input.path;
      if (call.tool !== "apply_patch" && (typeof path !== "string" || !this.isInsideWorkspace(path))) return "Path is outside the workspace boundary";
      if (typeof path === "string" && this.isProtectedPath(path)) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (["list_files", "search_text", "git_diff"].includes(call.tool)) {
      const path = call.input.path;
      if (path !== undefined && (typeof path !== "string" || !this.isInsideWorkspace(path))) return "Path is outside the workspace boundary";
      if (typeof path === "string" && this.isProtectedPath(path)) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (call.tool === "git_commit" && call.input.paths !== undefined) {
      const paths = call.input.paths;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !this.isInsideWorkspace(path))) return "Commit paths must stay inside the workspace boundary";
      if (paths.some((path) => this.isProtectedPath(path as string))) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (["run_registered_command", "run_verification"].includes(call.tool)) {
      const commandId = call.input.commandId;
      if (typeof commandId !== "string" || !this.registeredCommandIds.has(commandId)) return "Command is not registered for this project";
    }
    return null;
  }

  private isInsideWorkspace(path: string): boolean {
    const target = resolve(this.workspaceRoot, path);
    return target === this.workspaceRoot || target.startsWith(`${this.workspaceRoot}${sep}`) && (!isAbsolute(path) || target.startsWith(`${this.workspaceRoot}${sep}`));
  }

  private isProtectedPath(path: string): boolean {
    const normalized = relative(this.workspaceRoot, resolve(this.workspaceRoot, path)).split(sep).join("/");
    const basename = normalized.split("/").at(-1) ?? normalized;
    return normalized === ".git" || normalized.startsWith(".git/") || normalized.startsWith(".env") || PROTECTED_PATHS.has(normalized) || PROTECTED_PATHS.has(basename);
  }

  private save(result: ToolCallResult): ToolCallResult { this.calls.set(result.callId, result); return result; }
}

function isToolExecutionFailure(reason: string): boolean {
  return /does not exist|not a file|not a directory|No registered command executor|spawn/i.test(reason);
}
