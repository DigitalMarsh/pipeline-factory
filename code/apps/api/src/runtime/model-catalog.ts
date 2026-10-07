/**
 * 模块职责：把配置里的后端解析成控制台与 domain 都能消费的**目录** ——
 *   每个后端支持哪些模型名、哪些推理强度，以及当前角色默认用哪个后端。
 *
 * 为什么单独一个文件，而不是塞进 config.ts：config.ts 描述的是"用户写了什么"，
 *   这里描述的是"这一类 provider 事实是什么"（例如 Claude Agent SDK 只认 5 档 effort）。
 *   把 provider 事实混进配置 schema，会让 schema 变成"当前所有后端事实的堆积处"，
 *   加一个后端就得改校验规则。
 *
 * 维护提示：
 *   1) **内置模型清单只驱动下拉框，不参与任何后端校验。** Factory 不可能知道某个网关
 *      （尤其是 cc-switch 这类代理）把哪些模型名映射到哪里，所以这些名字是"建议值"，
 *      用户永远可以填清单外的名字 —— 与 Project 设置里"未知模型名保持可选"的既有立场一致。
 *   2) `REASONING_EFFORTS_BY_KIND` 是**由后端配置决定的事实**，不是建议：Claude 侧 `asEffort`
 *      （model/claude-agent-sdk.ts）只透传 low/medium/high/xhigh/max，配了 minimal/ultra
 *      等于没配且**没有任何提示**。这里如实列出，让 Project 设置保存时就能拒绝。
 *      改这里之前先改那一侧的映射，否则会把"能存但无效"变成"存都存不进去"。
 *   3) 空数组的语义是"这个后端不消费该字段"（不是"什么都不接受"），见 ModelBackendCatalog。
 */
import { resolveModelBackends, roleBackendId, type FactoryConfig, type ResolvedModelBackend } from "../config.js";
import type { ModelBackendCatalog } from "@pipeline-factory/domain";

/** 各类后端的候选模型名；`models: []` 表示没有建议值。 */
const BUILT_IN_MODELS_BY_KIND: Record<string, string[]> = {
  "codex-app-server": ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  "claude-agent-sdk": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  "openai-responses": ["gpt-6"],
  stub: [],
};

/** 各类后端真正接受的推理强度；空数组 = 该后端不消费 reasoningEffort，不做校验。 */
const REASONING_EFFORTS_BY_KIND: Record<string, string[]> = {
  "codex-app-server": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  "claude-agent-sdk": ["low", "medium", "high", "xhigh", "max"],
  "openai-responses": [],
  stub: [],
};

export type ModelBackendDescriptor = {
  id: string;
  kind: string;
  /** 注册表定义的还是由 model.backend / codexAppServer / claudeAgent 隐式提供的。 */
  source: "registry" | "implicit";
  models: string[];
  reasoningEfforts: string[];
  /** 端点指纹（不含凭据）或该后端自己的 CLI；由 Provider 设置解析时为 null。 */
  endpoint: string | null;
  /** 端点来源：config = 本配置文件给出；provider-settings = Provider 自己的设置/登录态。 */
  endpointSource: "config" | "provider-settings";
};

/** 单个后端的端点描述。**不含任何凭据**：这里给的是 host 或 CLI 命令，供控制台展示。 */
function describeEndpoint(backend: ResolvedModelBackend): Pick<ModelBackendDescriptor, "endpoint" | "endpointSource"> {
  if (backend.kind === "claude-agent-sdk") {
    const baseUrl = backend.claudeAgent?.baseUrl;
    if (!baseUrl) return { endpoint: null, endpointSource: "provider-settings" };
    try {
      return { endpoint: new URL(baseUrl).host, endpointSource: "config" };
    } catch {
      return { endpoint: baseUrl, endpointSource: "config" };
    }
  }
  if (backend.kind === "codex-app-server") {
    const codex = backend.codexAppServer;
    return codex
      ? { endpoint: [codex.command, ...codex.args].join(" "), endpointSource: "provider-settings" }
      : { endpoint: null, endpointSource: "config" };
  }
  if (backend.kind === "openai-responses") {
    const baseUrl = backend.openai?.baseUrl;
    if (!baseUrl) return { endpoint: "api.openai.com", endpointSource: "config" };
    try {
      return { endpoint: new URL(baseUrl).host, endpointSource: "config" };
    } catch {
      return { endpoint: baseUrl, endpointSource: "config" };
    }
  }
  return { endpoint: null, endpointSource: "config" };
}

/** 逐个后端列出可用于控制台的目录项，按 id 稳定排序以便对比两次输出的差异。 */
export function describeModelBackends(config: FactoryConfig): {
  backends: ModelBackendDescriptor[];
  roles: Record<"explorer" | "executor", string>;
  defaultBackend: string;
} {
  const resolved = resolveModelBackends(config.model);
  const backends = [...resolved.values()]
    .map((backend) => ({
      id: backend.id,
      kind: backend.kind,
      source: backend.source,
      models: backend.models.length > 0 ? backend.models : (BUILT_IN_MODELS_BY_KIND[backend.kind] ?? []),
      reasoningEfforts: REASONING_EFFORTS_BY_KIND[backend.kind] ?? [],
      ...describeEndpoint(backend),
    }))
    .sort((left, right) => (left.source === right.source ? left.id.localeCompare(right.id) : left.source === "implicit" ? -1 : 1));
  return {
    backends,
    roles: { explorer: roleBackendId(config.model, "explorer"), executor: roleBackendId(config.model, "executor") },
    defaultBackend: config.model.backend,
  };
}

/** 给 ProjectService 用的校验端口：domain 只问"有没有这个 id、这个 id 接受哪些推理强度"。 */
export function createModelCatalog(config: FactoryConfig): ModelBackendCatalog & { modelsFor(id: string): string[] } {
  const descriptors = describeModelBackends(config).backends;
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return {
    has: (id) => byId.has(id),
    effortLevelsFor: (id) => byId.get(id)?.reasoningEfforts ?? [],
    // 项目级执行会话要按 executor 后端列出可选模型；与上面两个同源，避免"下拉有、选了被拒"。
    modelsFor: (id) => byId.get(id)?.models ?? [],
  };
}
