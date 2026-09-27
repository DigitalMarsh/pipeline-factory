import type { PlanDispatchState } from "../types";

/** 判断"这条 Plan 因缺配置卡住"只需要派发状态里的两个字段，故不要求调用方手里有整张 Plan。 */
type DispatchWaitState = Pick<PlanDispatchState, "waitReason" | "lastError">;
type PlanWithDispatch = { dispatch?: DispatchWaitState | null };

/** 从 Run 启动错误中提取可由 Project Settings 修复的命令前置条件。 */
export function parseMissingRunCommands(message: string): string[] {
  const match = message.match(/(?:RUN_PREREQUISITES_UNSATISFIED:\s*)?missing registered commands:\s*(.+)$/i);
  if (!match?.[1]) return [];
  return match[1].split(",").map((commandId) => commandId.trim()).filter(Boolean);
}

/**
 * 这条 Plan 因缺配置而卡住时，缺的是哪些命令。
 * 只有 `dispatch.waitReason === "NEEDS_CONFIGURATION"` 才算——否则 `lastError` 里可能
 * 恰好也有 "missing registered commands" 字样，但那不是配置问题。
 */
export function configurationBlockedCommands(plan: PlanWithDispatch): string[] {
  if (plan.dispatch?.waitReason !== "NEEDS_CONFIGURATION") return [];
  return parseMissingRunCommands(plan.dispatch.lastError ?? "");
}

/**
 * 缺的命令**都在当前 Project 里注册过**，才能一键基于当前配置重建 Revision。
 * 少注册一条就返回 false —— 否则会造出一个同样跑不起来的新 Revision，
 * 用户看到的是"重建了但还是失败"，比不给入口更糟。
 */
export function canCreateConfigurationRevision(plan: PlanWithDispatch, project: { settings: { commands: Array<{ commandId: string }> } } | null): boolean {
  const missingCommands = configurationBlockedCommands(plan);
  if (!missingCommands.length || !project) return false;
  const registered = new Set(project.settings.commands.map((command) => command.commandId));
  return missingCommands.every((commandId) => registered.has(commandId));
}
