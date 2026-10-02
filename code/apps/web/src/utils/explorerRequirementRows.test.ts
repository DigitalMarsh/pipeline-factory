import { describe, expect, it } from "vitest";
import type { ExplorerPlan, Plan, Run } from "../types";
import { projectExplorerRequirementRows } from "./explorerRequirementRows";

function requirement(id: string, ordinal: number, overrides: Partial<ExplorerPlan> = {}): ExplorerPlan {
  return {
    id,
    explorerThreadId: "thread-a",
    projectId: "project-a",
    ordinal,
    title: `需求 ${ordinal}`,
    titleSource: "AUTO",
    titleStatus: "GENERATED",
    messageCount: 1,
    latestUserMessageSummary: null,
    exploration: { status: "INCOMPLETE", missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null },
    candidatePlanId: null,
    lastAssessedTurnId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function plan(explorerPlanId: string, status: Plan["status"], overrides: Partial<Plan> = {}): Plan {
  return {
    id: `plan-${explorerPlanId}`,
    planId: `plan-${explorerPlanId}`,
    explorerPlanId,
    title: `Plan ${explorerPlanId}`,
    revision: 1,
    status,
    projectId: "project-a",
    sourceExplorerThreadId: "thread-a",
    queuedAt: null,
    dispatchedAt: null,
    runId: null,
    lastEventAt: "2026-09-01T00:00:00.000Z",
    attentionReason: null,
    ...overrides,
  };
}

function run(planId: string, status: string, overrides: Partial<Run> = {}): Run {
  return {
    id: `run-${planId}`,
    projectId: "project-a",
    planId,
    planRevision: 1,
    status,
    branch: "codex/test",
    workspacePath: null,
    baseCommit: "abc123",
    executionThreadId: `execution-${planId}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("projectExplorerRequirementRows", () => {
  it("sorts by requirement ordinal and keeps plans scoped to their ExplorerPlan", () => {
    const rows = projectExplorerRequirementRows(
      [requirement("req-2", 2), requirement("req-1", 1)],
      [plan("req-2", "READY")],
      [],
    );

    expect(rows.map((row) => row.explorerPlan.id)).toEqual(["req-1", "req-2"]);
    expect(rows[0]?.plan).toBeNull();
    expect(rows[0]?.planStatus.label).toBe("探索中");
    expect(rows[0]?.taskStatus.label).toBe("—");
    expect(rows[1]?.planStatus.label).toBe("已确认");
    expect(rows[1]?.taskStatus.label).toBe("待入队");
  });

  it("maps unanswered questions and generated drafts to their user-facing states", () => {
    const rows = projectExplorerRequirementRows([
      requirement("waiting", 1, { runtimeStatus: "WAITING_FOR_INPUT" }),
      requirement("candidate", 2, { candidatePlanId: "plan-candidate" }),
    ], [plan("candidate", "DRAFT")], []);

    expect(rows[0]?.planStatus.label).toBe("待回答问题");
    expect(rows[1]?.planStatus.label).toBe("待确认");
    expect(rows[1]?.taskStatus.label).toBe("—");
  });

  it("maps enqueue, active run, review and completed run states", () => {
    const rows = projectExplorerRequirementRows(
      [requirement("queued", 1), requirement("running", 2), requirement("blocked", 3), requirement("review", 4), requirement("done", 5)],
      [
        plan("queued", "ENQUEUED"),
        plan("running", "IN_PROGRESS", { runId: "run-plan-running" }),
        plan("blocked", "BLOCKED"),
        plan("review", "MERGE_READY", { runId: "run-plan-review" }),
        plan("done", "MERGED", { runId: "run-plan-done" }),
      ],
      [run("plan-running", "RUNNING"), run("plan-review", "MERGE_READY"), run("plan-done", "MERGED")],
    );

    expect(rows.map((row) => row.planStatus.label)).toEqual(["已确认", "已确认", "已确认", "已确认", "已确认"]);
    expect(rows.map((row) => row.taskStatus.label)).toEqual(["已入队/已派发", "运行中", "待处理", "待处理", "运行完"]);
  });

  it("marks confirmed conversation-only Plans as requiring attention instead of queueing", () => {
    // 前三行分别只给 resolvedContract / generatedSpec 一层声明（旧用例里还有一层 V1 `contract`，
    // 那份镜像已删）。第四行是仓库文件产物，作为对照。
    const rows = projectExplorerRequirementRows(
      [requirement("contract", 1), requirement("resolved", 2), requirement("generated", 3), requirement("repository", 4)],
      [
        plan("contract", "READY", { resolvedContract: { artifact: { mode: "CONVERSATION" } } as NonNullable<Plan["resolvedContract"]> }),
        plan("resolved", "READY", { resolvedContract: { artifact: { mode: "CONVERSATION" } } as NonNullable<Plan["resolvedContract"]> }),
        plan("generated", "READY", { generatedSpec: { artifact: { mode: "CONVERSATION" } } as NonNullable<Plan["generatedSpec"]> }),
        plan("repository", "READY", { resolvedContract: { artifact: { mode: "REPOSITORY_FILE" } } as NonNullable<Plan["resolvedContract"]> }),
      ],
      [],
    );

    expect(rows.map((row) => row.taskStatus.label)).toEqual(["待处理", "待处理", "待处理", "待入队"]);
    expect(rows.slice(0, 3).every((row) => row.taskStatus.tone === "attention")).toBe(true);
  });

  it("associates a candidate by candidatePlanId and exposes unrecognized states", () => {
    const candidate = plan("unused", "DRAFT", { id: "candidate-id", planId: "candidate-id", explorerPlanId: undefined });
    const unknownPlan = plan("unknown", "READY" as Plan["status"]);
    (unknownPlan as { status: string }).status = "SOMETHING_NEW";
    const rows = projectExplorerRequirementRows([
      requirement("candidate", 1, { candidatePlanId: "candidate-id" }),
      requirement("unknown", 2),
      requirement("unknown-run", 3),
    ], [candidate, unknownPlan, plan("unknown-run", "READY", { runId: "run-unknown-run" })], [run("plan-unknown-run", "PAUSED")]);

    expect(rows[0]?.plan?.id).toBe("candidate-id");
    expect(rows[0]?.planStatus.label).toBe("待确认");
    expect(rows[1]?.planStatus.label).toBe("未知状态：SOMETHING_NEW");
    expect(rows[2]?.taskStatus.label).toBe("未知状态：PAUSED");
  });
});
