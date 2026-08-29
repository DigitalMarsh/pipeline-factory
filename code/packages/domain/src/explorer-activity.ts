import type { AgentLoop, AgentLoopStep } from "./agent-loop.js";
import type { ExplorerTurn } from "./index.js";

export type ExplorerActivityKind =
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "REASONING_SUMMARY"
  | "INPUT_REQUIRED"
  | "INPUT_RESOLVED"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TOOL_DENIED"
  | "MCP_ACTIVITY"
  | "CONTEXT_COMPACTED"
  | "GATE_CHECKED"
  | "TURN_STATUS";

export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING";
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
};

export type ExplorerActivityInput = {
  turns: readonly ExplorerTurn[];
  loops: readonly AgentLoop[];
  steps: readonly AgentLoopStep[];
};

type ActivityWithOrder = ExplorerActivityItem & { order: number };

export function projectExplorerActivity(input: ExplorerActivityInput): ExplorerActivityItem[] {
  const loopByOwner = new Map(input.loops.map((loop) => [loop.ownerId, loop]));
  const result: ActivityWithOrder[] = [];
  let order = 0;
  const append = (item: Omit<ExplorerActivityItem, "id" | "sequence">, stableSequence: number): void => {
    result.push({ ...item, id: `activity-${item.turnId}-${stableSequence}-${result.length}`, sequence: result.length + 1, order: order++ });
  };

  for (const turn of [...input.turns].sort((a, b) => a.sequence - b.sequence)) {
    if (turn.role === "user") {
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: turn.content, details: null, occurredAt: turn.createdAt }, turn.sequence);
      continue;
    }

    const loop = loopByOwner.get(turn.id);
    const steps = input.steps.filter((step) => step.loopId === loop?.id).sort((a, b) => a.sequence - b.sequence);
    let assistantText = "";
    let assistantSequence = turn.sequence;
    for (const step of steps) {
      const payload = step.payload;
      if (step.stepType === "MODEL_TEXT_DELTA") {
        const text = typeof payload.text === "string" ? payload.text : "";
        assistantText += text;
        assistantSequence = step.sequence;
        const previous = result.at(-1);
        if (previous?.kind === "ASSISTANT_MESSAGE" && previous.turnId === turn.id) {
          previous.summary += text;
          continue;
        }
        append({ explorerId: turn.threadId, turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: "RUNNING", title: "Plan Explorer", summary: text, details: null, occurredAt: step.occurredAt }, step.sequence);
        continue;
      }
      if (step.stepType === "PROVIDER_ACTIVITY") {
        const providerActivity = activityFromStep(turn, step);
        if (providerActivity) append(providerActivity, step.sequence);
        continue;
      }
      const activity = activityFromStep(turn, step);
      if (activity) append(activity, step.sequence);
    }
    if (!assistantText && turn.content.trim()) {
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : "COMPLETED", title: "Plan Explorer", summary: turn.content, details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt }, assistantSequence);
    }
    if (!steps.length && !turn.content.trim()) {
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "TURN_STATUS", status: turn.status === "WAITING_FOR_INPUT" ? "WAITING" : turn.status === "FAILED" ? "FAILED" : "RUNNING", title: "Plan Explorer", summary: turn.status === "WAITING_FOR_INPUT" ? "Waiting for input" : "Plan Explorer is processing", details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt }, turn.sequence);
    }
  }

  return result
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.order - b.order)
    .map(({ order: _order, ...item }, index) => ({ ...item, sequence: index + 1 }));
}

function activityFromStep(turn: ExplorerTurn, step: AgentLoopStep): Omit<ExplorerActivityItem, "id" | "sequence"> | null {
  const payload = step.payload;
  const base = { explorerId: turn.threadId, turnId: turn.id, occurredAt: step.occurredAt };
  if (step.stepType === "PROVIDER_ACTIVITY") {
    const itemType = typeof payload.itemType === "string" ? payload.itemType : "provider-item";
    const phase = payload.phase === "completed" ? "completed" : "started";
    const kind = itemType.toLowerCase().includes("mcp") ? "MCP_ACTIVITY" : itemType.toLowerCase().includes("reason") ? "REASONING_SUMMARY" : phase === "completed" ? "TOOL_COMPLETED" : "TOOL_STARTED";
    return { ...base, kind, status: phase === "completed" ? "COMPLETED" : "RUNNING", title: typeof payload.title === "string" && payload.title.trim() ? payload.title : itemType, summary: typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.slice(0, 240) : phase === "completed" ? "Provider activity completed." : "Provider activity started.", details: { itemId: payload.itemId ?? null, itemType, providerControlled: true } };
  }
  if (step.stepType === "MODEL_STARTED") return { ...base, kind: "REASONING_SUMMARY", status: "RUNNING", title: "Analyzing", summary: `Plan Explorer started step ${String(payload.step ?? step.sequence)}.`, details: null };
  if (step.stepType === "INPUT_REQUIRED") return { ...base, kind: "INPUT_REQUIRED", status: "WAITING", title: "Input required", summary: `${Array.isArray(payload.questions) ? payload.questions.length : 0} structured question(s) are waiting.`, details: { requestId: payload.requestId ?? null, isBlocking: payload.isBlocking ?? true } };
  if (step.stepType === "INPUT_RESOLVED") return { ...base, kind: "INPUT_RESOLVED", status: "COMPLETED", title: "Input resolved", summary: "Your selection was submitted; the same turn is continuing.", details: { requestId: payload.requestId ?? null, answerCount: payload.answerCount ?? 0 } };
  if (step.stepType === "TOOL_REQUESTED") return { ...base, kind: "TOOL_STARTED", status: "RUNNING", title: "Tool running", summary: typeof payload.tool === "string" ? payload.tool : "Provider tool", details: { tool: payload.tool ?? "provider", callId: step.callId } };
  if (step.stepType === "TOOL_COMPLETED") return { ...base, kind: "TOOL_COMPLETED", status: "COMPLETED", title: "Tool completed", summary: "The tool returned a result.", details: { callId: step.callId, reason: payload.reason ?? null } };
  if (step.stepType === "TOOL_DENIED") return { ...base, kind: "TOOL_DENIED", status: "FAILED", title: "Tool denied", summary: typeof payload.reason === "string" ? payload.reason : "The tool request was denied by policy.", details: { callId: step.callId } };
  if (step.stepType === "CONTEXT_COMPACTED") return { ...base, kind: "CONTEXT_COMPACTED", status: "COMPLETED", title: "Context checkpointed", summary: "The loop saved a checkpoint before continuing.", details: { messageCount: payload.messageCount ?? null } };
  if (step.stepType === "GATE_CHECKED") return { ...base, kind: "GATE_CHECKED", status: payload.action === "blocked" ? "FAILED" : "COMPLETED", title: "Gate checked", summary: typeof payload.reason === "string" ? payload.reason : "The termination gate evaluated this step.", details: { action: payload.action ?? null } };
  if (step.stepType === "MODEL_COMPLETED") return { ...base, kind: "TURN_STATUS", status: "COMPLETED", title: "Model step completed", summary: "The model step completed.", details: null };
  return null;
}
