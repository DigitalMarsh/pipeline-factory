import { describe, expect, it } from "vitest";
import { PlanCompletenessGate, TaskProgressGate } from "./termination-gates.js";

describe("PlanCompletenessGate", () => {
  it("continues when the explicit plan artifact is incomplete", () => {
    const decision = new PlanCompletenessGate().evaluate({ content: "已记录目标，还需要确认验证方式。" });
    expect(decision).toEqual({ action: "continue", reason: expect.stringContaining("完整") });
  });

  it("completes only when the explicit READY artifact is valid", () => {
    const decision = new PlanCompletenessGate().evaluate({
      content: `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify({
        title: "Plan",
        goal: "Build the feature",
        acceptanceCriteria: ["test passes"],
        include: ["src"],
        exclude: [".env"],
        baseBranch: "main",
        baseCommit: "HEAD",
        tasks: [{ id: "task-1", title: "Implement", dependencies: [], status: "READY" }],
        conflictKeys: [],
        executorModelRole: "executor",
        toolPolicy: "executor-scoped-write",
        verificationCommandIds: ["project.test"],
        maxRepairAttempts: 1,
        mergeStrategy: "manual",
        requireHumanMerge: true,
      })}</pipeline-factory-plan>`,
    });
    expect(decision).toEqual({ action: "complete", reason: "PLAN_READY" });
  });
});

describe("TaskProgressGate", () => {
  it("does not allow verification while task or tool work is incomplete", () => {
    const decision = new TaskProgressGate().evaluate({
      reportReady: true,
      allTasksComplete: true,
      hasOpenToolCalls: true,
      hasPendingChangeProposal: false,
      pathsWithinScope: true,
    });
    expect(decision).toEqual({ action: "continue", reason: "OPEN_TOOL_CALLS" });
  });

  it("allows the Executor to hand off only after all pre-verification checks pass", () => {
    const decision = new TaskProgressGate().evaluate({
      reportReady: true,
      allTasksComplete: true,
      hasOpenToolCalls: false,
      hasPendingChangeProposal: false,
      pathsWithinScope: true,
    });
    expect(decision).toEqual({ action: "complete", reason: "READY_FOR_VERIFY" });
  });
});
