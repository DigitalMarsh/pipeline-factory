import { describe, expect, it } from "vitest";
import type { Plan } from "../types";
import { formatLifecycleTime, lifecycleEntriesFor, normalizedLifecycleStatus } from "./planLifecycle";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    title: "Lifecycle plan",
    revision: 3,
    status: "DISPATCHED",
    projectId: "project-1",
    sourceExplorerThreadId: "explorer-1",
    createdAt: "2026-09-19T01:00:00.000Z",
    confirmedAt: "2026-09-19T01:05:00.000Z",
    queuedAt: "2026-09-19T01:06:00.000Z",
    dispatchedAt: "2026-09-19T01:07:00.000Z",
    runId: null,
    lastEventAt: "2026-09-19T01:07:00.000Z",
    attentionReason: null,
    ...overrides,
  };
}

describe("plan lifecycle presentation", () => {
  it("uses the fixed lifecycle order and keeps unknown times empty", () => {
    const entries = lifecycleEntriesFor(plan({ lifecycle: [
      { status: "DISPATCHED", occurredAt: null, revision: 3, current: true },
      { status: "DRAFT", occurredAt: "2026-09-19T01:00:00.000Z", revision: 3, current: false },
    ] }));

    expect(entries.map((entry) => entry.status)).toEqual(["DRAFT", "DISPATCHED"]);
    expect(entries.find((entry) => entry.status === "DISPATCHED")?.occurredAt).toBeNull();
    expect(entries.find((entry) => entry.status === "DISPATCHED")?.current).toBe(true);
  });

  it("keeps an exception after the normal lifecycle and marks it current", () => {
    const entries = lifecycleEntriesFor(plan({ status: "BLOCKED", attentionReason: "Verification failed", lifecycle: [
      { status: "DRAFT", occurredAt: "2026-09-19T01:00:00.000Z", revision: 3, current: false },
      { status: "IN_PROGRESS", occurredAt: "2026-09-19T01:10:00.000Z", revision: 3, current: false },
      { status: "BLOCKED", occurredAt: "2026-09-19T01:11:00.000Z", revision: 3, current: true, reason: "Verification failed" },
    ] }));

    expect(entries.at(-1)?.status).toBe("BLOCKED");
    expect(entries.at(-1)?.current).toBe(true);
    expect(entries.at(-1)?.reason).toBe("Verification failed");
  });

  it("quarantines downstream states that have no confirmation evidence", () => {
    expect(normalizedLifecycleStatus("QUEUED")).toBe("ENQUEUED");
    expect(normalizedLifecycleStatus("STARTING")).toBe("IN_PROGRESS");
    expect(normalizedLifecycleStatus("VERIFYING")).toBe("VERIFYING");
    const entries = lifecycleEntriesFor(plan({ status: "MERGE_READY", confirmedAt: null, queuedAt: "2026-09-19T01:02:00.000Z", dispatchedAt: "2026-09-19T01:03:00.000Z", createdAt: "" }));
    expect(entries.map((entry) => entry.status)).toEqual(["DRAFT", "BLOCKED"]);
    expect(entries.at(-1)).toMatchObject({ current: true, occurredAt: null });
  });

  it("formats current-year times compactly and includes another year", () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    const currentYearDate = new Date("2026-09-09T06:23:00.000Z");
    const currentYearTime = `${currentYearDate.getMonth() + 1}/${currentYearDate.getDate()} ${String(currentYearDate.getHours()).padStart(2, "0")}:${String(currentYearDate.getMinutes()).padStart(2, "0")}`;
    const previousYearDate = new Date("2025-09-09T06:23:00.000Z");
    const previousYearTime = `${previousYearDate.getFullYear()}/${previousYearDate.getMonth() + 1}/${previousYearDate.getDate()} ${String(previousYearDate.getHours()).padStart(2, "0")}:${String(previousYearDate.getMinutes()).padStart(2, "0")}`;
    expect(formatLifecycleTime("2026-09-09T06:23:00.000Z", now)).toBe(currentYearTime);
    expect(formatLifecycleTime("2025-09-09T06:23:00.000Z", now)).toBe(previousYearTime);
    expect(formatLifecycleTime(null, now)).toBe("—");
  });
});
