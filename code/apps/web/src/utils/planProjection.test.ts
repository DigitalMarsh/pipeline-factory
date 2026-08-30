import { describe, expect, it } from "vitest";
import { normalizePlanProjection } from "./planProjection";
import type { ExplorerThread, Plan } from "../types";

const explorer: ExplorerThread = {
  id: "explorer-1",
  projectId: "project-1",
  title: "New exploration",
  createdAt: "2026-08-29T05:45:15.000Z",
  titleSource: "AUTO",
  titleStatus: "PLACEHOLDER",
  contextMode: "FRESH",
  originThreadId: null,
  parentThreadId: null,
  state: "ACTIVE",
  messageCount: 2,
  summaryRef: null,
  lastActivityAt: "2026-08-29T10:00:00.000Z",
  exploration: { status: "READY", missing: [], completed: [], candidatePlanId: "plan-1", lastAssessedTurnId: "turn-1" },
};

const plan = (id: string, status: Plan["status"]): Plan => ({
  id,
  title: id,
  revision: 1,
  status,
  projectId: "project-1",
  sourceExplorerThreadId: "explorer-1",
  queuedAt: status === "QUEUED" ? "2026-08-29T10:01:00.000Z" : null,
  runId: null,
  lastEventAt: "2026-08-29T10:00:00.000Z",
  attentionReason: null,
});

describe("plan projection", () => {
  it("keeps the generated candidate visible and removes duplicate dispatched entries", () => {
    const projection = normalizePlanProjection(explorer, plan("plan-1", "READY"), [plan("plan-1", "QUEUED"), plan("plan-2", "MERGED")]);

    expect(projection.candidate?.id).toBe("plan-1");
    expect(projection.dispatched.map((item) => item.id)).toEqual(["plan-2"]);
  });

  it("keeps an unqueued READY plan as the current candidate after refresh", () => {
    const projection = normalizePlanProjection(explorer, null, [plan("plan-1", "READY"), plan("plan-2", "QUEUED")]);

    expect(projection.candidate?.id).toBe("plan-1");
    expect(projection.dispatched.map((item) => item.id)).toEqual(["plan-2"]);
  });
});
