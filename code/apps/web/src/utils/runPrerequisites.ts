/** 从 Run 启动错误中提取可由 Project Settings 修复的命令前置条件。 */
export function parseMissingRunCommands(message: string): string[] {
  const match = message.match(/(?:RUN_PREREQUISITES_UNSATISFIED:\s*)?missing registered commands:\s*(.+)$/i);
  if (!match?.[1]) return [];
  return match[1].split(",").map((commandId) => commandId.trim()).filter(Boolean);
}
