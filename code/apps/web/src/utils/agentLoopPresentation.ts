/**
 * 模块职责：Agent Loop 的状态 / 门禁 / 收尾文案。
 *
 * 维护提示：这里只放**这一套**状态机的文案。它与 Plan 生命周期（`planStatus.ts`）、
 * 消息与活动条目（`explorerPresentation.ts` / `RunDetailView.vue`）是四套不同的状态机，
 * 各自有各自的状态集合——共用一个词（比如"已完成"）是有意为之，共用一张表不是。
 */
import type { AgentLoop, AgentLoopDiagnostics } from "../types";

const AGENT_LOOP_STATE_LABELS: Record<string, string> = {
  CREATED: "已创建",
  RUNNING: "运行中",
  WAITING_FOR_INPUT: "等待输入",
  PAUSED: "已暂停",
  RECOVERING: "需要恢复",
  BLOCKED: "已阻塞",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  NEEDS_RECONCILIATION: "需要对账",
};

export function formatAgentLoopState(state: string | null | undefined, fallback = "无活动 Loop"): string {
  return AGENT_LOOP_STATE_LABELS[state ?? ""] ?? fallback;
}

export function formatAgentLoopGate(diagnostics?: Pick<AgentLoopDiagnostics, "lastGate">): string | null {
  const gate = diagnostics?.lastGate;
  if (!gate) return null;
  if (gate.action === "complete") return "方案已就绪";
  if (gate.action === "continue") return `方案未完成 · ${gate.reason.replace(/^PLAN_INCOMPLETE:完整方案缺少/, "").replace(/,/g, "、")}`;
  if (gate.action === "blocked") return `已阻塞 · ${gate.reason}`;
  return `${gate.action} · ${gate.reason}`;
}

export function formatAgentLoopTerminal(diagnostics?: Pick<AgentLoopDiagnostics, "terminal">): string | null {
  const terminal = diagnostics?.terminal;
  return terminal ? `${terminal.code} · ${terminal.message}` : null;
}

export function formatAgentLoopCompletion(loop: Pick<AgentLoop, "state" | "stepCount">): string | null {
  if (loop.state !== "COMPLETED") return null;
  return `已完成 ${loop.stepCount} 个 Provider 回合`;
}
