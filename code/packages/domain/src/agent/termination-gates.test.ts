/**
 * 测试职责：验证 termination-gates 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { PlanCompletenessGate, TaskProgressGate } from "./termination-gates.js";

describe("PlanCompletenessGate", () => {
  it("continues when the explicit plan artifact is incomplete", () => {
    const decision = new PlanCompletenessGate().evaluate({ content: "已记录目标，还需要确认验证方式。" });
    expect(decision).toMatchObject({
      action: "continue",
      reason: expect.stringContaining("完整"),
      continuationPrompt: expect.stringContaining("验收标准与验证命令"),
    });
  });

  it("returns field diagnostics instead of the former generic V2 failure", () => {
    const artifact = JSON.stringify({
      schemaVersion: 2,
      title: "Broken",
      artifact: { mode: "REPOSITORY_FILE" },
      objective: {},
      design: {},
      scope: { includePaths: [], excludePaths: [] },
      tasks: [],
      dependencies: [],
      conflicts: [],
      execution: {},
      verification: { mode: "PROJECT_DEFAULT" },
      merge: { strategy: "manual", requireHumanMerge: true },
    });
    const content = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${artifact}</pipeline-factory-plan><pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${artifact}</pipeline-factory-plan>`;
    const decision = new PlanCompletenessGate().evaluate({ content });
    expect(decision).toMatchObject({
      action: "continue",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: "artifact.path" }),
        expect.objectContaining({ code: "DUPLICATE" }),
      ]),
    });
    if (decision.action !== "continue") throw new Error("expected continuation");
    expect(decision.continuationPrompt).toContain("artifact.path");
  });

  it("completes only when the explicit READY artifact is valid", () => {
    const decision = new PlanCompletenessGate().evaluate({
      content: `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify({
        schemaVersion: 2,
        title: "Plan",
        artifact: { mode: "REPOSITORY_FILE", path: "src/feature.ts" },
        objective: {
          goal: "Build the feature",
          context: ["现有代码里还没有这个入口"],
          audience: ["开发者"],
          acceptanceCriteria: ["test passes"],
          outOfScope: [],
        },
        design: {
          technicalConstraints: ["沿用现有路由"],
          dataSecurity: ["不引入新的凭据"],
          failureHandling: ["失败时保持原行为"],
          risks: ["回滚：还原这次改动即可"],
        },
        scope: { includePaths: ["src/feature.ts"], excludePaths: [".env"] },
        tasks: [
          {
            id: "task-1",
            title: "Implement",
            dependencies: [],
            status: "READY",
            changes: [{ path: "src/feature.ts", action: "create", detail: "新增入口" }],
          },
        ],
        dependencies: [],
        conflicts: [],
        execution: { maxRepairAttempts: 1 },
        verification: { mode: "NONE" },
        merge: { strategy: "manual", requireHumanMerge: true },
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

  it("keeps an invalid report in the continuation path and blocks scope inspection failures", () => {
    // 这条现在**带一份续跑提示**（见下面「续跑提示」那一组）：报告缺失时同样要说清计划里的任务 id，
    // 否则模型只会原样再报一次。判据仍是"继续"，不是"阻塞"。
    expect(new TaskProgressGate().evaluate({ reportError: "EXECUTION_REPORT_INVALID_OR_MISSING" })).toMatchObject({
      action: "continue",
      reason: "EXECUTION_REPORT_INVALID_OR_MISSING",
    });
    expect(
      new TaskProgressGate().evaluate({
        allTasksComplete: true,
        hasOpenToolCalls: false,
        hasPendingChangeProposal: false,
        reportReady: true,
        pathsWithinScope: false,
        scopeError: "WORKSPACE_SCOPE_CHECK_FAILED",
      }),
    ).toEqual({ action: "blocked", reason: "WORKSPACE_SCOPE_CHECK_FAILED" });
  });

  /**
   * 越界时**要说是哪几个文件**。只回一个 `PATH_OUTSIDE_SCOPE`，界面上那行「为什么停下」就只有
   * 一个码——用户看不出是模型越了界，还是判定器自己错了（实测那次就是后者：中文名被 git 转义）。
   */
  it("把越界的路径一起交给调用方，而不是只回一个码", () => {
    expect(
      new TaskProgressGate().evaluate({
        allTasksComplete: true,
        hasOpenToolCalls: false,
        hasPendingChangeProposal: false,
        reportReady: true,
        pathsWithinScope: false,
        outsidePaths: ["src/other.ts", "doc/需求.md"],
      }),
    ).toEqual({
      action: "blocked",
      reason: "PATH_OUTSIDE_SCOPE",
      diagnostics: ["src/other.ts", "doc/需求.md"],
    });
  });
});

/**
 * 「还差什么」必须写进续跑提示——**这一段是照着实测补上的**。
 *
 * 补充要求那一轮里，模型把额外工作编成了一个计划里没有的 `task-3` 一并报了上来，`allTasksComplete`
 * 于是永远为假。而当时门禁只回一句 `TASKS_INCOMPLETE`，模型不知道自己错在哪，照着同样的内容再报一遍
 * ——**循环跑满 25 步**（约 6k tokens/步）才被人工取消。它必须点名：多报的是哪些、漏报的是哪些。
 */
describe("TaskProgressGate 的续跑提示", () => {
  const promptOf = (context: Parameters<TaskProgressGate["evaluate"]>[0]): string => {
    const decision = new TaskProgressGate().evaluate(context);
    return "continuationPrompt" in decision ? (decision.continuationPrompt ?? "") : "";
  };

  it("**多报了计划外的任务 id 时点名说清**，而不是只回一句 TASKS_INCOMPLETE", () => {
    const prompt = promptOf({ allTasksComplete: false, planTaskIds: ["task-1", "task-2"], missingTaskIds: [], unknownTaskIds: ["task-3"] });

    expect(prompt).toContain("task-3");
    // 计划的**权威清单**也要给出来，否则模型只知道"多了个 task-3"，不知道正确的是什么。
    expect(prompt).toContain("task-1, task-2");
    // 并明说不要重做已完成的工作——否则它会把整轮再跑一遍。
    expect(prompt).toContain("不要重做");
  });

  it("漏报时同样点名", () => {
    expect(
      promptOf({ allTasksComplete: false, planTaskIds: ["task-1", "task-2"], missingTaskIds: ["task-2"], unknownTaskIds: [] }),
    ).toContain("task-2");
  });

  it("整段报告缺失（reportError）时给的是同一份提示", () => {
    expect(
      promptOf({
        reportError: "EXECUTION_REPORT_INVALID_OR_MISSING",
        planTaskIds: ["task-1"],
        missingTaskIds: ["task-1"],
        unknownTaskIds: [],
      }),
    ).toContain("task-1");
  });

  it("全部满足时不带提示，直接完成", () => {
    const decision = new TaskProgressGate().evaluate({
      allTasksComplete: true,
      hasOpenToolCalls: false,
      hasPendingChangeProposal: false,
      reportReady: true,
      pathsWithinScope: true,
      planTaskIds: ["task-1"],
      missingTaskIds: [],
      unknownTaskIds: [],
    });
    expect(decision).toEqual({ action: "complete", reason: "READY_FOR_VERIFY" });
  });
});
