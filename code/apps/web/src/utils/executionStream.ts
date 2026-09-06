/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
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

/** 将 ExecutionThread journal 映射成类似 Explorer 对话的模型/活动消息流。 */
export function projectExecutionJournal(journal: ExecutionJournalEntry[], threadState: string = "ACTIVE"): ExecutionStreamItem[] {
  const items: ExecutionStreamItem[] = [];
  let pendingModelText = "";
  let pendingModelSequence = 0;
  let pendingModelOccurredAt = "";
  const flushModel = () => {
    if (!pendingModelText) return;
    const content = humanizeModelOutput(pendingModelText);
    if (content) items.push({ id: `execution-model-${pendingModelSequence}`, kind: "model", role: "assistant", title: content.title, content: content.body, detail: "", status: "COMPLETED", occurredAt: pendingModelOccurredAt, sequence: pendingModelSequence });
    pendingModelText = "";
  };
  for (const entry of journal) {
    if (entry.type === "MODEL_OUTPUT") {
      const text = typeof entry.payload.text === "string" ? entry.payload.text : "";
      pendingModelText += text;
      pendingModelSequence = entry.sequence;
      pendingModelOccurredAt = entry.occurredAt;
      continue;
    }

    flushModel();
    const projected = projectExecutionActivity(entry);
    if (projected) items.push(projected);
  }
  flushModel();
  if (threadState === "ACTIVE") {
    const current = items.at(-1);
    if (current?.kind === "model") current.status = "RUNNING";
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
    if (payload.action === "task-status") {
      const completed = Array.isArray(payload.completedTaskIds) ? payload.completedTaskIds.filter((id): id is string => typeof id === "string") : [];
      const detail = `${completed.length} task(s) completed${typeof payload.activeTaskId === "string" ? ` · active ${payload.activeTaskId}` : ""}${typeof payload.blockedTaskId === "string" ? ` · blocked ${payload.blockedTaskId}` : ""}`;
      return activity(entry, "Task progress", detail, typeof payload.blockedTaskId === "string" ? "FAILED" : typeof payload.activeTaskId === "string" ? "RUNNING" : "COMPLETED");
    }
    // High-frequency loop bookkeeping remains available in Diagnostics, not the primary conversation.
    if (event === "agent.context.compacted" || event === "agent.model.completed" || event === "agent.step.started") return null;
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

function humanizeModelOutput(content: string): { title: string; body: string } | null {
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  if (start < 0) return { title: "Executor", body: content };
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return { title: "Executor", body: content };
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as { completedTaskIds?: unknown; changedPaths?: unknown; report?: unknown };
    const completed = Array.isArray(report.completedTaskIds) ? report.completedTaskIds.filter((id): id is string => typeof id === "string") : [];
    const changedPaths = Array.isArray(report.changedPaths) ? report.changedPaths.filter((path): path is string => typeof path === "string") : [];
    const summary = typeof report.report === "string" ? report.report : "Execution report recorded.";
    return { title: "Executor report", body: `${summary}\n\nCompleted ${completed.length} task(s) · ${changedPaths.length} changed path(s)` };
  } catch {
    return { title: "Executor", body: content.slice(0, start).trim() || "Execution report could not be parsed." };
  }
}
