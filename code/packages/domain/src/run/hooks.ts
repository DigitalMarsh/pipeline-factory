/**
 * 模块职责：Run 生命周期 Hook —— Project 快照里声明的 Start/Cleanup Hook 如何被归一化成
 *   运行结果，以及失败如何映射成"阻塞 Run"还是"提请关注"。
 *   内容：HookDefinition（快照里的声明）、HookRunResult（归一化结果）、HookExecution
 *   （单次尝试的审计事实）、LifecycleHookRunner（执行器 + 重试）。
 *
 * 为什么从 index.ts 抽出来（批 D：IO 边界）：Hook 是领域层里罕见的"会真的起进程"的路径之一
 *   （execute 走 CommandExecutor），搬出来后它可以和 Scheduler 的 start/finish 对照阅读 ——
 *   Hook 的唯一调用点就在那里。它对本模块之外的依赖只有 platform/commands.ts 的四个类型。
 *
 * 维护提示：
 *   1) **start 与 cleanup 的阻塞语义不对称，这是设计而不是疏漏**：start 失败默认 == blocked
 *      （Run 不能带着坏环境往下走），cleanup 失败 == needsAttention（Run 已经结束，只提醒人）。
 *      见 run() 的 blocksRun 参数与最终返回的 `blocked: failed && blocksRun`。
 *      start 的默认行为可以被 `HookDefinition.blocking: false` 覆盖，cleanup 没有这个开关
 *      （Run 已经结束，没有"往下走"可言）。**判据是"这条命令失败了，Run 的产出还可不可信"**：
 *      装依赖不可以，建索引/预热缓存可以。
 *   2) cwd 由 hook 类型决定，不由调用方传：start 跑在 context.workspacePath（Run 的 Worktree），
 *      cleanup 跑在构造时的 cleanupCwd（默认 process.cwd()）。这是因为 Run 结束、Worktree 可能
 *      已被回收，cleanup 必须在一个确定还存在的地方执行。
 *   3) **executor 抛出的异常会被吞成 exitCode 1 的一次失败尝试**（run() 里的 try/catch），
 *      而不是向上抛。改成向上抛会让"某条命令没注册"这种可重试的情况直接炸掉整个 Run。
 *   4) attempts 记录**每一次**尝试（含失败的），maxAttempts 默认 1 —— 即默认不重试。
 *      同一 Run/Hook 的 attempt 序号不可复用，恢复路径靠它去重。
 *   5) 没有 definition、或 enabled === false，返回的是 status "skipped" 且 blocked/needsAttention
 *      都为 false —— "没配 Hook" 与 "Hook 跑了但失败" 必须是可区分的两种结果。
 */
import type { CommandExecutor, CommandResult, HookContext } from "../platform/commands.js";

/** Project 快照中注册的 Hook 命令及其启用/超时策略。 */
export type HookDefinition = {
  commandId: string;
  enabled?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  /**
   * 失败时是否阻塞 Run。**只对 `start` 槽位有效**，配在 cleanup 上会被 project.ts 拒绝。
   *
   * 缺省 `true` —— 不写这个键的项目与本字段引入前逐字一致：启动钩子失败就是环境没准备好。
   * 配成 `false` 用于**锦上添花的初始化**（建 CodeGraph 索引、预热构建缓存）：这类命令跑失败
   * 不会让 Run 的产出变得不可信，只是慢一点，因此不该拦住 Run。失败照旧进 journal 与
   * HookExecution 审计，只是不再把 Run 钉在 BLOCKED 上。
   */
  blocking?: boolean | undefined;
};

/** Start/Cleanup Hook 的归一化结果及其是否阻塞 Run 的判断。 */
export type HookRunResult = {
  hook: "start" | "cleanup";
  status: "completed" | "failed" | "skipped";
  blocked: boolean;
  needsAttention: boolean;
  result: CommandResult | null;
  attempts: Array<{
    attempt: number;
    commandId: string | null;
    cwd: string;
    timeoutMs: number;
    status: "completed" | "failed" | "skipped";
    result: CommandResult | null;
    startedAt: string;
    completedAt: string;
  }>;
};

/** 一次 Hook 尝试的完整审计事实；同一 Run/Hook 的 attempt 不可复用。 */
export type HookExecution = {
  id: string;
  runId: string;
  hookType: "start" | "cleanup";
  attempt: number;
  commandId: string | null;
  cwd: string;
  timeoutMs: number;
  status: "completed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
};

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

/** 执行 Project 快照中声明的 Start/Cleanup Hook，并把失败映射为运行关注项。 */
export class LifecycleHookRunner {
  private readonly cleanupCwd: string;

  constructor(private readonly executor: CommandExecutor, options: { cleanupCwd?: string } = {}) {
    this.cleanupCwd = options.cleanupCwd ?? process.cwd();
  }

  async runStart(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    // 判据是 `!== false` 而不是 `=== true`：没写这个键 = 老行为（阻塞），见 HookDefinition.blocking。
    return this.run("start", hook, context, hook?.blocking !== false);
  }

  async runCleanup(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    // cleanup 恒为不阻塞，不看 definition.blocking（理由见维护提示 1）。
    return this.run("cleanup", hook, context, false);
  }

  private async run(
    hook: "start" | "cleanup",
    definition: HookDefinition | undefined,
    context: HookContext,
    blocksRun: boolean,
  ): Promise<HookRunResult> {
    const cwd = hook === "start" ? context.workspacePath : this.cleanupCwd;
    const timeoutMs = definition?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    if (!definition || definition.enabled === false) {
      return {
        hook,
        status: "skipped",
        blocked: false,
        needsAttention: false,
        result: null,
        attempts: [{ attempt: 1, commandId: definition?.commandId ?? null, cwd, timeoutMs, status: "skipped", result: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      };
    }
    const attempts: HookRunResult["attempts"] = [];
    const maxAttempts = Math.max(1, definition.maxAttempts ?? 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = new Date().toISOString();
      let result: CommandResult;
      try {
        result = await this.executor({ commandId: definition.commandId, cwd, timeoutMs, context });
      } catch (error) {
        result = { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      const completedAt = new Date().toISOString();
      const status = result.exitCode === 0 ? "completed" : "failed";
      attempts.push({ attempt, commandId: definition.commandId, cwd, timeoutMs, status, result, startedAt, completedAt });
      if (status === "completed") break;
    }
    const finalAttempt = attempts.at(-1)!;
    const failed = finalAttempt.status === "failed";
    return {
      hook,
      status: failed ? "failed" : "completed",
      blocked: failed && blocksRun,
      needsAttention: failed && !blocksRun,
      result: finalAttempt.result,
      attempts,
    };
  }
}
