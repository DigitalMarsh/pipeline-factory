import type { ModelGateway } from "./index.js";

export type ExplorerTitleSource = "AUTO" | "MANUAL";
export type ExplorerTitleStatus = "PLACEHOLDER" | "GENERATING" | "GENERATED" | "FAILED";

const TITLE_MAX_LENGTH = 24;
const titleGenerationPrompt = `
你是探索线程标题生成器。请根据下面的首条用户需求生成一个简短标题。
只返回标题本身，不要解释，不要引号，不要 Markdown，不要换行，不要前缀。
标题使用首条需求的主要语言，概括核心对象和动作，最多 24 个字符。

首条用户需求：
`;

export type ExplorerTitleGenerator = {
  generate(input: { threadId: string; content: string; signal?: AbortSignal }): Promise<string>;
};

export class ModelExplorerTitleGenerator implements ExplorerTitleGenerator {
  constructor(private readonly model: ModelGateway) {}

  async generate(input: { threadId: string; content: string; signal?: AbortSignal }): Promise<string> {
    let text = "";
    for await (const event of this.model.stream({
      role: "explorer",
      purpose: "title",
      conversationId: `title-${input.threadId}`,
      messages: [{ role: "user", content: `${titleGenerationPrompt}\n<user-request>\n${input.content}\n</user-request>` }],
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (event.type === "text.delta") text += event.text;
      if (event.type === "turn.failed") throw new Error(event.error);
      if (event.type === "turn.cancelled") throw new Error("Explorer title generation cancelled");
    }
    const normalized = normalizeExplorerTitle(text);
    if (!normalized) throw new Error("Explorer title model returned an invalid title");
    return normalized;
  }
}

export function explorerTimestamp(createdAt: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(createdAt));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}${value("month")}${value("day")}-${value("hour")}:${value("minute")}:${value("second")}`;
}

export function placeholderExplorerTitle(createdAt: string): string {
  return `探索-${explorerTimestamp(createdAt)}`;
}

export function composeExplorerTitle(createdAt: string, title: string): string {
  return `${explorerTimestamp(createdAt)}-${title}`;
}

export function normalizeExplorerTitle(value: string): string | null {
  let title = value.trim().replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").split(/\r?\n/, 1)[0]!.trim();
  title = title.replace(/[。.!！?？:：,，;；、…]+$/u, "").trim();
  title = title
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:标题|title)\s*[:：]\s*/i, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/^`(.+)`$/, "$1")
    .replace(/^([*_])(.+)\1$/, "$2")
    .replace(/^(?:["'“‘「『《])(.+?)(?:["'”’」』》])$/, "$1")
    .trim();
  title = title.replace(/[。.!！?？:：,，;；、…]+$/u, "").trim();
  if (!title) return null;
  const characters = Array.from(title.replace(/\s+/g, " ").trim());
  if (characters.length === 0 || characters.length > TITLE_MAX_LENGTH) return null;
  return characters.join("");
}
