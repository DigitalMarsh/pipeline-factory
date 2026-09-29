/**
 * 模块职责：StubModelGateway —— 一个不访问任何外部模型、但**遵守完整 ModelGateway 事件协议**
 *   的测试替身。返回固定的文本增量，usage 与速率限制一概报告为"不可用"。
 *
 * 为什么从 index.ts 抽出来（批 D）：它是 model/ 目录里第三个 ModelGateway 实现，与
 *   gateway-openai.ts、codex-app-server.ts 并列。三个实现放在同一目录，接口契约的边界才看得清
 *   —— 谁是生产实现、谁是降级实现、谁是替身，一眼可分。
 *
 * 维护提示：
 *   1) **它返回的是"协议正确"而不是"内容合理"**：stream() 固定 yield 一条 text.delta 加一条
 *      turn.completed，正文按 request.role 区分 explorer/executor 两句常量。测试若断言这两句
 *      之外的文本，说明被测代码在依赖真实 provider。
 *   2) 它显式实现 readRateLimits 并返回 `available: false` + reason —— 不是漏掉。任何"未知"
 *      都不能被上层当成"额度充足"；reason 文案是 UI 的展示契约。
 *   3) capabilities() 报 supportsToolCalls: false、supportedLoopModes: ["provider-controlled"]，
 *      与 gateway-openai.ts 的实现逐字相同。这直接决定了一条行为：executor-agent 拿到
 *      factory-controlled 模式的请求时会检查 `!capabilities.supportsToolCalls ||
 *      !capabilities.supportedLoopModes.includes(mode)`，两者都不满足 → 抛
 *      MODEL_CAPABILITY_UNAVAILABLE。**真跑 Executor 工具循环必须走 codex-app-server**；
 *      改这两个值会让本替身"看起来"能驱动工具循环，而它并不会 yield tool.call。
 *   4) 依赖的 ModelGateway / ModelRequest / ModelEvent 等类型在**批 E 已改指 ./types.js**
 *      （type-only 边；批 D 当时从 ../index.js 取）。至此 model/ 下三个 ModelGateway 实现
 *      都直接从同一处契约取类型，接口边界不再需要经由 barrel 绕一圈。
 */
import type { ModelCapabilities, ModelEvent, ModelGateway, ModelRequest, ModelRole, ModelRoleConfig, ProviderEndpoint, ProviderUsageSnapshot } from "./types.js";

/** 测试用 ModelGateway；保持事件协议但不访问外部模型。 */
export class StubModelGateway implements ModelGateway {
  constructor(private readonly configs: Record<ModelRole, ModelRoleConfig>) {}

  configFor(role: ModelRole): ModelRoleConfig { return this.configs[role]; }

  capabilities(_role: ModelRole): ModelCapabilities {
    return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    yield { type: "text.delta", text: request.role === "explorer" ? "Stub Explorer response" : "Stub Executor response" };
    yield { type: "turn.completed" };
  }

  async answerUserInput(): Promise<void> { return undefined; }
  async cancel(): Promise<void> { return undefined; }
  async readRateLimits(): Promise<ProviderUsageSnapshot> { return { available: false, fiveHour: null, sevenDay: null, reason: "Stub backend does not report provider usage" }; }

  /** 替身没有端点可担保：如实报"没有 Provider"，而不是编一个看起来像真的端点。 */
  describeEndpoint(): ProviderEndpoint { return { backend: "stub", endpoint: null, source: "config", cliVersion: null, credentialSource: null, providerModel: null }; }
}
