/**
 * 测试职责：验证项目「今日活动」投影的分组、按本地日切分与跨日识别。
 * 设计说明：事件时间由 store.now() 决定（真实时间），所以"今天"那几组直接构造当天的状态变更；
 *   跨日与"非今天"两组用显式时间戳（Run.startedAt / 传入过去的 date）。
 * 维护提示：新增活动分组时同时补两条断言——组里有它、以及**别的日期没有它**。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, updatePlanStatus, planContractFixture } from "@pipeline-factory/domain";
import { dailyActivity, localDayBounds, localToday } from "./activity.js";

/**
 * 把 Plan 沿**合法路径**推到目标状态。
 *
 * 转换表现在被强制（`updatePlanStatus` 会拒掉非法边），所以夹具也要走正路——
 * 本文件测的是"日报怎么读事件"，不是"能不能把状态直接改过去"。
 * `BLOCKED` 不在这条路径上：它是个"从任意非终态进入"的入口（见 `PLAN_STATUS_RESET_TARGETS`），
 * 从哪儿跳过去都合法。
 */
const PLAN_STATUS_PATH = ["READY", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED"] as const;

function walkPlanTo(store: InMemoryPipelineStore, planId: string, target: (typeof PLAN_STATUS_PATH)[number]): void {
  for (const status of PLAN_STATUS_PATH) {
    const plan = store.getPlan(planId);
    if (!plan || plan.status === target) return;
    updatePlanStatus(store, plan, { status });
  }
}

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
    const executed = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Executed plan", resolvedContract: planContractFixture({ store, projectId: project.id, title: "Executed plan" }) });
    const merged = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Merged plan", resolvedContract: planContractFixture({ store, projectId: project.id, title: "Merged plan" }) });
    const blocked = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Blocked plan", resolvedContract: planContractFixture({ store, projectId: project.id, title: "Blocked plan" }) });

    walkPlanTo(store, executed.id, "MERGE_READY");
    walkPlanTo(store, merged.id, "MERGED");
    updatePlanStatus(store, store.getPlan(blocked.id)!, { status: "BLOCKED", attentionReason: "verification failed" }, "verification failed");

    const activity = dailyActivity(store, projects, project.id);

    expect(activity).toMatchObject({ projectId: project.id, date: localToday(), retentionDays: 0 });
    // 已合并的那份**也在** executedToday 里：它在合并之前确实执行完成过（转换表里 MERGE_READY → MERGED 是
    // 进 MERGED 的唯一一条边）。两个分组仍然分开算——各自的时点与事件不同，下面那条 mergedToday 就是证据。
    expect(activity.executedToday.map((entry) => entry.planTitle)).toEqual(["Executed plan", "Merged plan"]);
    expect(activity.mergedToday.map((entry) => entry.planTitle)).toEqual(["Merged plan"]);
    expect(activity.failedToday.map((entry) => entry.planTitle)).toEqual(["Blocked plan"]);
    expect(activity.failedToday[0]?.reason).toBe("verification failed");
    // 执行完成与人工合并是两个时点，两个分组各自读各自的事件——"跑了但没合"的那部分不能丢，
    // 上面那条 `executedToday` 只含 "Executed plan" 就是这条的证据。
    //
    // 曾经还有一条 `executedToday` **不含** merged 的断言，它靠"把 Plan 直接摆成 MERGED、跳过 MERGE_READY"
    // 造出来——那条路径现在生产不了：转换表里 `MERGE_READY → MERGED` 是进 MERGED 的唯一一条边，
    // 所以已合并的 Plan 必然也在 `executedToday` 里（合并之前它确实执行完成过）。
    expect(activity.mergedToday.map((entry) => entry.planId)).toEqual([merged.id]);
  });

  it("keeps a Plan's first entry into a state and reports only runs started on an earlier day as cross-day", () => {
    const { store, projects, project, plans } = fixture();
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Flapping plan", resolvedContract: planContractFixture({ store, projectId: project.id, title: "Flapping plan" }) });
    walkPlanTo(store, plan.id, "MERGE_READY");
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
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "thread-activity", title: "Today only", resolvedContract: planContractFixture({ store, projectId: project.id, title: "Today only" }) });
    walkPlanTo(store, plan.id, "MERGED");

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
