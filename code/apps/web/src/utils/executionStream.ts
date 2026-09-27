/**
 * 模块职责：把 ExecutionThread journal 投影成按 Plan 任务组织的执行会话。
 *
 * 维护提示：这里只展示持久化事实和 Provider 明确提供的安全摘要；不得输出工具参数、成功结果或模型私有思维链。
 */
import type { ExecutionJournalPayload, PlanTask } from "../types";

export type ExecutionJournalEntry = {
  sequence: number;
  type: string;
  occurredAt: string;
  payload: ExecutionJournalPayload;
};

export type ExecutionPlanSnapshot = {
  planId: string;
  revision: number;
  occurredAt: string;
  goal: string;
  acceptanceCriteria: string[];
  includePaths: string[];
  excludePaths: string[];
  tasks: PlanTask[];
  verificationCommandIds: string[];
};

export type ExecutionStreamItem = {
  id: string;
  kind: "plan" | "model" | "guidance" | "activity" | "tool";
  role: "assistant" | "user" | "system";
  title: string;
  content: string;
  detail: string;
  status: "RUNNING" | "COMPLETED" | "WAITING" | "FAILED" | "INFO" | "UNKNOWN";
  occurredAt: string;
  sequence: number;
  taskId?: string | undefined;
  modelStep?: number | undefined;
  loopId?: string | undefined;
  providerThreadId?: string | undefined;
  providerTurnId?: string | undefined;
  providerItemId?: string | undefined;
  callId?: string | undefined;
  source?: "provider" | "factory" | "unknown" | undefined;
  serverName?: string | undefined;
  unrecordedFields?: string[] | undefined;
  repetitionCount?: number;
  plan?: ExecutionPlanSnapshot;
};

type PendingModelText = {
  text: string;
  firstSequence: number;
  lastSequence: number;
  occurredAt: string;
  taskId?: string;
  modelStep?: number;
  loopId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
};

/** 将 ExecutionThread journal 映射成按 Plan 任务归组的模型、Provider 和用户消息。 */
export function projectExecutionJournal(journal: ExecutionJournalEntry[], threadState: string = "ACTIVE", plan?: ExecutionPlanSnapshot): ExecutionStreamItem[] {
  const orderedJournal = [...journal].sort((a, b) => a.sequence - b.sequence);
  const taskByModelStep = projectTaskAssociations(orderedJournal);
  const items: ExecutionStreamItem[] = plan ? [planMessage(plan)] : [];
  const toolItems = new Map<string, ExecutionStreamItem>();
  const providerItems = new Map<string, ExecutionStreamItem>();
  const modelTurnItems = new Map<string, ExecutionStreamItem>();
  const seenCompletedTasks = new Set<string>();
  let currentModelStep: number | undefined;
  let currentLoopId: string | undefined;
  let pendingModel: PendingModelText | null = null;

  const flushModel = () => {
    if (!pendingModel?.text) {
      pendingModel = null;
      return;
    }
    const display = humanizeModelOutput(pendingModel.text);
    if (display) {
      let previousIndex = -1;
      if (display.title === "Executor report") {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index]?.kind === "model" && items[index]?.title === "Executor report") { previousIndex = index; break; }
        }
      }
      const previous = previousIndex >= 0 ? items[previousIndex] : undefined;
      const onlyProgressBetween = previousIndex >= 0 && items.slice(previousIndex + 1).every((item) => item.kind === "activity" && (item.title.startsWith("模型轮次") || ["Task progress", "Execution activity", "任务完成"].includes(item.title)));
      if (previous && onlyProgressBetween && sameReportProgress(previous.content, display.body)) {
        previous.content = display.body;
        previous.sequence = pendingModel.lastSequence;
        previous.occurredAt = pendingModel.occurredAt;
        previous.repetitionCount = (previous.repetitionCount ?? 1) + 1;
        pendingModel = null;
        return;
      }
      const missing: string[] = [];
      if (pendingModel.modelStep === undefined) missing.push("模型轮次未记录");
      if (!pendingModel.providerThreadId && !pendingModel.providerTurnId) missing.push("Provider 会话标识未记录");
      items.push({
        id: `execution-model-${pendingModel.firstSequence}`,
        kind: "model",
        role: "assistant",
        title: display.title,
        content: display.body,
        detail: missing.join(" · "),
        status: "COMPLETED",
        occurredAt: pendingModel.occurredAt,
        sequence: pendingModel.lastSequence,
        ...(pendingModel.taskId ? { taskId: pendingModel.taskId } : {}),
        ...(pendingModel.modelStep === undefined ? {} : { modelStep: pendingModel.modelStep }),
        ...(pendingModel.loopId ? { loopId: pendingModel.loopId } : {}),
        ...(pendingModel.providerThreadId ? { providerThreadId: pendingModel.providerThreadId } : {}),
        ...(pendingModel.providerTurnId ? { providerTurnId: pendingModel.providerTurnId } : {}),
        ...(pendingModel.providerItemId ? { providerItemId: pendingModel.providerItemId } : {}),
        ...(missing.length ? { unrecordedFields: missing } : {}),
      });
    }
    pendingModel = null;
  };

  for (const entry of orderedJournal) {
    const payload = entry.payload;
    const step = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
    const loopId = stringValue(payload.loopId) ?? currentLoopId;
    const taskId = stringValue(payload.taskId) ?? (step === undefined ? undefined : taskByModelStep.get(step));

    if (entry.type === "MODEL_OUTPUT") {
      const text = stringValue(payload.text) ?? "";
      const providerItemId = stringValue(payload.providerItemId);
      const providerThreadId = stringValue(payload.providerThreadId);
      const providerTurnId = stringValue(payload.providerTurnId);
      const sameModelStream = pendingModel
        && pendingModel.modelStep === step
        && pendingModel.providerItemId === providerItemId;
      if (!sameModelStream) flushModel();
      if (!pendingModel) {
        pendingModel = {
          text,
          firstSequence: entry.sequence,
          lastSequence: entry.sequence,
          occurredAt: entry.occurredAt,
          ...(taskId ? { taskId } : {}),
          ...(step === undefined ? {} : { modelStep: step }),
          ...(loopId ? { loopId } : {}),
          ...(providerThreadId ? { providerThreadId } : {}),
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(providerItemId ? { providerItemId } : {}),
        };
      } else {
        pendingModel.text += text;
        pendingModel.lastSequence = entry.sequence;
        if (!pendingModel.taskId && taskId) pendingModel.taskId = taskId;
        if (!pendingModel.providerThreadId && providerThreadId) pendingModel.providerThreadId = providerThreadId;
        if (!pendingModel.providerTurnId && providerTurnId) pendingModel.providerTurnId = providerTurnId;
      }
      continue;
    }

    flushModel();
    if (entry.type === "TASK_PROGRESS" && payload.event === "agent.step.started") {
      currentModelStep = numberValue(payload.modelStep) ?? numberValue(payload.step);
      currentLoopId = stringValue(payload.loopId) ?? currentLoopId;
    }

    if (entry.type === "TOOL_CALL") {
      const item = projectToolCall(entry, taskId, step, loopId);
      const key = item.callId ? `call:${item.callId}` : `missing:${entry.sequence}`;
      const providerKey = item.callId ? `provider:${item.callId}` : "";
      const previous = toolItems.get(key) ?? (providerKey ? providerItems.get(providerKey) : undefined);
      if (previous) {
        const providerDecorated = Boolean(previous.providerItemId);
        if (!providerDecorated) {
          previous.title = item.title;
          previous.detail = item.detail;
          previous.source = item.source;
        } else if (item.status !== "RUNNING") {
          previous.detail = item.detail;
        }
        if (item.status !== "RUNNING" || previous.status === "RUNNING") previous.status = item.status;
        previous.taskId = previous.taskId ?? item.taskId;
        previous.modelStep = previous.modelStep ?? item.modelStep;
        previous.loopId = previous.loopId ?? item.loopId;
        previous.providerThreadId = previous.providerThreadId ?? item.providerThreadId;
        previous.providerTurnId = previous.providerTurnId ?? item.providerTurnId;
        previous.callId = previous.callId ?? item.callId;
        previous.unrecordedFields = providerDecorated ? previous.unrecordedFields : item.unrecordedFields;
        toolItems.set(key, previous);
        if (providerKey) providerItems.set(providerKey, previous);
      } else {
        toolItems.set(key, item);
        items.push(item);
      }
      continue;
    }

    if (entry.type === "PROVIDER_ACTIVITY") {
      const item = projectProviderActivity(entry, taskId, step, loopId);
      const identity = item.providerItemId ?? stringValue(payload.itemId);
      const key = identity ? `provider:${identity}` : `missing:${entry.sequence}`;
      const callKey = item.callId ? `call:${item.callId}` : "";
      const previous = providerItems.get(key) ?? (callKey ? toolItems.get(callKey) : undefined);
      if (previous) {
        const previousWasTool = previous.kind === "tool" && Boolean(previous.callId);
        if (!previousWasTool) {
          previous.title = item.title;
          previous.detail = item.detail;
        } else {
          previous.title = item.title;
          if (item.status !== "RUNNING" || previous.status === "RUNNING") previous.status = item.status;
          if (item.status !== "RUNNING") previous.detail = item.detail;
        }
        if (!previousWasTool) previous.status = item.status;
        previous.taskId = previous.taskId ?? item.taskId;
        previous.serverName = item.serverName ?? previous.serverName;
        previous.modelStep = previous.modelStep ?? item.modelStep;
        previous.loopId = previous.loopId ?? item.loopId;
        previous.providerThreadId = previous.providerThreadId ?? item.providerThreadId;
        previous.providerTurnId = previous.providerTurnId ?? item.providerTurnId;
        previous.providerItemId = previous.providerItemId ?? item.providerItemId;
        previous.callId = previous.callId ?? item.callId;
        previous.source = "provider";
        previous.unrecordedFields = previousWasTool ? previous.unrecordedFields : item.unrecordedFields;
        providerItems.set(key, previous);
        if (callKey) toolItems.set(callKey, previous);
      } else {
        providerItems.set(key, item);
        if (callKey) toolItems.set(callKey, item);
        items.push(item);
      }
      continue;
    }

    if (entry.type === "TASK_PROGRESS") {
      const event = stringValue(payload.event) ?? "";
      if (event === "agent.step.started" || event === "agent.model.completed") {
        const modelStep = numberValue(payload.modelStep) ?? numberValue(payload.step);
        if (modelStep !== undefined) currentModelStep = modelStep;
        currentLoopId = stringValue(payload.loopId) ?? currentLoopId;
        const key = `${currentLoopId ?? "loop-not-recorded"}:${modelStep ?? `sequence-${entry.sequence}`}`;
        const existing = modelTurnItems.get(key);
        const completed = event === "agent.model.completed";
        if (existing) {
          existing.status = completed ? "COMPLETED" : "RUNNING";
          existing.detail = completed ? "模型轮次已结束" : "模型正在处理此轮任务";
          existing.providerThreadId = stringValue(payload.providerThreadId) ?? existing.providerThreadId;
          existing.providerTurnId = stringValue(payload.providerTurnId) ?? existing.providerTurnId;
        } else {
          const unrecorded = modelStep === undefined ? ["模型轮次未记录"] : [];
          const item = activity(
            entry,
            modelStep === undefined ? "模型轮次" : `模型轮次 · #${modelStep}`,
            completed ? "模型轮次已结束" : "模型正在处理此轮任务",
            completed ? "COMPLETED" : "RUNNING",
            {
              ...(taskId ? { taskId } : {}),
              ...(modelStep === undefined ? {} : { modelStep }),
              ...(currentLoopId ? { loopId: currentLoopId } : {}),
              ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}),
              ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}),
              ...(unrecorded.length ? { unrecordedFields: unrecorded } : {}),
            },
          );
          modelTurnItems.set(key, item);
          items.push(item);
        }
        continue;
      }
      if (payload.action === "task-status") {
        const completedIds = stringArray(payload.completedTaskIds);
        const newlyCompleted = completedIds.filter((id) => !seenCompletedTasks.has(id));
        for (const id of completedIds) seenCompletedTasks.add(id);
        for (const item of projectTaskStatus(entry, plan, newlyCompleted)) items.push(item);
        continue;
      }
      if (payload.action === "task-lifecycle") {
        const lifecycleTaskId = stringValue(payload.taskId);
        const lifecycleState = payload.state;
        if (lifecycleTaskId && (lifecycleState === "IN_PROGRESS" || lifecycleState === "DONE" || lifecycleState === "BLOCKED")) {
          if (lifecycleState === "DONE") seenCompletedTasks.add(lifecycleTaskId);
          const title = lifecycleState === "IN_PROGRESS" ? "任务开始" : lifecycleState === "DONE" ? "任务完成" : "任务阻塞";
          const detail = lifecycleState === "BLOCKED" ? stringValue(payload.reason) ?? "阻塞原因未记录。" : taskTitle(plan, lifecycleTaskId);
          items.push(activity(entry, title, detail, lifecycleState === "IN_PROGRESS" ? "RUNNING" : lifecycleState === "DONE" ? "COMPLETED" : "FAILED", { taskId: lifecycleTaskId, ...(step === undefined ? {} : { modelStep: step }), ...(loopId ? { loopId } : {}), ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}), ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}) }));
        }
        continue;
      }
    }

    const projected = projectExecutionActivity(entry, taskId, step, loopId);
    if (projected) items.push(projected);
  }

  flushModel();
  if (threadState !== "ACTIVE") {
    for (const item of modelTurnItems.values()) {
      if (item.status === "RUNNING") {
        item.status = threadState === "PAUSED" ? "WAITING" : "UNKNOWN";
        item.detail = threadState === "PAUSED" ? "等待执行线程恢复。" : "模型轮次结束状态未记录。";
      }
    }
    for (const item of toolItems.values()) {
      if (item.status === "RUNNING") {
        item.status = "UNKNOWN";
        item.detail = item.callId ? "未记录调用的结束状态。" : "调用标识和结束状态未记录。";
      }
    }
    for (const item of providerItems.values()) {
      if (item.status === "RUNNING") {
        item.status = "UNKNOWN";
        item.detail = item.providerItemId ? "Provider 未记录此活动的结束状态。" : "Provider 活动标识和结束状态未记录。";
      }
    }
  }
  if (threadState === "ACTIVE") {
    const activeStep = currentModelStep;
    for (const item of items) {
      if (item.kind === "model" && item.modelStep === activeStep) item.status = "RUNNING";
    }
  }
  return items;
}

function projectTaskAssociations(journal: ExecutionJournalEntry[]): Map<number, string> {
  const byStep = new Map<number, string>();
  const completed = new Set<string>();
  const structuredSteps = new Set<number>();
  for (const entry of journal) {
    if (entry.type === "TASK_PROGRESS" && (entry.payload.action === "task-status" || entry.payload.action === "task-lifecycle")) {
      const step = numberValue(entry.payload.modelStep);
      if (step !== undefined) structuredSteps.add(step);
    }
  }
  let currentModelStep: number | undefined;
  let modelText = "";
  for (const entry of journal) {
    if (entry.type === "MODEL_OUTPUT") {
      modelText += stringValue(entry.payload.text) ?? "";
      const outputStep = numberValue(entry.payload.modelStep);
      if (outputStep !== undefined) currentModelStep = outputStep;
      continue;
    }
    if (entry.type !== "TASK_PROGRESS") continue;
    const payload = entry.payload;
    if (payload.event === "agent.step.started") currentModelStep = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
    if (payload.action === "task-status") {
      const completedIds = stringArray(payload.completedTaskIds);
      const newlyCompleted = completedIds.filter((id) => !completed.has(id));
      const taskId = stringValue(payload.blockedTaskId)
        ?? stringValue(payload.activeTaskId)
        ?? (newlyCompleted.length === 1 ? newlyCompleted[0] : undefined);
      const modelStep = numberValue(payload.modelStep);
      if (taskId && modelStep !== undefined) byStep.set(modelStep, taskId);
      for (const id of completedIds) completed.add(id);
      continue;
    }
    if (payload.action === "task-lifecycle") {
      const taskId = stringValue(payload.taskId);
      const modelStep = numberValue(payload.modelStep);
      if (taskId && modelStep !== undefined) byStep.set(modelStep, taskId);
      if (taskId && payload.state === "DONE") completed.add(taskId);
      continue;
    }
    if (payload.event === "agent.model.completed") {
      const modelStep = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
      if (modelStep !== undefined && !structuredSteps.has(modelStep)) {
        const report = parseStructuredTaskReport(modelText);
        if (report) {
          const newlyCompleted = report.completedTaskIds.filter((id) => !completed.has(id));
          const taskId = report.blockedTaskId ?? report.activeTaskId ?? (newlyCompleted.length === 1 ? newlyCompleted[0] : undefined);
          if (taskId) byStep.set(modelStep, taskId);
          for (const id of report.completedTaskIds) completed.add(id);
        }
      }
      modelText = "";
    }
  }
  return byStep;
}

function parseStructuredTaskReport(content: string): { completedTaskIds: string[]; activeTaskId?: string; blockedTaskId?: string } | null {
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  if (start < 0) return null;
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return null;
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as Record<string, unknown>;
    if (!Array.isArray(report.completedTaskIds) || !report.completedTaskIds.every((id) => typeof id === "string")) return null;
    return {
      completedTaskIds: report.completedTaskIds as string[],
      ...(typeof report.activeTaskId === "string" ? { activeTaskId: report.activeTaskId } : {}),
      ...(typeof report.blockedTaskId === "string" ? { blockedTaskId: report.blockedTaskId } : {}),
    };
  } catch {
    return null;
  }
}

function planMessage(plan: ExecutionPlanSnapshot): ExecutionStreamItem {
  return {
    id: `execution-plan-${plan.planId}-${plan.revision}`,
    kind: "plan",
    role: "assistant",
    title: "Plan received",
    content: plan.goal,
    detail: "",
    status: "COMPLETED",
    occurredAt: plan.occurredAt,
    sequence: 0,
    plan,
  };
}

function projectTaskStatus(entry: ExecutionJournalEntry, plan: ExecutionPlanSnapshot | undefined, newlyCompleted: string[]): ExecutionStreamItem[] {
  const payload = entry.payload;
  const blockedTaskId = stringValue(payload.blockedTaskId);
  const activeTaskId = stringValue(payload.activeTaskId);
  const modelStep = numberValue(payload.modelStep);
  const loopId = stringValue(payload.loopId);
  const providerThreadId = stringValue(payload.providerThreadId);
  const providerTurnId = stringValue(payload.providerTurnId);
  const result: ExecutionStreamItem[] = [];
  const metadata = {
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
  };
  for (const completedTaskId of newlyCompleted) {
    if (completedTaskId === blockedTaskId || completedTaskId === activeTaskId) continue;
    const item = activity(entry, "任务完成", taskTitle(plan, completedTaskId), "COMPLETED", { taskId: completedTaskId, ...metadata });
    item.id = `${item.id}-${completedTaskId}`;
    result.push(item);
  }
  const taskId = blockedTaskId ?? activeTaskId;
  if (taskId) {
    const blocked = taskId === blockedTaskId;
    const detail = blocked ? stringValue(payload.blockedReason) ?? "阻塞原因未记录。" : taskTitle(plan, taskId);
    result.push(activity(entry, blocked ? "任务阻塞" : "任务执行中", detail, blocked ? "FAILED" : "RUNNING", { taskId, ...metadata }));
  }
  return result;
}

function projectToolCall(entry: ExecutionJournalEntry, taskId: string | undefined, modelStep: number | undefined, loopId: string | undefined): ExecutionStreamItem {
  const payload = entry.payload;
  const callId = stringValue(payload.callId);
  const tool = stringValue(payload.tool);
  const source = payload.source === "provider" || payload.source === "factory" ? payload.source : "unknown";
  const action = stringValue(payload.action) ?? "requested";
  const status = action === "completed" ? "COMPLETED"
    : action === "failed" || action === "denied" || action === "needs-reconciliation" ? "FAILED"
      : action === "status-unknown" ? "UNKNOWN"
        : callId ? "RUNNING" : "UNKNOWN";
  const sourceLabel = source === "provider" ? "Provider" : source === "factory" ? "Factory" : "来源未记录";
  const title = /mcp/i.test(tool ?? "") ? "MCP tool call" : source === "provider" ? "Provider tool call" : "Tool call";
  const detailParts = [sourceLabel, tool ?? "工具名称未记录"];
  const reason = stringValue(payload.reason);
  if (reason) detailParts.push(reason);
  else if (!callId) detailParts.push("调用标识未记录");
  else if (status === "UNKNOWN") detailParts.push("结束状态未记录");
  return {
    id: callId ? `execution-tool-${callId}` : `execution-tool-missing-${entry.sequence}`,
    kind: "tool",
    role: "system",
    title,
    content: "",
    detail: detailParts.join(" · "),
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(callId ? { callId } : {}),
    source,
    ...(!callId || !tool || source === "unknown" ? { unrecordedFields: [!callId ? "调用标识未记录" : "", !tool ? "工具名称未记录" : "", source === "unknown" ? "调用来源未记录" : ""].filter(Boolean) } : {}),
  };
}

function projectProviderActivity(entry: ExecutionJournalEntry, taskId: string | undefined, modelStep: number | undefined, loopId: string | undefined): ExecutionStreamItem {
  const payload = entry.payload;
  const itemType = stringValue(payload.itemType);
  const providerItemId = stringValue(payload.providerItemId) ?? stringValue(payload.itemId);
  const toolLike = /tool|mcp/i.test(itemType ?? "");
  const serverName = stringValue(payload.serverName);
  const toolName = stringValue(payload.toolName);
  const providerStatus = stringValue(payload.providerStatus)?.toLowerCase();
  const reason = stringValue(payload.reason);
  const phase = payload.phase === "completed" ? "completed" : "started";
  const status = phase === "started" ? "RUNNING"
    : reason || ["failed", "error", "denied", "cancelled", "canceled"].includes(providerStatus ?? "") ? "FAILED"
      : ["success", "succeeded"].includes(providerStatus ?? "") ? "COMPLETED"
        : "UNKNOWN";
  const category = /mcp/i.test(itemType ?? "") ? "MCP call" : /command/i.test(itemType ?? "") ? "Command" : toolLike ? "Provider tool" : "Provider activity";
  const name = toolName ? `${serverName ? `${serverName}/` : ""}${toolName}` : serverName;
  const detail = reason
    ?? (phase === "started" ? "Provider activity started" : status === "UNKNOWN" ? (providerStatus === "completed" || providerStatus === "complete" ? "Provider 已结束调用，但成败状态未记录。" : "Provider 未提供调用结果状态。") : status === "COMPLETED" ? "Provider reported success" : "Provider activity failed");
  const missing: string[] = [];
  if (!providerItemId) missing.push("Provider 调用标识未记录");
  if (!itemType) missing.push("Provider 活动类型未记录");
  if (phase === "completed" && status === "UNKNOWN") missing.push("调用结束状态未记录");
  return {
    id: providerItemId ? `execution-provider-${providerItemId}` : `execution-provider-missing-${entry.sequence}`,
    kind: toolLike ? "tool" : "activity",
    role: "system",
    title: name ? `${category} · ${name}` : category,
    content: "",
    detail,
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(toolLike && providerItemId ? { callId: providerItemId, source: "provider" as const } : {}),
    ...(serverName ? { serverName } : {}),
    ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}),
    ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}),
    ...(missing.length ? { unrecordedFields: missing } : {}),
  };
}

function projectExecutionActivity(entry: ExecutionJournalEntry, taskId?: string, modelStep?: number, loopId?: string): ExecutionStreamItem | null {
  const payload = entry.payload;
  const association = {
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
  };
  if (entry.type === "USER_GUIDANCE") return { id: `execution-guidance-${entry.sequence}`, kind: "guidance", role: "user", title: "你补充了要求", content: stringValue(payload.content) ?? "", detail: "", status: "COMPLETED", occurredAt: entry.occurredAt, sequence: entry.sequence, ...association };
  if (entry.type === "RUN_CREATED") return activity(entry, "Run created", `Plan ${stringValue(payload.planId) ?? "未记录"} · Revision ${stringValue(payload.revision) ?? "—"}`, "INFO", association);
  if (entry.type === "HOOK_SKIPPED") return activity(entry, "Hook skipped", stringValue(payload.hook) ?? "Hook name not recorded", "INFO", association);
  if (entry.type === "HOOK_COMPLETED") return activity(entry, "Hook completed", stringValue(payload.hook) ?? "Lifecycle hook", "COMPLETED", association);
  if (entry.type === "HOOK_FAILED") return activity(entry, "Hook failed", stringValue(payload.stderr) ?? stringValue(payload.hook) ?? "Hook failure reason not recorded", "FAILED", association);
  if (entry.type === "VERIFICATION") {
    const status = stringValue(payload.status) ?? "未记录";
    const reason = stringValue(payload.reason);
    return activity(entry, "Verification", reason ?? status, status === "PASSED" ? "COMPLETED" : status === "SKIPPED" ? "INFO" : "FAILED", association);
  }
  if (entry.type === "RECOVERY") return activity(entry, "需要恢复", stringValue(payload.reason) ?? stringValue(payload.error) ?? "阻塞原因未记录", "FAILED", association);
  if (entry.type === "TASK_PROGRESS") {
    const state = stringValue(payload.state);
    if (state === "BLOCKED") return activity(entry, "Run blocked", stringValue(payload.reason) ?? "Blocking reason not recorded", "FAILED", association);
    if (state === "CANCELLED") return activity(entry, "Run cancelled", stringValue(payload.reason) ?? "Cancelled", "FAILED", association);
    if (payload.action === "task-status") return null;
    const event = stringValue(payload.event) ?? "";
    if (event === "continue") return null;
    if (event === "agent.context.compacted") return activity(entry, "Context compacted", "Model context was refreshed", "INFO", association);
    if (event === "agent.gate.checked") return activity(entry, "Execution gate", `${stringValue(payload.action) ?? "unknown"}${stringValue(payload.reason) ? ` · ${stringValue(payload.reason)}` : ""}`, payload.action === "blocked" ? "FAILED" : "INFO", association);
    if (event === "agent.loop.created" || payload.action === "executor_loop_created") return activity(entry, "Executor started", stringValue(payload.loopId) ?? "", "RUNNING", association);
    if (payload.action === "legacy_plan_revision") return activity(entry, "Legacy Plan revision", stringValue(payload.reason) ?? "Using legacy runtime settings", "INFO", association);
    if (payload.action === "paused") return activity(entry, "Execution paused", "Waiting for resume", "WAITING", association);
    if (payload.action === "resumed") return activity(entry, "Execution resumed", "", "RUNNING", association);
    if (["agent.model.completed", "agent.step.started"].includes(event)) return null;
    return activity(entry, "Execution activity", event || stringValue(payload.reason) || stringValue(payload.action) || "Activity details not recorded", "INFO", association);
  }
  if (["MODEL_OUTPUT", "PROVIDER_ACTIVITY", "TOOL_CALL"].includes(entry.type)) return null;
  return activity(entry, entry.type.replaceAll("_", " "), "未记录可展示的执行摘要。", "UNKNOWN", { ...association, unrecordedFields: ["执行摘要未记录"] });
}

function activity(entry: ExecutionJournalEntry, title: string, detail: string, status: ExecutionStreamItem["status"], metadata: Partial<ExecutionStreamItem> = {}): ExecutionStreamItem {
  return { id: `execution-activity-${entry.sequence}`, kind: "activity", role: "system", title, content: "", detail, status, occurredAt: entry.occurredAt, sequence: entry.sequence, ...metadata };
}

function taskTitle(plan: ExecutionPlanSnapshot | undefined, taskId: string): string {
  const task = plan?.tasks.find((candidate) => candidate.id === taskId);
  return task?.title ?? taskId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameReportProgress(previous: string, next: string): boolean {
  const progress = (value: string) => value.match(/Completed (\d+) task\(s\) · (\d+) changed path\(s\)$/)?.slice(1).join(":") ?? null;
  return progress(previous) !== null && progress(previous) === progress(next);
}

function humanizeModelOutput(content: string): { title: string; body: string } | null {
  content = stripTaskProgressMarkers(content);
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  if (start < 0) return { title: "Executor", body: content };
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return { title: "Executor report", body: content.slice(0, start).trim() || "Execution report is still streaming." };
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as { completedTaskIds?: unknown; changedPaths?: unknown; report?: unknown };
    const completed = Array.isArray(report.completedTaskIds) ? report.completedTaskIds.filter((id): id is string => typeof id === "string") : [];
    const changedPaths = Array.isArray(report.changedPaths) ? report.changedPaths.filter((path): path is string => typeof path === "string") : [];
    const summary = typeof report.report === "string" ? report.report : "Execution report recorded.";
    return { title: "Executor report", body: `${summary}\n\nCompleted ${completed.length} task(s) · ${changedPaths.length} changed path(s)` };
  } catch {
    return { title: "Executor report", body: content.slice(0, start).trim() || "Execution report could not be parsed." };
  }
}

function stripTaskProgressMarkers(content: string): string {
  const startMarker = "<pipeline-factory-task-progress>";
  const endMarker = "</pipeline-factory-task-progress>";
  let visible = content.replace(/<pipeline-factory-task-progress>[\s\S]*?<\/pipeline-factory-task-progress>/g, "");
  const incompleteStart = visible.lastIndexOf(startMarker);
  if (incompleteStart >= 0 && visible.indexOf(endMarker, incompleteStart) < 0) visible = visible.slice(0, incompleteStart);
  for (let length = Math.min(startMarker.length - 1, visible.length); length > 0; length -= 1) {
    if (visible.endsWith(startMarker.slice(0, length))) {
      visible = visible.slice(0, -length);
      break;
    }
  }
  return visible;
}
