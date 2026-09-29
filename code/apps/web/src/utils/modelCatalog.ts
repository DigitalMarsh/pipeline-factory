/**
 * 模块职责：把后端目录（`GET /api/v4/model-backends`）推导成控制台可选的 agent、模型与推理强度。
 *
 * 为什么不再有硬编码清单：以前这里写死一份 `supportedProjectModels`（全是 Codex 侧的名字），
 *   而"探索用 Codex、执行用 Claude"意味着同一份下拉要在不同后端之间切换。清单现在由后端按
 *   **backend** 给出（见 apps/api/src/runtime/model-catalog.ts），这里只做派生与展示。
 *
 * 维护提示：
 *   1) **未知的已配置模型永远保持可选**：`modelOptionsFor` 会把调用方传入的当前值并进选项，
 *      否则用户手写的模型名（本地别名、代理映射名）会在打开设置页时被下拉框悄悄改掉。
 *   2) 推理档位是**接线事实**而不是建议：Claude Agent SDK 只透传 5 档，配 minimal/ultra
 *      等于没配。空数组表示"该后端不消费这个字段"，此时退回完整词表而不是清空下拉。
 *   3) 目录拉不到时（API 重启中）返回空目录，页面应退回"只显示当前值"的行为，不要编造清单。
 */
import type { ModelBackendDescriptor, ModelBackendsResponse } from "../types";

const KIND_LABELS: Record<ModelBackendDescriptor["kind"], string> = {
  "codex-app-server": "Codex App Server",
  "claude-agent-sdk": "Claude Agent SDK",
  "openai-responses": "OpenAI Responses",
  stub: "Stub",
};

/** 该后端不消费 reasoningEffort 时回退的完整词表（与配置 schema 的取值一致）。 */
const FULL_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export type ModelBackendOption = { id: string; label: string; kind: ModelBackendDescriptor["kind"]; endpoint: string | null; endpointSource: "config" | "provider-settings" };

export function findBackend(catalog: ModelBackendsResponse | null, backendId: string | null | undefined): ModelBackendDescriptor | null {
  if (!catalog || !backendId) return null;
  return catalog.backends.find((backend) => backend.id === backendId) ?? null;
}

/** 下拉用的后端列表；label 在注册表 id 与 kind 名不同时把两者都写出来（"deepseek · Claude Agent SDK"）。 */
export function backendOptions(catalog: ModelBackendsResponse | null): ModelBackendOption[] {
  if (!catalog) return [];
  return catalog.backends.map((backend) => ({
    id: backend.id,
    label: backend.id === backend.kind ? KIND_LABELS[backend.kind] : `${backend.id} · ${KIND_LABELS[backend.kind]}`,
    kind: backend.kind,
    endpoint: backend.endpoint,
    endpointSource: backend.endpointSource,
  }));
}

/** 状态栏展示用的短标签：优先注册表 id（"deepseek"比"Claude Agent SDK"更能回答"打到哪"）。 */
export function backendLabel(catalog: ModelBackendsResponse | null, backendId: string | null | undefined): string {
  const backend = findBackend(catalog, backendId);
  if (!backend) return backendId ?? "—";
  return backend.id === backend.kind ? KIND_LABELS[backend.kind] : backend.id;
}

/** 该后端端点由谁担保；cc-switch 这类由 CLI 设置解析的情形要如实说出来，不能让页面显得像配置里写死了。 */
export function endpointHint(catalog: ModelBackendsResponse | null, backendId: string | null | undefined): string | null {
  const backend = findBackend(catalog, backendId);
  if (!backend) return null;
  if (backend.endpointSource === "provider-settings") return backend.endpoint ? `CLI ${backend.endpoint}` : "由 CLI 自己的设置（cc-switch）解析";
  return backend.endpoint ?? null;
}

/** 选择某个后端时该显示的模型候选；当前值始终并入，避免手写模型名被下拉框改掉。 */
export function modelOptionsFor(catalog: ModelBackendsResponse | null, backendId: string | null | undefined, ...configured: Array<string | null | undefined>): string[] {
  const fromCatalog = findBackend(catalog, backendId)?.models ?? [];
  return [...new Set([...fromCatalog, ...configured.filter((value): value is string => Boolean(value))])];
}

/** 选择某个后端时该显示的推理档位；空值那一项由调用方自己加（它的文案随页面而变）。 */
export function reasoningOptionsFor(catalog: ModelBackendsResponse | null, backendId: string | null | undefined): Array<{ value: string; label: string }> {
  const levels = findBackend(catalog, backendId)?.reasoningEfforts ?? [];
  return (levels.length > 0 ? levels : FULL_REASONING_EFFORTS).map((value) => ({ value, label: value }));
}

/** 当前值不在该后端的档位表里时，把它也列出来 —— 否则用户看不到自己配了什么。 */
export function reasoningOptionsWith(catalog: ModelBackendsResponse | null, backendId: string | null | undefined, current: string): Array<{ value: string; label: string }> {
  const options = reasoningOptionsFor(catalog, backendId);
  if (!current || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: `${current}（当前值，后端可能忽略）` }];
}
