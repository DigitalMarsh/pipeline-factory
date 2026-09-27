/**
 * 模块职责：把 `config.project.commands` 适配成 `RegisteredCommandExecutor` 能吃的命令定义。
 *   被 `runtime/scheduler.ts` 与 `runtime/verification.ts` 共用，所以单独成文件而不是塞进任一方。
 *
 * 维护提示：
 *   1) `argv.length === 0` 的命令会被**静默丢弃**（flatMap 返回空数组）。这是"配置里留一行占位"与
 *      "命令定义非法"的分界：**不要改成抛错**——一个空 argv 会让整个 API 起不来，而它在开发期配置里
 *      是很常见的残留。真要报错，应该报在 config 校验里。
 *   2) `category` 硬编码为 `"verification"`，config 里没有对应字段——凡是写进
 *      `project.commands` 的命令都被登记为验证类。
 *   3) `argv[0]!` 的非空断言由第 1 条的过滤保证（`length > 0` 时才构造）。
 */
import type { FactoryConfig } from "../config.js";

export function readCommandDefinitions(config: FactoryConfig): Array<{ commandId: string; category: "verification"; enabled: true; argv: readonly [string, ...string[]]; environment?: Readonly<Record<string, string>> | undefined }> {
  return config.project.commands.flatMap((command) => command.argv.length > 0 ? [{ commandId: command.commandId, category: "verification" as const, enabled: true as const, argv: [command.argv[0]!, ...command.argv.slice(1)] as readonly [string, ...string[]], environment: command.environment }] : []);
}
