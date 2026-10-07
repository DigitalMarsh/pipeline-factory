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
 *   2) 推理强度**由后端决定、不是建议**：Claude Agent SDK 只透传 5 个取值，配 minimal/ultra
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

export type ModelBackendOption = {
  id: string;
  label: string;
  kind: ModelBackendDescriptor["kind"];
  endpoint: string | null;
  endpointSource: "config" | "provider-settings";
};

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
  if (backend.endpointSource === "provider-settings")
    return backend.endpoint ? `CLI ${backend.endpoint}` : "由 CLI 自己的设置（cc-switch）解析";
  return backend.endpoint ?? null;
}

/** 选择某个后端时该显示的模型候选；当前值始终并入，避免手写模型名被下拉框改掉。 */
export function modelOptionsFor(
  catalog: ModelBackendsResponse | null,
  backendId: string | null | undefined,
  ...configured: Array<string | null | undefined>
): string[] {
  const fromCatalog = findBackend(catalog, backendId)?.models ?? [];
  return [...new Set([...fromCatalog, ...configured.filter((value): value is string => Boolean(value))])];
}

/**
 * **切换 Agent 之后，模型与推理强度该跟着怎么变。**
 *
 * 为什么需要：上面那条"当前值始终并入"保证了**打开设置页**时手写模型名不被改掉，
 * 但它同时带来一个后果——切到 Claude 之后，下拉里列的是 Claude 的模型**加上**上一个后端的 slug，
 * 而**选中项仍是那个旧 slug**。存下去就成了 `backend: claude-agent-sdk` + `model: gpt-5.6-luna`：
 *
 * - 执行侧第一个回合会在 Provider 侧失败，而错误离配置很远；
 * - 域里的 `migrateForeignFamilyModels` **偏偏跳过显式写了 backend 的项目**（那是"用户有意为这个项目
 *   选的后端，slug 该由 Provider 侧报错暴露"），所以它**永远不会替你改回来**；
 * - 界面上表现为："改完 Agent 重开设置页，模型那格还是旧 agent 的名字"，执行线程里显示的也还是旧模型。
 *
 * 判据是"当前值属不属于另一个**已知**后端"：
 * - 目录里查不到的名字（手写别名、cc-switch 这类代理的映射名）一律不动——那正是要保护的东西；
 * - 同一个 kind 内部换后端（两个 Claude 网关之间）也不动，模型名大概率通用。
 *
 * 推理强度同理但更硬：后端**不接受**的取值会让保存直接被域拒绝
 * （`validateRoleBackend`：`models.executor.reasoningEffort "ultra" is not supported by backend …`），
 * 所以切换后落在一个新后端不支持的档位时，清回"默认"。
 */
export function backendSwitchAdjustment(
  catalog: ModelBackendsResponse | null,
  backendId: string | null | undefined,
  current: { model: string; reasoningEffort: string },
): { model: string | null; clearReasoningEffort: boolean } {
  const target = findBackend(catalog, backendId);
  if (!target) return { model: null, clearReasoningEffort: false };
  const owner = catalog?.backends.find((backend) => backend.models.includes(current.model));
  const foreign = Boolean(owner) && owner!.kind !== target.kind;
  const model = foreign && target.models.length > 0 && !target.models.includes(current.model) ? target.models[0]! : null;
  // 新后端不消费这个字段（levels 为空）时不表态——"空数组 = 不消费"，不是"什么都不接受"（见本文件维护提示 2）。
  const clearReasoningEffort =
    target.reasoningEfforts.length > 0 && Boolean(current.reasoningEffort) && !target.reasoningEfforts.includes(current.reasoningEffort);
  return { model, clearReasoningEffort };
}

/** 选择某个后端时该显示的推理强度；空值那一项由调用方自己加（它的文案随页面而变）。 */
export function reasoningOptionsFor(
  catalog: ModelBackendsResponse | null,
  backendId: string | null | undefined,
): Array<{ value: string; label: string }> {
  const levels = findBackend(catalog, backendId)?.reasoningEfforts ?? [];
  return (levels.length > 0 ? levels : FULL_REASONING_EFFORTS).map((value) => ({ value, label: value }));
}

/** 当前值不在该后端的推理强度表里时，把它也列出来 —— 否则用户看不到自己配了什么。 */
export function reasoningOptionsWith(
  catalog: ModelBackendsResponse | null,
  backendId: string | null | undefined,
  current: string,
): Array<{ value: string; label: string }> {
  const options = reasoningOptionsFor(catalog, backendId);
  if (!current || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: `${current}（当前值，后端可能忽略）` }];
}
