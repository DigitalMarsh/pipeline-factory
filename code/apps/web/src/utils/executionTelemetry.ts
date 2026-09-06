import type { ExecutionTelemetry, ModelUsage } from "../types";

export function formatTokenCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "未记录";
}

export function formatTokenSummary(usage: ModelUsage | null | undefined): string {
  return usage?.totalTokens === null || usage?.totalTokens === undefined ? "未记录" : `${formatTokenCount(usage.totalTokens)} tokens`;
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

export function telemetryReasoning(telemetry: ExecutionTelemetry | null | undefined): string {
  return telemetry?.reasoningEffort || "默认";
}

export function usageDetailRows(usage: ModelUsage | null | undefined): Array<{ label: string; value: string }> {
  return [
    { label: "输入 token", value: formatTokenCount(usage?.inputTokens) },
    { label: "输出 token", value: formatTokenCount(usage?.outputTokens) },
    { label: "推理 token", value: formatTokenCount(usage?.reasoningTokens) },
    { label: "总 token", value: formatTokenCount(usage?.totalTokens) },
  ];
}
