/**
 * 模块职责：项目「今日活动」投影 —— 把一个项目在**某一天**内发生的四类执行事实分成四组：
 *   今日执行完成（当天首次进入 MERGE_READY）、今日已合并（当天进入 MERGED）、
 *   今日失败或阻塞、跨日仍在运行。
 *
 * 为什么需要它：Workbench 此前只能回答"现在有哪些 Plan"，回答不了"今天做了什么"。这两件事
 *   用的数据其实都在（plan.status.changed 事件、Run 与 MergeRequest），差的只是一个按天分组的投影。
 *   日报**不能**只统计"今日已合并"：执行完成与人工合并是两个时点，会把"跑了但没合"的那部分
 *   整个漏掉（见 docs/探索的流程/PLAN.md 第三节的同一条结论）。
 *
 * 维护提示：
 *   1) **只读事件与 Run，不新增表**。分组依据是 `plan.status.changed` 的 `toStatus` 与
 *      `occurredAt`；`updatePlanStatus` 只在状态**真的变化**时追加事件，所以"当天首次进入
 *      MERGE_READY"就是当天第一条该事件——不要按 Run 的更新时间反推（那不是同一个时点）。
 *   2) **按本地时区切天**：`date` 是本地日历日，边界由 `localDayBounds` 算，不用 UTC。
 *      跨日运行用例（`runningAcrossDays`）判的是 `startedAt < 当天起点`，与"今天开始的"区分开。
 *   3) 已知取舍：`plan.status.changed` 会被事件回收（`storage.eventRetentionDays`）清掉，
 *      超出保留窗口的历史日报会变空。这不是 bug，但调用方要能接受——所以 `retentionDays`
 *      也返回出去，让界面能说明"这条数据受保留窗口限制"。
 */
import type { DomainEvent, PipelineStore, ProjectService } from "@pipeline-factory/domain";
import { EXECUTION_SLOT_RUN_STATUSES } from "@pipeline-factory/domain";

export type DailyActivityEntry = {
  planId: string;
  planTitle: string;
  runId: string | null;
  at: string;
  /** 失败/阻塞那组才有：来自事件 reason 或任务阻塞原因。 */
  reason?: string | null;
};

export type DailyActivity = {
  projectId: string;
  date: string;
  timeZone: string;
  retentionDays: number;
  executedToday: DailyActivityEntry[];
  mergedToday: DailyActivityEntry[];
  failedToday: DailyActivityEntry[];
  runningAcrossDays: DailyActivityEntry[];
};

/** 本地日历日的起止时刻（含起点、不含终点）；不是真实存在的日期时返回 null。 */
export function localDayBounds(date: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  // 溢出检查：2026-02-31 会被 Date 静默滚到 3 月，这里拒绝这种输入而不是汇报一个别的一天。
  if (start.getMonth() !== month - 1 || start.getDate() !== day) return null;
  return { start: start.getTime(), end: end.getTime() };
}

/** 本地时区的今天（YYYY-MM-DD）；调用方不传 date 时用它。 */
export function localToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dailyActivity(store: PipelineStore, projects: ProjectService, projectId: string, date = localToday(), retentionDays = 0): DailyActivity {
  projects.get(projectId);
  const bounds = localDayBounds(date);
  if (!bounds) throw new Error(`Activity date must be a real local calendar day in YYYY-MM-DD form, received "${date}"`);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const empty: DailyActivity = { projectId, date, timeZone, retentionDays, executedToday: [], mergedToday: [], failedToday: [], runningAcrossDays: [] };
  if (!store.listPlans().some((plan) => plan.projectId === projectId) && !store.listRuns().some((run) => run.projectId === projectId)) return empty;

  const titleFor = (planId: string): string => store.getPlan(planId)?.title ?? planId;
  const planIds = new Set(store.listPlans().filter((plan) => plan.projectId === projectId).map((plan) => plan.id));
  const inDay = (event: DomainEvent): boolean => {
    const at = Date.parse(event.occurredAt);
    return Number.isFinite(at) && at >= bounds.start && at < bounds.end;
  };
  // 一天内的状态变更事件只会落在事件流的尾部，所以从尾部取一窗就够；上限 2000 是"单日状态
  // 变更条数"的务实上界（超过它的项目该先看看是不是有循环派发），而不是分页没做完。
  const statusEvents = store.listEvents({ types: ["plan.status.changed"], limit: 2_000, limitFrom: "tail" })
    .filter((event) => planIds.has(event.aggregateId) && inDay(event));

  // 一个 Plan 在一天内可能反复进出同一个状态；日报要的是"当天首次进入"，所以按 planId 取第一条。
  const firstByPlan = (toStatus: string): Map<string, DomainEvent> => {
    const result = new Map<string, DomainEvent>();
    for (const event of statusEvents) {
      if (event.payload.toStatus !== toStatus) continue;
      if (!result.has(event.aggregateId)) result.set(event.aggregateId, event);
    }
    return result;
  };

  empty.executedToday = [...firstByPlan("MERGE_READY")].map(([planId, event]) => ({
    planId,
    planTitle: titleFor(planId),
    runId: typeof event.payload.runId === "string" ? event.payload.runId : null,
    at: event.occurredAt,
  }));
  empty.mergedToday = [...firstByPlan("MERGED")].map(([planId, event]) => ({
    planId,
    planTitle: titleFor(planId),
    runId: typeof event.payload.runId === "string" ? event.payload.runId : null,
    at: event.occurredAt,
  }));
  empty.failedToday = [...firstByPlan("BLOCKED")].map(([planId, event]) => ({
    planId,
    planTitle: titleFor(planId),
    runId: typeof event.payload.runId === "string" ? event.payload.runId : null,
    at: event.occurredAt,
    reason: typeof event.payload.reason === "string" ? event.payload.reason : null,
  }));
  empty.runningAcrossDays = store.listRuns()
    .filter((run) => run.projectId === projectId && EXECUTION_SLOT_RUN_STATUSES.has(run.status))
    .filter((run) => {
      const startedAt = Date.parse(run.startedAt ?? run.createdAt);
      return Number.isFinite(startedAt) && startedAt < bounds.start;
    })
    .map((run) => ({ planId: run.planId, planTitle: titleFor(run.planId), runId: run.id, at: run.startedAt ?? run.createdAt }));
  return empty;
}
