/**
 * 模块职责：把冻结 Plan 任务和 ExecutionThread 事实投影成用户可读的执行步骤。
 *
 * 维护提示：这里只展示已持久化、可校验的任务事实；不要从普通模型文本猜测完成状态。
 */
import type { ExecutionTask, ExecutionTaskStatus, PlanTask, VerificationRun } from "../types";
import type { ExecutionJournalEntry } from "./executionStream";

const REPORT_START = "<pipeline-factory-execution-report>";
const REPORT_END = "</pipeline-factory-execution-report>";

type TaskProgressPayload = {
  completedTaskIds?: unknown;
  activeTaskId?: unknown;
  blockedTaskId?: unknown;
  blockedReason?: unknown;
  taskId?: unknown;
  state?: unknown;
  reason?: unknown;
};

type Report = TaskProgressPayload;

/** 将冻结任务与执行报告、TASK_PROGRESS journal 合并为稳定的步骤投影。 */
export function projectExecutionTasks(tasks: PlanTask[], journal: ExecutionJournalEntry[], runStatus: string): ExecutionTask[] {
  const projected: ExecutionTask[] = tasks
    .filter((task): task is PlanTask & { id: string } => typeof task.id === "string" && task.id.trim().length > 0)
    .map((task) => ({ ...task, id: task.id, status: "PENDING" as ExecutionTaskStatus, evidenceSequence: null, blockedReason: null }));
  const byId = new Map(projected.map((task) => [task.id, task]));
  let hasTaskProgressFact = false;

  const applyReport = (report: Report, sequence: number) => {
    const completed = stringArray(report.completedTaskIds);
    for (const id of completed) {
      const task = byId.get(id);
      if (task) {
        hasTaskProgressFact = true;
        task.status = "DONE";
        task.evidenceSequence = sequence;
        task.blockedReason = null;
      }
    }
    if (typeof report.activeTaskId === "string") {
      const task = byId.get(report.activeTaskId);
      if (task && task.status !== "DONE") {
        hasTaskProgressFact = true;
        task.status = "IN_PROGRESS";
        task.evidenceSequence = sequence;
      }
    }
    if (typeof report.blockedTaskId === "string") {
      const task = byId.get(report.blockedTaskId);
      if (task && task.status !== "DONE") {
        hasTaskProgressFact = true;
        task.status = "BLOCKED";
        task.evidenceSequence = sequence;
        task.blockedReason = typeof report.blockedReason === "string" ? report.blockedReason : null;
      }
    }
  };

  // Newer runs receive a compact, structured TASK_PROGRESS fact.
  for (const entry of journal) {
    if (entry.type !== "TASK_PROGRESS") continue;
    if (entry.payload.action === "task-status") {
      applyReport(entry.payload, entry.sequence);
      continue;
    }
    if (entry.payload.action === "task-lifecycle" && typeof entry.payload.taskId === "string") {
      const task = byId.get(entry.payload.taskId);
      if (!task) continue;
      const state = entry.payload.state;
      if (state === "IN_PROGRESS" || state === "DONE" || state === "BLOCKED") {
        hasTaskProgressFact = true;
        task.status = state;
        task.evidenceSequence = entry.sequence;
        task.blockedReason = state === "BLOCKED" ? typeof entry.payload.reason === "string" ? entry.payload.reason : null : null;
      }
    }
  }

  // Older runs only contain the report protocol in MODEL_OUTPUT. Keep this as a read-only compatibility path.
  let modelText = "";
  for (const entry of journal) {
    if (entry.type === "MODEL_OUTPUT") {
      modelText += typeof entry.payload.text === "string" ? entry.payload.text : "";
      continue;
    }
    if (modelText) {
      const report = parseReport(modelText);
      if (report) applyReport(report, entry.sequence - 1);
      modelText = "";
    }
  }
  if (modelText) {
    const report = parseReport(modelText);
    if (report) applyReport(report, journal.at(-1)?.sequence ?? 0);
  }

  // Missing structured task facts stay explicit; ordinary model text and Run status do not assign a task state.
  if (!hasTaskProgressFact && !["QUEUED", "STARTING"].includes(runStatus)) {
    for (const task of projected) task.status = "UNKNOWN";
  }
  return projected;
}

export function executionTaskSummary(tasks: ExecutionTask[]): { completed: number; total: number; blocked: number; active: number; unknown: number } {
  return {
    completed: tasks.filter((task) => task.status === "DONE").length,
    total: tasks.length,
    blocked: tasks.filter((task) => task.status === "BLOCKED").length,
    active: tasks.filter((task) => task.status === "IN_PROGRESS").length,
    unknown: tasks.filter((task) => task.status === "UNKNOWN").length,
  };
}

export function executionTaskStatusLabel(status: ExecutionTaskStatus): string {
  return ({ PENDING: "待处理", IN_PROGRESS: "进行中", DONE: "已完成", BLOCKED: "已阻塞", UNKNOWN: "状态未知" } as Record<ExecutionTaskStatus, string>)[status];
}

export function executionTaskStatusType(status: ExecutionTaskStatus): "success" | "warning" | "danger" | "info" {
  return ({ PENDING: "info", IN_PROGRESS: "warning", DONE: "success", BLOCKED: "danger", UNKNOWN: "info" } as const)[status];
}

/** 验证失败属于运行级证据，不会被投影成某个任务的伪造失败状态。 */
export function verificationSummary(verification: VerificationRun | null): string | null {
  if (!verification) return null;
  if (verification.status === "PASSED") return "验证通过";
  if (verification.status === "SKIPPED") return "验证已跳过";
  return verification.status === "BLOCKED" ? "验证被阻塞" : "验证需要修复";
}

function parseReport(content: string): Report | null {
  const start = content.lastIndexOf(REPORT_START);
  if (start < 0) return null;
  const jsonStart = start + REPORT_START.length;
  const end = content.indexOf(REPORT_END, jsonStart);
  if (end < 0) return null;
  try {
    const value = JSON.parse(content.slice(jsonStart, end).trim()) as Report;
    return Array.isArray(value.completedTaskIds) && value.completedTaskIds.every((id) => typeof id === "string") ? value : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
