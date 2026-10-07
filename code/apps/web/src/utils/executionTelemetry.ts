import type { ExecutionTelemetry, ModelBackendsResponse, ModelUsage } from "../types";
import { backendLabel } from "./modelCatalog";

export function formatTokenCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "未记录";
}

export function formatTokenSummary(usage: ModelUsage | null | undefined): string {
  return usage?.totalTokens === null || usage?.totalTokens === undefined ? "未记录" : `${formatTokenCount(usage.totalTokens)} tokens`;
}

/** Provider 返回的 input token 作为执行线程当前 Context；缺失时不做前端估算。 */
export function formatProviderContextUsage(inputTokens: number | null | undefined): string {
  return typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0
    ? `${formatTokenCount(inputTokens)} tokens`
    : "未记录";
}

export function formatDurationMs(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "未记录";
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function liveDurationMs(telemetry: ExecutionTelemetry | null | undefined, now = Date.now()): number | null {
  if (!telemetry) return null;
  if (telemetry.durationMs !== null && telemetry.durationMs !== undefined) return telemetry.durationMs;
  if (!telemetry.startedAt) return null;
  const started = Date.parse(telemetry.startedAt);
  const completed = telemetry.completedAt ? Date.parse(telemetry.completedAt) : now;
  return Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null;
}

export function formatExecutionDuration(telemetry: ExecutionTelemetry | null | undefined, now = Date.now()): string {
  return formatDurationMs(liveDurationMs(telemetry, now));
}

export function telemetryModel(telemetry: ExecutionTelemetry | null | undefined): string {
  return telemetry?.model || "未记录";
}

/** 执行这次 Run 的 agent。**旧 Run 没有这个字段**（遥测是 JSON 列，历史行缺键），所以读 undefined。 */
export function telemetryBackend(telemetry: ExecutionTelemetry | null | undefined, catalog: ModelBackendsResponse | null = null): string {
  return telemetry?.backend ? backendLabel(catalog, telemetry.backend) : "未记录";
}

export function telemetryReasoning(telemetry: ExecutionTelemetry | null | undefined): string {
  return telemetry?.reasoningEffort || "默认";
}

/** "现在用的是什么模型"的来源：本次跑过并记下来的、还是配置里写着要用的。 */
export type ExecutionModelSource = "recorded" | "configured" | "unknown";
export type ExecutionModelIdentity = { model: string; backend: string; source: ExecutionModelSource };

/**
 * "现在用的是什么模型 / 哪个 agent"的答案 —— **本次记录优先，没记录时用这次 Run 的执行配置**。
 *
 * 为什么需要它：遥测是**每一轮结束时**才落库的，运行中三格全是"未记录"——而"现在用的是什么模型"
 * 恰恰是运行中才想问的问题。配置那份来自 Revision 快照（Plan Confirm 时冻结；没有快照的老 Run
 * 由 API 回退当前项目设置），**是"这次执行会用什么"，不是"上一轮用了什么"**。
 *
 * `source` 让界面说清这个值是哪来的：不要把配置值当成跑过的记录展示。
 * `model` 与 `backend` 不拆开混搭——它们是同一次写入的一对事实，混搭会造出一个从未存在过的组合。
 */
export function resolveExecutionModelIdentity(
  telemetry: ExecutionTelemetry | null | undefined,
  executorConfig: { model: string | null; backend: string | null } | null | undefined,
  catalog: ModelBackendsResponse | null = null,
): ExecutionModelIdentity {
  if (telemetry?.model || telemetry?.backend) {
    return {
      model: telemetry.model || "未记录",
      backend: telemetry.backend ? backendLabel(catalog, telemetry.backend) : "未记录",
      source: "recorded",
    };
  }
  if (executorConfig?.model || executorConfig?.backend) {
    return {
      model: executorConfig.model || "未记录",
      backend: executorConfig.backend ? backendLabel(catalog, executorConfig.backend) : "未记录",
      source: "configured",
    };
  }
  return { model: "未记录", backend: "未记录", source: "unknown" };
}

/**
 * 底部那行值的**来源说明**：跑过的记录、还是配置里要用的；以及"配置已经改了但这份 Run 还在用旧的"。
 *
 * 最后一种最容易被当成 bug：用户把项目的执行模型换成 claude，回到执行线程一看还是 codex。
 * 那不是显示错了——已确认的 Plan 与它派发的 Run 用的是**确认时冻结的**那份配置（见 executor-agent
 * 取模型的写法），新模型要等下一个 Plan Revision 才生效。这里把这件事写在页面上，
 * 而不是指望用户去读 Plan 详情里的冻结快照。
 */
export function executionModelSourceNote(
  identity: ExecutionModelIdentity,
  currentExecutor: { model: string | null } | null | undefined,
): string {
  const base = identity.source === "recorded" ? "本次执行记录" : identity.source === "configured" ? "按本 Run 冻结的项目配置" : "";
  const current = currentExecutor?.model ?? null;
  const inUse = identity.source === "unknown" ? null : identity.model;
  if (!base || !current || !inUse || current === inUse) return base;
  return `${base} · 项目当前配置 ${current}（改在下一个 Plan Revision 生效）`;
}

export function usageDetailRows(usage: ModelUsage | null | undefined): Array<{ label: string; value: string }> {
  return [
    { label: "输入 token", value: formatTokenCount(usage?.inputTokens) },
    { label: "输出 token", value: formatTokenCount(usage?.outputTokens) },
    { label: "推理 token", value: formatTokenCount(usage?.reasoningTokens) },
    { label: "总 token", value: formatTokenCount(usage?.totalTokens) },
  ];
}
