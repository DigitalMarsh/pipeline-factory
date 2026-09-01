/** Plan/Run/Dispatch 共用的状态标签和 Element Plus 语义色，避免页面各自定义颜色。 */
export type StatusVisual = { label: string; tone: "neutral" | "info" | "warning" | "success" | "danger" };

const STATUS_VISUALS: Record<string, StatusVisual> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  READY: { label: "Ready", tone: "info" },
  QUEUED: { label: "Queued", tone: "warning" },
  WAITING: { label: "Waiting", tone: "warning" },
  WAITING_DEPENDENCY: { label: "Waiting · dependency", tone: "warning" },
  WAITING_CONFLICT: { label: "Waiting · conflict", tone: "warning" },
  WAITING_PROJECT_CAPACITY: { label: "Waiting · project capacity", tone: "warning" },
  WAITING_GLOBAL_CAPACITY: { label: "Waiting · global capacity", tone: "warning" },
  NEEDS_CONFIGURATION: { label: "Needs configuration", tone: "danger" },
  DISPATCHING: { label: "Dispatching", tone: "info" },
  STARTING: { label: "Starting", tone: "info" },
  RUNNING: { label: "Running", tone: "info" },
  IN_PROGRESS: { label: "Running", tone: "info" },
  VERIFYING: { label: "Verifying", tone: "info" },
  NEEDS_REVIEW: { label: "Needs review", tone: "warning" },
  MERGE_READY: { label: "Needs review", tone: "warning" },
  MERGED: { label: "Merged", tone: "success" },
  COMPLETED: { label: "Completed", tone: "success" },
  BLOCKED: { label: "Blocked", tone: "danger" },
  NEEDS_PLAN_CHANGE: { label: "Plan change required", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function statusVisualFor(status: string): StatusVisual {
  return STATUS_VISUALS[status] ?? { label: status.replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase()), tone: "neutral" };
}
