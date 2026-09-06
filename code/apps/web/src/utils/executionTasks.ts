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
};

type Report = TaskProgressPayload;

/** 将冻结任务与执行报告、TASK_PROGRESS journal 合并为稳定的步骤投影。 */
export function projectExecutionTasks(tasks: PlanTask[], journal: ExecutionJournalEntry[], runStatus: string): ExecutionTask[] {
  const projected: ExecutionTask[] = tasks
    .filter((task): task is PlanTask & { id: string } => typeof task.id === "string" && task.id.trim().length > 0)
    .map((task) => ({ ...task, id: task.id, status: "PENDING" as ExecutionTaskStatus, evidenceSequence: null, blockedReason: null }));
  const byId = new Map(projected.map((task) => [task.id, task]));

  const applyReport = (report: Report, sequence: number) => {
    const completed = stringArray(report.completedTaskIds);
    for (const id of completed) {
      const task = byId.get(id);
      if (task) {
        task.status = "DONE";
        task.evidenceSequence = sequence;
        task.blockedReason = null;
      }
    }
    if (typeof report.activeTaskId === "string") {
      const task = byId.get(report.activeTaskId);
      if (task && task.status !== "DONE") {
        task.status = "IN_PROGRESS";
        task.evidenceSequence = sequence;
      }
    }
    if (typeof report.blockedTaskId === "string") {
      const task = byId.get(report.blockedTaskId);
      if (task && task.status !== "DONE") {
        task.status = "BLOCKED";
        task.evidenceSequence = sequence;
        task.blockedReason = typeof report.blockedReason === "string" ? report.blockedReason : null;
      }
    }
  };

  // Newer runs receive a compact, structured TASK_PROGRESS fact.
  for (const entry of journal) {
    if (entry.type === "TASK_PROGRESS" && entry.payload.action === "task-status") applyReport(entry.payload, entry.sequence);
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

  // An active run with no explicit activeTaskId still exposes the next dependency-ready task as the current frontier.
  if (["STARTING", "IN_PROGRESS"].includes(runStatus) && !projected.some((task) => task.status === "IN_PROGRESS")) {
    const next = projected.find((task) => task.status === "PENDING" && task.dependencies.every((dependency) => byId.get(dependency)?.status === "DONE"));
    if (next) next.status = "IN_PROGRESS";
  }
  return projected;
}

export function executionTaskSummary(tasks: ExecutionTask[]): { completed: number; total: number; blocked: number; active: number } {
  return {
    completed: tasks.filter((task) => task.status === "DONE").length,
    total: tasks.length,
    blocked: tasks.filter((task) => task.status === "BLOCKED").length,
    active: tasks.filter((task) => task.status === "IN_PROGRESS").length,
  };
}

export function executionTaskStatusLabel(status: ExecutionTaskStatus): string {
  return ({ PENDING: "Pending", IN_PROGRESS: "In progress", DONE: "Completed", BLOCKED: "Blocked" } as Record<ExecutionTaskStatus, string>)[status];
}

export function executionTaskStatusType(status: ExecutionTaskStatus): "success" | "warning" | "danger" | "info" {
  return ({ PENDING: "info", IN_PROGRESS: "warning", DONE: "success", BLOCKED: "danger" } as const)[status];
}

/** 验证失败属于运行级证据，不会被投影成某个任务的伪造失败状态。 */
export function verificationSummary(verification: VerificationRun | null): string | null {
  if (!verification) return null;
  if (verification.status === "PASSED") return "Verification passed";
  if (verification.status === "SKIPPED") return "Verification skipped";
  return verification.status === "BLOCKED" ? "Verification blocked" : "Verification needs repair";
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
