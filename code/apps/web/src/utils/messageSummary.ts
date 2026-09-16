/**
 * 模块职责：把用户消息拆成折叠卡片所需的标题和摘要。
 *
 * 标题与摘要只用于展示，原始消息仍由调用方保留并在展开时完整渲染。
 */
export type UserMessageSummary = {
  title: string;
  preview: string;
};

export function summarizeUserMessage(source: string): UserMessageSummary {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    title: lines[0] ?? "用户消息",
    preview: lines.slice(1).join(" ").replace(/\s+/g, " ").trim(),
  };
}
