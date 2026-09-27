/**
 * 模块职责：OpenAI Responses API 的 ModelGateway 适配器 —— 把 ModelRequest 变成一次
 *   HTTP 调用，再把响应映射成 ModelEvent 流。含它的配置类型、可注入的 HTTP 端口
 *   （ModelFetch / ModelFetchResponse）与响应正文的兜底解析 extractResponseText。
 *
 * 为什么从 index.ts 抽出来（批 D：IO 边界）：这是领域层唯一直接发出**网络**请求的地方。
 *   搬迁前它夹在 ModelGateway 接口与 ToolCallLedger 之间，与它同处一个文件的是 Plan、Run、
 *   Store 等一堆毫不相干的东西。搬进 model/ 之后它与 codex-app-server.ts 并排 ——
 *   后者是另一个 ModelGateway 实现，两者共用同一个接口契约，可以直接对照。
 *
 * 维护提示：
 *   1) **apiKey 只从构造参数来，本类不读环境变量、不读 config、不写任何持久化结构**。
 *      "Factory 不读取、不存储 API key" 的边界因此停在组合根（apps/api 决定 key 从哪来），
 *      domain 只负责用它发请求。在本文件里加 `process.env.OPENAI_API_KEY` 之类的兜底会直接
 *      破坏这条承诺，也会让 domain 的测试开始依赖真实环境。
 *   2) **stream() 不是真流式**：它调用非流式的 complete()，拿到完整文本后只 yield 一个
 *      text.delta。这是刻意的降级——Responses API 的 SSE 解析在 codex-app-server.ts 那条线
 *      上。不要因为"看起来像流"就假定它能增量渲染；前端能看到逐字效果靠的是另一条链路。
 *   3) 失败映射有两条不同的路径，不要合并：`!response.ok` 与 JSON 解析失败会从 complete()
 *      **抛出**，由 stream() 捕获后 yield `turn.failed`；而 `request.signal.aborted` 优先于
 *      两者，yield 的是 `turn.cancelled`（见 stream 的 catch 里的二次判断）。
 *      把 abort 归到 failed 会让用户主动取消被显示成错误。
 *   4) answerUserInput **故意抛错**而不是静默成功：本后端不支持 Codex 结构化追问，与
 *      capabilities().supportsStructuredUserInput === false 是配套的一对。改成 no-op 会让
 *      上层以为答案已送达 Provider。
 *   5) extractResponseText 只是 `payload.output_text` 不是字符串时的兜底（走
 *      output[].content[].text 并拼接），它是本模块私有，barrel 不转发。
 *   6) 依赖的 ModelGateway / ModelRequest / ModelEvent 等类型在**批 E 已改指 ./types.js**
 *      （批 D 当时从 ../index.js 取，是为了让搬迁提交保持"只搬不改"的形态）。
 *      这是一条 type-only 边，本文件与 model/types.ts 之间不构成值级环。
 */
import { normalizeModelUsage, type ModelUsage } from "./usage.js";
import type { ModelCapabilities, ModelEvent, ModelGateway, ModelRequest, ModelRole, ModelRoleConfig } from "./types.js";

/** 非流式模型调用的规范化结果。 */
export type ModelResult = { text: string; requestId: string | null; model: string; usage: ModelUsage | null };
/** OpenAI Responses API 的最小响应端口，便于测试替换 fetch。 */
export type ModelFetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
/** 可注入的 HTTP 调用函数，避免 Domain 直接绑定全局 fetch。 */
export type ModelFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal | undefined }) => Promise<ModelFetchResponse>;

/** OpenAI ModelGateway 配置；apiKey 由运行环境提供，不应持久化到 Project。 */
export type OpenAIModelGatewayOptions = { apiKey: string; roles: Record<ModelRole, ModelRoleConfig>; baseUrl?: string | undefined; fetchFn?: ModelFetch | undefined };

/** OpenAI Responses API 适配器；API Key 只从运行时配置读取。 */
export class OpenAIModelGateway implements ModelGateway {
  private readonly fetchFn: ModelFetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIModelGatewayOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";
    this.fetchFn = options.fetchFn ?? (async (url, init) => {
      const requestInit: RequestInit = { method: init.method, headers: init.headers, body: init.body };
      if (init.signal) requestInit.signal = init.signal;
      const response = await fetch(url, requestInit);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });
  }

  configFor(role: ModelRole): ModelRoleConfig { return this.options.roles[role]; }

  capabilities(_role: ModelRole): ModelCapabilities {
    return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const config = { ...this.configFor(request.role), ...(request.modelConfig ?? {}) };
    const input = request.continuationPrompt ? [...request.messages, { role: "user" as const, content: request.continuationPrompt }] : request.messages;
    const body: Record<string, unknown> = { model: config.model, input, stream: false };
    if (request.tools?.length) body.tools = request.tools;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxOutputTokens !== undefined) body.max_output_tokens = config.maxOutputTokens;
    const response = await this.fetchFn(this.baseUrl, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) throw new Error(`OpenAI Responses API failed with status ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    return { text: typeof payload.output_text === "string" ? payload.output_text : extractResponseText(payload), requestId: typeof payload.id === "string" ? payload.id : null, model: config.model, usage: normalizeModelUsage(payload.usage) };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) { yield { type: "turn.cancelled" }; return; }
    try {
      const result = await this.complete(request);
      if (result.usage) yield { type: "model.usage", usage: result.usage, scope: "turn", ...(request.providerThreadId ? { providerThreadId: request.providerThreadId } : {}) };
      yield { type: "text.delta", text: result.text };
      yield { type: "turn.completed" };
    } catch (error) {
      if (request.signal?.aborted) yield { type: "turn.cancelled" };
      else yield { type: "turn.failed", error: error instanceof Error ? error.message : "Model request failed" };
    }
  }

  async answerUserInput(): Promise<void> {
    throw new Error("OpenAI Responses backend does not support Codex structured user input");
  }

  async cancel(): Promise<void> { return undefined; }
}

function extractResponseText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
  }).join("");
}
