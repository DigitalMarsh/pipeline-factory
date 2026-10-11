import { describe, expect, it } from "vitest";
import type { ExplorerPlan, MergeRequest, Plan, Run } from "../types";
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

/** 一条 Run 上的合并请求；`detectedTargetCommit` 就是对账只读观察到的主干提交。 */
function mergeRequest(overrides: Partial<MergeRequest> = {}): MergeRequest {
  return {
    id: "merge-review",
    runId: "run-plan-review",
    planId: "plan-review",
    sourceCommit: "abc123",
    targetBranch: "main",
    status: "OPEN",
    humanConfirmationRequired: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    mergedAt: null,
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
    const rows = projectExplorerRequirementRows([requirement("req-2", 2), requirement("req-1", 1)], [plan("req-2", "READY")], []);

    expect(rows.map((row) => row.explorerPlan.id)).toEqual(["req-1", "req-2"]);
    expect(rows[0]?.plan).toBeNull();
    expect(rows[0]?.planStatus.label).toBe("探索中");
    expect(rows[0]?.taskStatus.label).toBe("—");
    expect(rows[1]?.planStatus.label).toBe("已确认");
    expect(rows[1]?.taskStatus.label).toBe("待入队");
  });

  it("maps unanswered questions and generated drafts to their user-facing states", () => {
    const rows = projectExplorerRequirementRows(
      [
        requirement("waiting", 1, { runtimeStatus: "WAITING_FOR_INPUT" }),
        requirement("candidate", 2, { candidatePlanId: "plan-candidate" }),
      ],
      [plan("candidate", "DRAFT")],
      [],
    );

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
    expect(rows.map((row) => row.taskStatus.label)).toEqual(["已入队/已派发", "运行中", "待处理", "待合并", "已合并"]);
  });

  /**
   * **重新规划之后，行要跟着新的候选方案走。** 探索者新建的候选修订号从 1 开始，而旧的那份可能已经
   * V2——只按修订号取最高，行与抽屉会一直显示旧的（实测：需求10 重新规划后停在旧的 BLOCKED V2 上，
   * 新候选只能从聊天里那张方案卡确认）。
   */
  it("prefers the requirement's own candidate plan over a higher-revision older plan", () => {
    const rows = projectExplorerRequirementRows(
      [requirement("r", 10, { candidatePlanId: "plan-fresh" })],
      [
        plan("r", "MERGE_READY", { id: "plan-old", planId: "plan-old", revision: 2, runId: "run-old" }),
        plan("r", "DRAFT", { id: "plan-fresh", planId: "plan-fresh", revision: 1 }),
      ],
      [run("plan-old", "MERGE_READY")],
    );

    expect(rows[0]?.plan?.id).toBe("plan-fresh");
    expect(rows[0]?.planStatus.label).toBe("待确认");
    expect(rows[0]?.taskStatus.label).toBe("—");
  });

  /**
   * 确认合并之后 Run 会**停在 `MERGE_READY`**（`RunStatus` 里没有 `MERGED`），所以那一格必须
   * 先看 Plan：否则一条已经并进主干的 Run 会永远显示「待合并」。
   */
  it("says 已合并 once the Plan is merged, even though the Run stays MERGE_READY", () => {
    const rows = projectExplorerRequirementRows(
      [requirement("r", 1)],
      [plan("r", "MERGED", { runId: "run-r" })],
      [run("r", "MERGE_READY")],
    );

    expect(rows[0]?.taskStatus.label).toBe("已合并");
  });

  /**
   * 「待合并」和「待合并 · 已检测到」的差别就是**要不要人去点确认合并**：对账只读观察主干，看到
   * 里面已经有这份提交时把它记在合并请求上（`detectedTargetCommit`）。界面必须把这件事说出来
   * ——只写"待合并"的话，"等主干"和"等你确认"看起来一模一样。
   */
  it("对账已经看到主干里有那份提交时，那一格要写出来", () => {
    const detected = projectExplorerRequirementRows(
      [requirement("review", 1)],
      [plan("review", "MERGE_READY", { runId: "run-plan-review", mergeRequest: mergeRequest({ detectedTargetCommit: "75a153f8" }) })],
      [run("plan-review", "MERGE_READY")],
    );
    expect(detected[0]?.taskStatus.label).toBe("待合并 · 已检测到");

    // 对账还没看到（请求上没有 detectedTargetCommit）：只说待合并。
    const pending = projectExplorerRequirementRows(
      [requirement("review", 1)],
      [plan("review", "MERGE_READY", { runId: "run-plan-review", mergeRequest: mergeRequest() })],
      [run("plan-review", "MERGE_READY")],
    );
    expect(pending[0]?.taskStatus.label).toBe("待合并");

    // 已经作废（SUPERSEDED）的那条不算数——它指向的 commit 已经不是最新的了。
    const superseded = projectExplorerRequirementRows(
      [requirement("review", 1)],
      [
        plan("review", "MERGE_READY", {
          runId: "run-plan-review",
          mergeRequest: mergeRequest({ status: "SUPERSEDED", detectedTargetCommit: "75a153f8" }),
        }),
      ],
      [run("plan-review", "MERGE_READY")],
    );
    expect(superseded[0]?.taskStatus.label).toBe("待合并");
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
        plan("repository", "READY", {
          resolvedContract: { artifact: { mode: "REPOSITORY_FILE" } } as NonNullable<Plan["resolvedContract"]>,
        }),
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
    const unknownRun = run("plan-unknown-run", "SOMETHING_NEW" as Run["status"]);
    const rows = projectExplorerRequirementRows(
      [requirement("candidate", 1, { candidatePlanId: "candidate-id" }), requirement("unknown", 2), requirement("unknown-run", 3)],
      [candidate, unknownPlan, plan("unknown-run", "READY", { runId: "run-unknown-run" })],
      [unknownRun],
    );

    expect(rows[0]?.plan?.id).toBe("candidate-id");
    expect(rows[0]?.planStatus.label).toBe("待确认");
    expect(rows[1]?.planStatus.label).toBe("未知状态：SOMETHING_NEW");
    // 只有**真的认不出来**才落这条兜底（`RunStatus` 是封闭联合，11 个取值下面那条用例逐个钉住）。
    expect(rows[2]?.taskStatus.label).toBe("未知状态：SOMETHING_NEW");
  });

  it("**RunStatus 的每个取值都接住了**，不漏成「未知状态：RECOVERING」", () => {
    // 曾经漏了四个（其中 `NEEDS_PLAN_CHANGE` 此后退役）：`READY_FOR_VERIFY` / `STALE` / **`RECOVERING`**。
    // 最后一个尤其要紧——启动恢复把被中断的 Run 交回给人决定时，它就是需求清单上唯一的现场证据，
    // 而它此前显示成"未知状态：RECOVERING"这种半截枚举值。
    const cases: Array<[Run["status"], string]> = [
      ["QUEUED", "运行中"],
      ["STARTING", "运行中"],
      ["IN_PROGRESS", "运行中"],
      ["VERIFYING", "运行中"],
      ["READY_FOR_VERIFY", "待验证"],
      ["MERGE_READY", "待合并"],
      ["BLOCKED", "待处理"],
      ["STALE", "待处理"],
      ["RECOVERING", "需要恢复"],
      ["CANCELLED", "待处理"],
    ];
    for (const [status, expected] of cases) {
      const rows = projectExplorerRequirementRows(
        [requirement("r", 1)],
        [plan("r", "IN_PROGRESS", { runId: `run-r` })],
        [run("r", status)],
      );
      expect(rows[0]?.taskStatus.label, `Run 状态 ${status}`).toBe(expected);
    }
  });
});
