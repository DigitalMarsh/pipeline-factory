import type { Plan, PlanLifecycleEntry, PlanLifecycleStatus } from "../types";

export const PLAN_LIFECYCLE_STEPS: Array<{ status: PlanLifecycleStatus; label: string }> = [
  { status: "DRAFT", label: "Candidate" },
  { status: "READY", label: "Confirmed" },
  { status: "ENQUEUED", label: "Enqueued" },
  { status: "DISPATCHED", label: "Dispatched" },
  { status: "IN_PROGRESS", label: "Running" },
  { status: "VERIFYING", label: "Verifying" },
  { status: "MERGE_READY", label: "Ready for review" },
  { status: "MERGED", label: "Completed" },
];

export const PLAN_LIFECYCLE_EXCEPTIONS: Array<{ status: PlanLifecycleStatus; label: string }> = [
  { status: "BLOCKED", label: "Blocked" },
  { status: "NEEDS_PLAN_CHANGE", label: "Plan change required" },
  { status: "NEEDS_CONFIGURATION", label: "Needs configuration" },
];

const PLAN_LIFECYCLE_PROGRESS_STATUSES: PlanLifecycleStatus[] = [
  "READY",
  "ENQUEUED",
  "DISPATCHED",
  "IN_PROGRESS",
  "VERIFYING",
  "MERGE_READY",
  "MERGED",
  "BLOCKED",
  "NEEDS_PLAN_CHANGE",
  "NEEDS_CONFIGURATION",
];
const UNCONFIRMED_LIFECYCLE_REASON = "Plan lifecycle is invalid: it reached a later state without a confirmation record.";

export function normalizedLifecycleStatus(status: string, plan?: Plan): PlanLifecycleStatus {
  if (plan?.dispatch?.waitReason === "NEEDS_CONFIGURATION") return "NEEDS_CONFIGURATION";
  if (status === "QUEUED") return "ENQUEUED";
  if (status === "STARTING" || status === "RUNNING") return "IN_PROGRESS";
  if (status === "NEEDS_REVIEW") return "MERGE_READY";
  return status as PlanLifecycleStatus;
}

export function lifecycleLabel(status: PlanLifecycleStatus): string {
  return PLAN_LIFECYCLE_STEPS.find((step) => step.status === status)?.label
    ?? PLAN_LIFECYCLE_EXCEPTIONS.find((step) => step.status === status)?.label
    ?? status.replaceAll("_", " ");
}

function fallbackLifecycle(plan: Plan): PlanLifecycleEntry[] {
  const entries: PlanLifecycleEntry[] = [
    { status: "DRAFT", occurredAt: plan.createdAt ?? null, revision: plan.revision, current: false },
  ];
  if (plan.confirmedAt) entries.push({ status: "READY", occurredAt: plan.confirmedAt, revision: plan.revision, current: false });
  if (plan.queuedAt) entries.push({ status: "ENQUEUED", occurredAt: plan.queuedAt, revision: plan.revision, current: false });
  if (plan.dispatchedAt) entries.push({ status: "DISPATCHED", occurredAt: plan.dispatchedAt, revision: plan.revision, current: false });
  return entries;
}

export function lifecycleEntriesFor(plan: Plan): PlanLifecycleEntry[] {
  const entries = [...(plan.lifecycle?.length ? plan.lifecycle : fallbackLifecycle(plan))];
  const currentStatus = normalizedLifecycleStatus(plan.status, plan);
  if (!entries.some((entry) => entry.status === currentStatus)) {
    entries.push({
      status: currentStatus,
      occurredAt: null,
      revision: plan.revision,
      current: true,
      ...(plan.attentionReason ? { reason: plan.attentionReason } : {}),
      ...(plan.runId ? { runId: plan.runId } : {}),
    });
  }
  const hasConfirmation = Boolean(plan.confirmedAt) || entries.some((entry) => entry.status === "READY");
  const progressedWithoutConfirmation = !hasConfirmation && (
    entries.some((entry) => entry.status !== "DRAFT")
    || PLAN_LIFECYCLE_PROGRESS_STATUSES.includes(currentStatus)
  );
  if (progressedWithoutConfirmation) {
    const draft = entries.find((entry) => entry.status === "DRAFT") ?? { status: "DRAFT" as const, occurredAt: plan.createdAt ?? null, revision: plan.revision, current: false };
    const existingBlocked = entries.find((entry) => entry.status === "BLOCKED");
    return [
      { ...draft, current: false },
      {
        ...(existingBlocked ?? { status: "BLOCKED" as const, occurredAt: null, revision: plan.revision }),
        current: true,
        reason: existingBlocked?.reason ?? plan.attentionReason ?? UNCONFIRMED_LIFECYCLE_REASON,
        ...(existingBlocked?.runId === undefined && plan.runId ? { runId: plan.runId } : {}),
      },
    ];
  }
  const order = new Map<PlanLifecycleStatus, number>([...PLAN_LIFECYCLE_STEPS, ...PLAN_LIFECYCLE_EXCEPTIONS].map((step, index) => [step.status, index]));
  return entries
    .sort((a, b) => (order.get(a.status) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.status) ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => ({ ...entry, current: entry.status === currentStatus }));
}

export function lifecycleEntryFor(plan: Plan, status: PlanLifecycleStatus): PlanLifecycleEntry | undefined {
  return lifecycleEntriesFor(plan).find((entry) => entry.status === status);
}

export function formatLifecycleTime(value: string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}/`;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}/${day} ${hours}:${minutes}`;
}

export function fullLifecycleTime(value: string | null | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function shortExecutionThreadId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 9)}…${id.slice(-8)}` : id;
}
