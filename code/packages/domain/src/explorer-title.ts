/**
 * 模块职责：负责 ExplorerThread 标题的生成、规范化和降级显示。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ModelGateway } from "./index.js";

/** Explorer 标题来源；手工标题不会被模型自动覆盖。 */
export type ExplorerTitleSource = "AUTO" | "MANUAL";
/** Explorer 标题生成生命周期，用于显示降级和重试状态。 */
export type ExplorerTitleStatus = "PLACEHOLDER" | "GENERATING" | "GENERATED" | "FAILED";

const TITLE_MAX_LENGTH = 24;
const titleGenerationPrompt = `
你是探索线程标题生成器。请根据下面的首条用户需求生成一个简短标题。
只返回标题本身，不要解释，不要引号，不要 Markdown，不要换行，不要前缀。
标题使用首条需求的主要语言，概括核心对象和动作，最多 24 个字符。

首条用户需求：
`;

/** 标题生成端口；Provider 失败不影响 Explorer 主流程。 */
export type ExplorerTitleGenerator = {
  generate(input: { threadId: string; content: string; signal?: AbortSignal }): Promise<string>;
};

/** 使用 Explorer 角色生成短标题；Provider 失败时由调用方保留 placeholder/FAILED 状态。 */
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

/** 从创建时间生成稳定的默认标题时间片段。 */
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

/** 生成尚未完成自动命名时使用的占位标题。 */
export function placeholderExplorerTitle(createdAt: string, projectShortName = "探索"): string {
  return `${projectShortName.trim() || "探索"}-${explorerTimestamp(createdAt)}`;
}

/** 组合时间片段和模型标题，保证导航栏始终有可读名称。 */
export function composeExplorerTitle(createdAt: string, title: string): string {
  return `${explorerTimestamp(createdAt)}-${title}`;
}

/** 清理 Markdown、前缀和尾部标点，并限制标题长度以保证导航栏可读。 */
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
