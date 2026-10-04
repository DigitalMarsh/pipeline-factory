/**
 * 模块职责：把 ExecutionThread journal 投影成按 Plan 任务组织的执行会话。
 *
 * 维护提示：这里只展示持久化事实和 Provider 明确提供的安全摘要；不得输出工具参数、成功结果或模型私有思维链。
 */
import type { ExecutionJournalPayload, PlanTask } from "../types";
import type { SharedMessageType } from "./conversationTypes";

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
  kind: "plan" | "model" | "user" | "activity" | "tool";
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
  /** Provider 活动的中立类别与成败（见下方 ACTIVITY_KIND_LABELS 的说明）；非 Provider 活动条目为空。 */
  activityKind?: ProviderActivityKind | undefined;
  outcome?: ProviderActivityOutcome | undefined;
  /** 这条消息属于哪一类（见 EXECUTION_DISPLAY_MODES）。呈现方式只由它决定。 */
  messageType: ExecutionMessageType;  plan?: ExecutionPlanSnapshot;
};

/**
 * 执行会话里的消息类型。**这张联合类型就是"消息清单"**——每一种在聊天框里怎么呈现，
 * 由下面 `EXECUTION_DISPLAY_MODES` 一张表决定；要调整呈现方式，改表即可，不用翻模板。
 *
 * **与探索线程共用其中大部分名字**（见 `conversationTypes.ts`）：同一个概念在两条对话线上
 * 必须同一个名字，否则"两边到底一不一致"只能靠人肉对照。只有执行侧才有的那几种在下面单独标注。
 *
 * 为什么把它显式化：此前呈现方式是散在投影与模板里的——有的按 `kind` 分支、有的按 `outcome` 猜、
 * 有的靠标题字符串相等（`title === "Executor report"`）。于是"这类消息要不要显示、显示成什么样"
 * 没有一个地方能一眼看全，改一处就会漏另一处。
 */
export type ExecutionMessageType =
  /** 冻结方案的摘要（每个 Run 一条）——**只有执行侧有**：探索侧的是还没确认的候选方案 */
  | "PLAN"
  /** Executor 的结构化完成报告（完成了哪几步、改了哪些文件）——**只有执行侧有**：执行报告协议 */
  | "MODEL_REPORT"
  /** 任务开始 / 完成 / 阻塞 ——**只有执行侧有**：Plan 任务这一层 */
  | "TASK_LIFECYCLE"
  /** Run 级事件：创建、生命周期钩子、验证（当前承载在顶部 RUN CONTEXT 卡片）——**只有执行侧有** */
  | "RUN_ACTIVITY"
  /** 阻塞、取消、需要恢复 —— 异常，必须显眼。**只有执行侧有**：Run 才有恢复流程 */
  | "RECOVERY"
  | SharedMessageType;

/**
 * 上面这张清单里**与探索线程共用的**那些。`type-parity.test.ts` 断言它逐字等于
 * `SharedMessageType`——两边任何一个漏了共用项，编译期就红（见 conversationTypes.ts）。
 */
export type ExecutionSharedMessageType = Extract<ExecutionMessageType, SharedMessageType>;

/**
 * 呈现方式：
 * - `card`：完整卡片（可读正文 + 详情）
 * - `text`：纯文本一行（用户自己说的话——不套卡片，见 `docs/消息类型及事件状态机流程图.md`）
 * - `line`：一行（紧凑活动行，不展开正文）
 * - `folded`：折进所属执行步骤的「N 条活动」，点开才看
 * - `hidden`：不渲染
 */
export type ExecutionDisplayMode = "card" | "text" | "line" | "folded" | "hidden";

/**
 * **消息类型 → 呈现方式。这张表就是"清单"本身。**
 * 依据是每条消息对"搞清楚 Executor 在干什么"的贡献：
 * 正文与结论是 `card`；你自己说的话是 `text`；动作（命令 / 文件 / 工具 / 步骤）是 `line`；
 * 过程性噪音（推理、门禁）`folded`；Provider 的回显与会话机制 `hidden`。
 */
export const EXECUTION_DISPLAY_MODES: Record<ExecutionMessageType, ExecutionDisplayMode> = {
  PLAN: "card",
  ASSISTANT_MESSAGE: "card",
  MODEL_REPORT: "card",
  USER_MESSAGE: "text",
  COMMAND: "line",
  FILE_CHANGE: "line",
  TOOL_CALL: "line",
  MCP_CALL: "line",
  TASK_LIFECYCLE: "line",
  REASONING: "folded",
  GATE: "folded",
  // 机制信息（回合状态、上下文压缩、认不出来的活动）：默认收起而不是彻底隐藏——
  // 它们平时无用，但排查"这一轮到底有没有开始"时是唯一线索。
  TURN_STATUS: "folded",
  CONTEXT: "folded",
  UNCLASSIFIED: "folded",
  PROVIDER_MESSAGE: "hidden",
  SESSION: "hidden",
  RUN_ACTIVITY: "card",
  RECOVERY: "card",
};

/**
 * 这条消息是否只是"机制记录"——它不构成内容，因此不改变"报告是否重复"的判断
 * （见 flushModel 里合并重复完成报告的那段）。
 * 此前这里比的是**标题字符串**（`["Task progress", "Execution activity", "任务完成"].includes(title)`），
 * 改一个文案就会静默失效。
 */
function isMechanismOnly(item: ExecutionStreamItem): boolean {
  return item.messageType === "TURN_STATUS" || item.messageType === "TASK_LIFECYCLE" || item.messageType === "GATE" || item.messageType === "CONTEXT" || item.messageType === "UNCLASSIFIED";
}

/** 这条消息该怎么呈现。视图与分组都只问它，不再各自判断。 */
export function executionDisplayMode(item: ExecutionStreamItem): ExecutionDisplayMode {
  return EXECUTION_DISPLAY_MODES[item.messageType];
}


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
    // 正文被清空（例如整条输出只有一段任务标记）时**不产生卡片**：只剩标题和时间的空卡片是纯噪音。
    if (!display || !display.body.trim()) {
      pendingModel = null;
      return;
    }
    if (display) {
      let previousIndex = -1;
      if (display.report) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index]?.messageType === "MODEL_REPORT") { previousIndex = index; break; }
        }
      }
      const previous = previousIndex >= 0 ? items[previousIndex] : undefined;
      const onlyProgressBetween = previousIndex >= 0 && items.slice(previousIndex + 1).every(isMechanismOnly);
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
        messageType: display.report ? "MODEL_REPORT" : "ASSISTANT_MESSAGE",
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
              messageType: "TURN_STATUS",
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
          items.push(activity(entry, title, detail, lifecycleState === "IN_PROGRESS" ? "RUNNING" : lifecycleState === "DONE" ? "COMPLETED" : "FAILED", { messageType: "TASK_LIFECYCLE", taskId: lifecycleTaskId, ...(step === undefined ? {} : { modelStep: step }), ...(loopId ? { loopId } : {}), ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}), ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}) }));
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
    messageType: "PLAN",
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
    messageType: "TASK_LIFECYCLE" as const,
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
  // 中文标签，与 Provider 活动的中立词表一致（此前是 "Provider tool call" 这类英文分类名）。
  const title = /mcp/i.test(tool ?? "") ? "MCP 调用" : "工具调用";
  const detailParts = [tool ?? "工具名称未记录", sourceLabel];
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
    messageType: "TOOL_CALL",
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

/**
 * Provider 活动的中立词表。**这是 packages/domain/src/model/provider-activity.ts 的一份镜像**——
 * web 不能运行时依赖领域层（会把整个领域打进浏览器包），而 journal 载荷里的字段是无类型的字符串。
 * 两边必须一致：`executionStream.parity.test.ts` 用同一批样例断言镜像与领域实现给出相同结论，
 * 改这里就要同步改那边，测试会拦住漂移。
 */
export type ProviderActivityKind = "command" | "file-change" | "tool" | "mcp" | "reasoning" | "message" | "session" | "other";
export type ProviderActivityOutcome = "running" | "succeeded" | "failed" | "unknown" | "not-applicable";

const ACTIVITY_KINDS: readonly ProviderActivityKind[] = ["command", "file-change", "tool", "mcp", "reasoning", "message", "session", "other"];
const ACTIVITY_OUTCOMES: readonly ProviderActivityOutcome[] = ["running", "succeeded", "failed", "unknown", "not-applicable"];

/**
 * 类别 → 展示词。**中立标签表只有这一处**：以前是拿 `itemType` 正则现猜（`/command/` → "Command"，
 * 其余一律 "Provider activity"），于是同一个动作换个 agent 就换个名字，而 "Provider activity"
 * 这种标签等于没说。
 */
const ACTIVITY_KIND_LABELS: Record<ProviderActivityKind, string> = {
  command: "命令",
  "file-change": "文件变更",
  tool: "工具调用",
  mcp: "MCP 调用",
  reasoning: "推理",
  message: "消息",
  session: "会话",
  other: "活动",
};

/**
 * 验证结果的文案。`SKIPPED` 是"没跑"、`BLOCKED` 是"没跑成"，都不是失败——别合并成一个词。
 */
const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  PASSED: "验证通过",
  FAILED: "验证未通过",
  BLOCKED: "验证被阻塞",
  SKIPPED: "验证已跳过",
};

/** 门禁判定的动作词。**只有 `blocked` 有信息量**，其余是"可以继续跑"。 */
function gateActionLabel(action: unknown): string {
  const value = typeof action === "string" ? action : "";
  if (value === "blocked") return "判定拦截";
  if (value === "complete") return "判定完成";
  if (value === "continue") return "判定继续";
  return value || "未记录";
}

function isActivityKind(value: unknown): value is ProviderActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * Provider 活动的中立类别 → 消息类型。`other` 归到"未识别"，**不伪装成已知类别**——
 * 认不出来就说认不出来，比塞进"命令"里更诚实。
 */
const ACTIVITY_MESSAGE_TYPES: Record<ProviderActivityKind, ExecutionMessageType> = {
  command: "COMMAND",
  "file-change": "FILE_CHANGE",
  tool: "TOOL_CALL",
  // MCP 调用有自己的名字（不再并进 `tool`）：探索线程那边同样单列一类，
  // 两条会话里"这是 MCP 服务端的调用"都看得见。
  mcp: "MCP_CALL",
  reasoning: "REASONING",
  message: "PROVIDER_MESSAGE",
  session: "SESSION",
  other: "UNCLASSIFIED",
};

function isActivityOutcome(value: unknown): value is ProviderActivityOutcome {
  return typeof value === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * 老 journal 事件的类别兜底（本次改动之前写入的条目没有 activityKind）。
 * **只按 Codex 的词表判**：带 Claude 字段的事件都在本次改动之后写入，不会走到这里。
 * 表与顺序必须与 `codexActivityKind` 逐字一致——`tool` 排在 `mcp` 之后，否则 `mcpToolCall`
 * 会被"tool"抢走；parity 测试会拦下任何分叉。
 */
export function legacyActivityKind(itemType: string): ProviderActivityKind {
  const value = itemType.trim().toLowerCase();
  const table: Array<[ProviderActivityKind, readonly string[]]> = [
    ["mcp", ["mcp"]],
    ["command", ["command", "exec"]],
    ["file-change", ["file", "patch"]],
    ["reasoning", ["reason"]],
    ["message", ["message"]],
    ["session", ["session"]],
    ["tool", ["tool"]],
  ];
  for (const [kind, needles] of table) {
    if (needles.some((needle) => value.includes(needle))) return kind;
  }
  return "other";
}

/**
 * 老 journal 事件的成败兜底。**与领域实现同一张词表**，包括那条关键修正：
 * Codex 的 `completed` 就是成功——曾经成功白名单只有 success|succeeded，于是成功的调用
 * 全被显示成"状态未知"。另外 `reasoning` / `message` / `session` 没有成败概念，返回 not-applicable，
 * UI 不再给它们挂状态标签。
 */
export function legacyActivityOutcome(input: { kind: ProviderActivityKind; phase: "started" | "completed"; status?: string | undefined; reason?: string | undefined }): ProviderActivityOutcome {
  if (input.kind === "reasoning" || input.kind === "message" || input.kind === "session") return "not-applicable";
  const status = input.status?.trim().toLowerCase();
  if (input.reason || status === "failed" || status === "error" || status === "denied" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "success" || status === "succeeded" || status === "completed" || status === "complete") return "succeeded";
  return input.phase === "started" ? "running" : "unknown";
}

function readActivityKind(value: unknown, itemType: string | undefined): ProviderActivityKind {
  return isActivityKind(value) ? value : legacyActivityKind(itemType ?? "");
}

function readActivityOutcome(value: unknown, fallback: { kind: ProviderActivityKind; phase: "started" | "completed"; status?: string | undefined; reason?: string | undefined }): ProviderActivityOutcome {
  return isActivityOutcome(value) ? value : legacyActivityOutcome(fallback);
}

/** 中立成败 → 条目的展示状态。`not-applicable` 落到 INFO，模板据此**不渲染状态标签**。 */
function outcomeToItemStatus(outcome: ProviderActivityOutcome): ExecutionStreamItem["status"] {
  if (outcome === "not-applicable") return "INFO";
  if (outcome === "running") return "RUNNING";
  if (outcome === "succeeded") return "COMPLETED";
  if (outcome === "failed") return "FAILED";
  return "UNKNOWN";
}

function activityOutcomeDetail(outcome: ProviderActivityOutcome): string {
  // 中文、说人话。此前是 "Provider reported success" / "Provider activity started" ——
  // 那是 Provider 的机械话，读起来像日志，不像"它刚才做了什么"。
  if (outcome === "running") return "执行中";
  if (outcome === "succeeded") return "执行成功";
  if (outcome === "failed") return "执行失败";
  // 没有成败概念的活动不编一句状态文案——它本来就没有状态可报。
  if (outcome === "not-applicable") return "";
  return "结束状态未记录";
}

/** 标题里放不下整条命令，截断到可读长度；完整内容仍可在那条活动上展开。 */
function truncateSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const single = summary.replaceAll(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length > 80 ? `${single.slice(0, 79)}…` : single;
}

/**
 * 把 Provider 的英文诊断翻成人话。**只在显示层做**：journal 里保留原文（那是审计事实），
 * 认不出来的形状原样返回——宁可显示英文，也不要猜错意思。
 */
function localizeProviderReason(reason: string): string {
  const exitCode = /exited with code (\d+)/i.exec(reason);
  if (exitCode?.[1]) return `命令退出码 ${exitCode[1]}`;
  return reason;
}

function projectProviderActivity(entry: ExecutionJournalEntry, taskId: string | undefined, modelStep: number | undefined, loopId: string | undefined): ExecutionStreamItem {
  const payload = entry.payload;
  const itemType = stringValue(payload.itemType);
  const providerItemId = stringValue(payload.providerItemId) ?? stringValue(payload.itemId);
  const serverName = stringValue(payload.serverName);
  const toolName = stringValue(payload.toolName);
  const reason = stringValue(payload.reason);
  const phase = payload.phase === "completed" ? "completed" : "started";
  const providerStatus = stringValue(payload.providerStatus)?.toLowerCase();
  // 中立词表由 gateway 翻译后写进 journal。**消费方不再拿 itemType / providerStatus 判断语义**：
  // 那两个是 Provider 的原生词（Codex 用 completed 表示成功、Claude 用 succeeded），照它们判断
  // 正是"343 条状态未知、0 条成功"的成因。
  const activityKind = readActivityKind(payload.activityKind, itemType);
  const outcome = readActivityOutcome(payload.outcome, { kind: activityKind, phase, status: providerStatus, reason });
  const toolLike = activityKind === "tool" || activityKind === "mcp";
  const status = outcomeToItemStatus(outcome);
  const category = ACTIVITY_KIND_LABELS[activityKind];
  // **说清"这一条到底是什么"**：工具名优先，否则用 Provider 给的 summary（命令原文 / 被改的文件路径）。
  // 没有它，卡片只能显示「命令 · 已完成 · Provider reported success」——说了等于没说，
  // 用户看不出它在干什么。summary 从 2026-10-01 起才记进 journal，老事件仍然只有类别标签。
  const name = toolName ? `${serverName ? `${serverName}/` : ""}${toolName}` : serverName ?? truncateSummary(stringValue(payload.summary));
  const detail = reason ? localizeProviderReason(reason) : activityOutcomeDetail(outcome);
  const missing: string[] = [];
  if (!providerItemId) missing.push("Provider 调用标识未记录");
  if (!itemType) missing.push("Provider 活动类型未记录");
  // 只有"本该有成败却拿不到"才值得标注；`not-applicable`（推理流 / 消息 / 会话）不该被标。
  if (outcome === "unknown") missing.push("调用结束状态未记录");
  return {
    id: providerItemId ? `execution-provider-${providerItemId}` : `execution-provider-missing-${entry.sequence}`,
    kind: toolLike ? "tool" : "activity",
    role: "system",
    title: name ? `${category} · ${name}` : category,
    content: "",
    detail,
    messageType: ACTIVITY_MESSAGE_TYPES[activityKind],
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    activityKind,
    outcome,
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
  if (entry.type === "USER_GUIDANCE") return { id: `execution-guidance-${entry.sequence}`, kind: "user", role: "user", title: "你补充了要求", content: stringValue(payload.content) ?? "", detail: "", status: "COMPLETED", occurredAt: entry.occurredAt, sequence: entry.sequence, messageType: "USER_MESSAGE", ...association };
  if (entry.type === "RUN_CREATED") return activity(entry, "Run 已创建", `Plan ${stringValue(payload.planId) ?? "未记录"} · Revision ${stringValue(payload.revision) ?? "—"}`, "INFO", association);
  if (entry.type === "HOOK_SKIPPED") return activity(entry, "已跳过生命周期钩子", stringValue(payload.hook) ?? "钩子名未记录", "INFO", association);
  if (entry.type === "HOOK_COMPLETED") return activity(entry, "生命周期钩子已完成", stringValue(payload.hook) ?? "生命周期钩子", "COMPLETED", association);
  if (entry.type === "HOOK_FAILED") return activity(entry, "生命周期钩子失败", stringValue(payload.stderr) ?? stringValue(payload.hook) ?? "钩子失败原因未记录", "FAILED", association);
  if (entry.type === "VERIFICATION") {
    const status = stringValue(payload.status);
    const reason = stringValue(payload.reason);
    return activity(entry, "验证", reason ?? VERIFICATION_STATUS_LABELS[status ?? ""] ?? "未记录", status === "PASSED" ? "COMPLETED" : status === "SKIPPED" ? "INFO" : "FAILED", association);
  }
  if (entry.type === "RECOVERY") return activity(entry, "需要恢复", stringValue(payload.reason) ?? stringValue(payload.error) ?? "阻塞原因未记录", "FAILED", { ...association, messageType: "RECOVERY" });
  if (entry.type === "TASK_PROGRESS") {
    const state = stringValue(payload.state);
    // 阻塞与取消是**异常**：无论呈现方式怎么调，它们都要显眼。
    if (state === "BLOCKED") return activity(entry, "Run 已阻塞", stringValue(payload.reason) ?? "阻塞原因未记录", "FAILED", { ...association, messageType: "RECOVERY" });
    if (state === "CANCELLED") return activity(entry, "Run 已取消", stringValue(payload.reason) ?? "已取消", "FAILED", { ...association, messageType: "RECOVERY" });
    if (payload.action === "task-status") return null;
    const event = stringValue(payload.event) ?? "";
    if (event === "continue") return null;
    if (event === "agent.context.compacted") return activity(entry, "上下文已压缩", "模型上下文已刷新", "INFO", { ...association, messageType: "CONTEXT" });
    if (event === "agent.gate.checked") return activity(entry, "执行门禁", `${gateActionLabel(payload.action)}${stringValue(payload.reason) ? ` · ${stringValue(payload.reason)}` : ""}`, payload.action === "blocked" ? "FAILED" : "INFO", { ...association, messageType: "GATE" });
    if (event === "agent.loop.created" || payload.action === "executor_loop_created") return activity(entry, "Executor 已启动", stringValue(payload.loopId) ?? "", "RUNNING", { ...association, messageType: "TURN_STATUS" });
    if (payload.action === "legacy_plan_revision") return activity(entry, "旧版 Plan 修订", stringValue(payload.reason) ?? "使用旧版运行时配置", "INFO", { ...association, messageType: "CONTEXT" });
    if (payload.action === "paused") return activity(entry, "执行已暂停", "等待恢复", "WAITING", { ...association, messageType: "GATE" });
    if (payload.action === "resumed") return activity(entry, "执行已恢复", "", "RUNNING", { ...association, messageType: "GATE" });
    if (["agent.model.completed", "agent.step.started"].includes(event)) return null;
    return activity(entry, "执行活动", event || stringValue(payload.reason) || stringValue(payload.action) || "活动详情未记录", "INFO", { ...association, messageType: "UNCLASSIFIED" });
  }
  if (["MODEL_OUTPUT", "PROVIDER_ACTIVITY", "TOOL_CALL"].includes(entry.type)) return null;
  return activity(entry, entry.type.replaceAll("_", " "), "未记录可展示的执行摘要。", "UNKNOWN", { ...association, messageType: "UNCLASSIFIED", unrecordedFields: ["执行摘要未记录"] });
}

function activity(entry: ExecutionJournalEntry, title: string, detail: string, status: ExecutionStreamItem["status"], metadata: Partial<ExecutionStreamItem> = {}): ExecutionStreamItem {
  // 默认按 Run 级活动处理（创建、钩子、验证）；其余类别由调用点通过 metadata 覆盖。
  return { id: `execution-activity-${entry.sequence}`, kind: "activity", role: "system", title, content: "", detail, status, occurredAt: entry.occurredAt, sequence: entry.sequence, messageType: "RUN_ACTIVITY", ...metadata };
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

/**
 * 完成报告末尾那行"完成了几个任务、改了几个文件"。**它是被解析的**：
 * `sameReportProgress` 靠匹配这行的两个数字判断"这次报告与上次是不是同一个进度"，
 * 从而把重复报告合并成一条。改这里的措辞就要同步改那里的正则，否则合并会静默失效。
 */
function reportProgressSummary(completedTasks: number, changedPaths: number): string {
  return `已完成 ${completedTasks} 个任务 · 改动 ${changedPaths} 个文件`;
}

const REPORT_PROGRESS_PATTERN = /已完成 (\d+) 个任务 · 改动 (\d+) 个文件$/;

function sameReportProgress(previous: string, next: string): boolean {
  const progress = (value: string) => value.match(REPORT_PROGRESS_PATTERN)?.slice(1).join(":") ?? null;
  return progress(previous) !== null && progress(previous) === progress(next);
}

/**
 * 把模型输出拆成标题与正文。
 * `report` 是**判别标志**而不是靠标题字符串判断（此前调用方写的是 `display.title === "Executor report"`，
 * 改一个标题文案就会静默失效）。
 */
function humanizeModelOutput(content: string): { title: string; body: string; report: boolean } | null {
  content = stripTaskProgressMarkers(content);
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  // 普通正文。标题写「执行说明」而不是角色名「Executor」——角色名不告诉读者任何内容，
  // 而这张卡片里放的正是"Executor 在做什么、发现了什么"。
  if (start < 0) return { title: "执行说明", body: content, report: false };
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return { title: "执行报告", body: content.slice(0, start).trim() || "执行报告仍在生成中。", report: true };
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as { completedTaskIds?: unknown; changedPaths?: unknown; report?: unknown };
    const completed = Array.isArray(report.completedTaskIds) ? report.completedTaskIds.filter((id): id is string => typeof id === "string") : [];
    const changedPaths = Array.isArray(report.changedPaths) ? report.changedPaths.filter((path): path is string => typeof path === "string") : [];
    const summary = typeof report.report === "string" ? report.report : "执行报告已记录。";
    return { title: "执行报告", body: `${summary}\n\n${reportProgressSummary(completed.length, changedPaths.length)}`, report: true };
  } catch {
    return { title: "执行报告", body: content.slice(0, start).trim() || "执行报告无法解析。", report: true };
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
  // **开头是残留的标记尾巴**：标记跨了两条事件——上一条的尾巴被上面的规则削掉，剩下的一半就落在
  // 这一条的开头（实见：正文第一行直接铺着 `-progress>{"taskId":"task-1","state":"started"}`）。
  // 上面三条规则只管"结尾"，管不到这种情况。
  // 判据：开头到第一个 `<` 为止的这一截，**以标记的某一段后缀打头**。正常正文几乎不可能命中。
  const firstTagIndex = visible.indexOf("<");
  const head = visible.slice(0, firstTagIndex === -1 ? visible.length : firstTagIndex);
  const fragmentLength = markerFragmentLength(head);
  if (fragmentLength > 0) {
    const afterFragment = head.slice(fragmentLength);
    const rest = visible.slice(head.length);
    // 尾巴后面跟的是标记自带的载荷（JSON，或什么都不剩）→ 连同可能的闭合标记一起去掉；
    // 跟的是正文（实测：`factory-task-progress>` 后直接接"开始执行 task-1…"）→ 只削掉那段尾巴。
    // 两种都得处理：只认"尾巴+JSON"会漏掉后者，而后者正是正文里最扎眼的一行。
    const payloadLike = afterFragment.trim() === "" || afterFragment.trim().startsWith("{");
    if (payloadLike) visible = rest.startsWith(endMarker) ? rest.slice(endMarker.length) : rest;
    else visible = `${afterFragment}${rest}`;
  }
  return visible;
}

/** `head` 开头有多少个字符是任务标记的一段后缀；没有则返回 0。 */
function markerFragmentLength(head: string): number {
  const marker = "<pipeline-factory-task-progress>";
  for (let length = Math.min(head.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.endsWith(head.slice(0, length))) return length;
  }
  return 0;
}
