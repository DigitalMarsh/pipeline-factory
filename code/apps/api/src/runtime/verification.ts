/**
 * 模块职责：构造**默认**验证命令执行器 —— 供 Run 的 `/verify` 使用（没有注入
 *   `options.verificationExecutor` 时才生效）。
 *
 * 维护提示：
 *   1) **快照优先**：Revision 有 `projectConfigSnapshot` 时用快照里的命令与
 *      `concurrency.defaultTimeoutMs`；没有快照（旧 Revision）才退回全局限定的 `120_000`。
 *      注意那个 `120_000` 是**硬编码**的，不是从 config 读的——改 config 不会影响这条回退路径。
 *   2) `run.workspacePath` 为空时返回 `{ exitCode: 1 }` 而**不是抛错**：验证不通过必须是"测试失败"
 *      的语义（调用方按 exitCode 走），抛出去会变成 500，把可恢复的失败变成接口错误。
 *   3) 每次调用都重新读 `store.getRevision(...)`，不缓存——Revision 可能在上一次调用后被换掉。
 */
import { RegisteredCommandExecutor } from "@pipeline-factory/domain";
import type { PipelineStore, VerificationCommandExecutor } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";
import { readCommandDefinitions } from "./commands.js";

/** 构造验证命令执行器；存在快照时优先使用快照命令和超时，旧 Revision 才使用全局兼容配置。 */
export function createDefaultVerificationExecutor(store: PipelineStore, config: FactoryConfig): VerificationCommandExecutor {
  const commands = new RegisteredCommandExecutor(readCommandDefinitions(config));
  return (commandId, run) => {
    if (!run.workspacePath) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Run workspace is not available" });
    const revision = store.getRevision(run.planId, run.planRevision);
    const snapshot = revision?.projectConfigSnapshot;
    const snapshotCommands = snapshot ? new RegisteredCommandExecutor(snapshot.settings.commands) : commands;
    return snapshotCommands.execute({ commandId, cwd: run.workspacePath, timeoutMs: snapshot?.settings.concurrency.defaultTimeoutMs ?? 120_000, context: { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit, exitReason: "verification" } });
  };
}
