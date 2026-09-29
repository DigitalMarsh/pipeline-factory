/**
 * 测试职责：验证项目「今日活动」投影的分组、按本地日切分与跨日识别。
 * 设计说明：事件时间由 store.now() 决定（真实时间），所以"今天"那几组直接构造当天的状态变更；
 *   跨日与"非今天"两组用显式时间戳（Run.startedAt / 传入过去的 date）。
 * 维护提示：新增活动分组时同时补两条断言——组里有它、以及**别的日期没有它**。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, updatePlanStatus } from "@pipeline-factory/domain";
import { dailyActivity, localDayBounds, localToday } from "./activity.js";

function fixture() {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  const project = projects.create({ id: "project-activity", name: "Activity", repoRoot: "/repo/activity", defaultBranch: "main", worktreeRoot: "/tmp/activity-worktrees" });
  const plans = new PlanService(store, projects);
  return { store, projects, project, plans };
}

describe("daily activity projection", () => {
  it("groups today's execution, merge and block facts by the day they happened", () => {
    const { store, projects, project, plans } = fixture();
    const executed = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Executed plan" });
    const merged = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Merged plan" });
    const blocked = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Blocked plan" });

    updatePlanStatus(store, store.getPlan(executed.id)!, { status: "MERGE_READY" });
    updatePlanStatus(store, store.getPlan(merged.id)!, { status: "MERGED" });
    updatePlanStatus(store, store.getPlan(blocked.id)!, { status: "BLOCKED", attentionReason: "verification failed" }, "verification failed");

    const activity = dailyActivity(store, projects, project.id);

    expect(activity).toMatchObject({ projectId: project.id, date: localToday(), retentionDays: 0 });
    expect(activity.executedToday.map((entry) => entry.planTitle)).toEqual(["Executed plan"]);
    expect(activity.mergedToday.map((entry) => entry.planTitle)).toEqual(["Merged plan"]);
    expect(activity.failedToday.map((entry) => entry.planTitle)).toEqual(["Blocked plan"]);
    expect(activity.failedToday[0]?.reason).toBe("verification failed");
    // 执行完成与人工合并是两个时点：日报必须分开算，否则"跑了但没合"的部分整个丢掉。
    expect(activity.executedToday.map((entry) => entry.planId)).not.toContain(merged.id);
  });

  it("keeps a Plan's first entry into a state and reports only runs started on an earlier day as cross-day", () => {
    const { store, projects, project, plans } = fixture();
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Flapping plan" });
    updatePlanStatus(store, store.getPlan(plan.id)!, { status: "MERGE_READY" });
    // 同日再次进入同一状态（例如被退回后重新验证通过）：日报里仍然只出现一次。
    updatePlanStatus(store, store.getPlan(plan.id)!, { status: "BLOCKED" });
    updatePlanStatus(store, store.getPlan(plan.id)!, { status: "MERGE_READY" });

    store.saveRun({ id: "run-old", projectId: project.id, planId: plan.id, planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-old", workspacePath: "/tmp/run-old", baseCommit: "abc", executionThreadId: "thread-old", createdAt: "2020-01-01T00:00:00.000Z", startedAt: "2020-01-01T00:00:00.000Z" });
    store.saveRun({ id: "run-today", projectId: project.id, planId: plan.id, planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-today", workspacePath: "/tmp/run-today", baseCommit: "abc", executionThreadId: "thread-today", createdAt: new Date().toISOString(), startedAt: new Date().toISOString() });

    const activity = dailyActivity(store, projects, project.id);

    expect(activity.executedToday).toHaveLength(1);
    // 跨日运行只指"今天之前就开始了、现在还在跑"的那一个。
    expect(activity.runningAcrossDays.map((entry) => entry.runId)).toEqual(["run-old"]);
  });

  it("returns empty groups for another day and rejects a date that is not a real calendar day", () => {
    const { store, projects, project, plans } = fixture();
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Today only" });
    updatePlanStatus(store, store.getPlan(plan.id)!, { status: "MERGED" });

    expect(dailyActivity(store, projects, project.id, "2020-01-02").mergedToday).toEqual([]);
    expect(dailyActivity(store, projects, project.id, localToday()).mergedToday).toHaveLength(1);
    // Date 会把 2026-02-31 静默滚到 3 月；拒绝这种输入而不是汇报一个别的一天。
    expect(() => dailyActivity(store, projects, project.id, "2026-02-31")).toThrow(/real local calendar day/);
    expect(localDayBounds("2026-02-31")).toBeNull();
  });

  it("refuses an unknown Project instead of reporting an empty day", () => {
    const { store, projects } = fixture();
    expect(() => dailyActivity(store, projects, "project-missing")).toThrow(/not found/i);
  });
});
