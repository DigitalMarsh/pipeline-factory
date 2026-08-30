export type ExecutionJournalEntry = {
  sequence: number;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type ExecutionStreamItem = {
  id: string;
  kind: "model" | "guidance" | "activity";
  role: "assistant" | "user" | "system";
  title: string;
  content: string;
  detail: string;
  status: "RUNNING" | "COMPLETED" | "WAITING" | "FAILED" | "INFO";
  occurredAt: string;
  sequence: number;
};

export function projectExecutionJournal(journal: ExecutionJournalEntry[], threadState: string = "ACTIVE"): ExecutionStreamItem[] {
  const items: ExecutionStreamItem[] = [];
  for (const entry of journal) {
    if (entry.type === "MODEL_OUTPUT") {
      const text = typeof entry.payload.text === "string" ? entry.payload.text : "";
      const previous = items.at(-1);
      if (previous?.kind === "model" && previous.sequence < entry.sequence) {
        previous.content += text;
        previous.sequence = entry.sequence;
        previous.occurredAt = entry.occurredAt;
      } else {
        items.push({ id: `execution-model-${entry.sequence}`, kind: "model", role: "assistant", title: "Executor", content: text, detail: "", status: "COMPLETED", occurredAt: entry.occurredAt, sequence: entry.sequence });
      }
      if (threadState === "ACTIVE" && journal.at(-1)?.sequence === entry.sequence) {
        const current = items.at(-1);
        if (current) current.status = "RUNNING";
      }
      continue;
    }

    const projected = projectExecutionActivity(entry);
    if (projected) items.push(projected);
  }
  return items;
}

function projectExecutionActivity(entry: ExecutionJournalEntry): ExecutionStreamItem | null {
  const payload = entry.payload;
  if (entry.type === "USER_GUIDANCE") {
    return { id: `execution-guidance-${entry.sequence}`, kind: "guidance", role: "user", title: "You", content: typeof payload.content === "string" ? payload.content : "", detail: "", status: "COMPLETED", occurredAt: entry.occurredAt, sequence: entry.sequence };
  }
  if (entry.type === "RUN_CREATED") return activity(entry, "Run created", `Plan ${String(payload.planId ?? "unknown")} · Revision ${String(payload.revision ?? "—")}`, "INFO");
  if (entry.type === "HOOK_SKIPPED") return activity(entry, "Hook skipped", String(payload.hook ?? "lifecycle hook"), "INFO");
  if (entry.type === "HOOK_COMPLETED") return activity(entry, "Hook completed", String(payload.hook ?? "lifecycle hook"), "COMPLETED");
  if (entry.type === "HOOK_FAILED") return activity(entry, "Hook failed", String(payload.stderr ?? payload.hook ?? "lifecycle hook"), "FAILED");
  if (entry.type === "TOOL_CALL") {
    const action = String(payload.action ?? "requested");
    const status = action === "requested" ? "RUNNING" : action === "completed" ? "COMPLETED" : "FAILED";
    return activity(entry, `Tool ${action}`, String(payload.tool ?? payload.callId ?? "tool activity"), status);
  }
  if (entry.type === "VERIFICATION") {
    const status = String(payload.status ?? "");
    return activity(entry, "Verification", status || "Verification result recorded", status === "PASSED" ? "COMPLETED" : "FAILED");
  }
  if (entry.type === "RECOVERY") return activity(entry, "Recovery required", String(payload.reason ?? payload.error ?? "Execution requires recovery"), "FAILED");
  if (entry.type === "TASK_PROGRESS") {
    const event = String(payload.event ?? payload.action ?? "");
    const state = String(payload.state ?? "");
    if (state === "BLOCKED") return activity(entry, "Run blocked", String(payload.reason ?? "Unknown blocking reason"), "FAILED");
    if (state === "CANCELLED") return activity(entry, "Run cancelled", String(payload.reason ?? "Cancelled"), "FAILED");
    if (event === "agent.context.compacted") return activity(entry, "Context compacted", `Message count ${String(payload.messageCount ?? "—")}`, "COMPLETED");
    if (event === "agent.model.completed") return activity(entry, "Model step completed", `Step ${String(payload.step ?? "—")}`, "COMPLETED");
    if (event === "agent.step.started") return activity(entry, "Model step started", `Step ${String(payload.step ?? "—")}`, "RUNNING");
    if (event === "agent.gate.checked") return activity(entry, "Execution gate checked", `${String(payload.action ?? "unknown")} · ${String(payload.reason ?? "")}`.trim(), payload.action === "blocked" ? "FAILED" : "INFO");
    if (event === "agent.loop.created" || payload.action === "executor_loop_created") return activity(entry, "Executor started", String(payload.loopId ?? ""), "RUNNING");
    if (payload.action === "legacy_plan_revision") return activity(entry, "Legacy Plan revision", String(payload.reason ?? "Using legacy runtime settings"), "INFO");
    if (payload.action === "paused") return activity(entry, "Execution paused", "Waiting for resume", "WAITING");
    if (payload.action === "resumed") return activity(entry, "Execution resumed", "", "RUNNING");
    return activity(entry, "Execution activity", event || String(payload.reason ?? payload.action ?? ""), "INFO");
  }
  return activity(entry, entry.type.replaceAll("_", " "), formatPayloadDetail(payload), "INFO");
}

function activity(entry: ExecutionJournalEntry, title: string, detail: string, status: ExecutionStreamItem["status"]): ExecutionStreamItem {
  return { id: `execution-activity-${entry.sequence}`, kind: "activity", role: "system", title, content: "", detail, status, occurredAt: entry.occurredAt, sequence: entry.sequence };
}

function formatPayloadDetail(payload: Record<string, unknown>): string {
  const values = Object.entries(payload).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return values.join(" · ");
}
