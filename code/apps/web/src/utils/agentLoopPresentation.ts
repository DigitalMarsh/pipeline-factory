import type { AgentLoop, AgentLoopDiagnostics } from "../types";

const AGENT_LOOP_STATE_LABELS: Record<string, string> = {
  CREATED: "Created",
  RUNNING: "Running",
  WAITING_FOR_INPUT: "Waiting for input",
  PAUSED: "Paused",
  RECOVERING: "Recovery required",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  NEEDS_RECONCILIATION: "Needs reconciliation",
};

export function formatAgentLoopState(state: string | null | undefined, fallback = "No active loop"): string {
  return AGENT_LOOP_STATE_LABELS[state ?? ""] ?? fallback;
}

export function formatAgentLoopGate(diagnostics?: Pick<AgentLoopDiagnostics, "lastGate">): string | null {
  const gate = diagnostics?.lastGate;
  if (!gate) return null;
  if (gate.action === "complete") return "Plan ready";
  if (gate.action === "continue") return `Plan incomplete · ${gate.reason.replace(/^PLAN_INCOMPLETE:完整方案缺少/, "").replace(/,/g, "、")}`;
  if (gate.action === "blocked") return `Blocked · ${gate.reason}`;
  return `${gate.action} · ${gate.reason}`;
}

export function formatAgentLoopTerminal(diagnostics?: Pick<AgentLoopDiagnostics, "terminal">): string | null {
  const terminal = diagnostics?.terminal;
  return terminal ? `${terminal.code} · ${terminal.message}` : null;
}

export function formatAgentLoopCompletion(loop: Pick<AgentLoop, "state" | "stepCount">): string | null {
  if (loop.state !== "COMPLETED") return null;
  return `Completed in ${loop.stepCount} provider turn${loop.stepCount === 1 ? "" : "s"}`;
}
