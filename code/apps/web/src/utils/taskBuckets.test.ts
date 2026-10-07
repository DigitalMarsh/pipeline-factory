/**
 * 测试职责：验证任务中心四档分区的互斥与穷尽、dispatch 状态的优先级，以及筛选语义。
 * 维护提示：新增 Plan 状态时必须在这里补一条归属断言——没有断言的那些会静静落到"待执行"。
 */
import { describe, expect, it } from "vitest";
import { TASK_BUCKETS, countTaskBuckets, filterTasksByBucket, taskBucketFor } from "./taskBuckets";
import type { Plan } from "../types";

function plan(id: string, status: string, dispatchStatus?: string): Plan {
  return {
    id,
    planId: id,
    title: id,
    status,
    dispatch: dispatchStatus ? ({ status: dispatchStatus } as Plan["dispatch"]) : null,
  } as unknown as Plan;
}

describe("task buckets", () => {
  it("covers the four labels the task center shows", () => {
    expect(TASK_BUCKETS.map((bucket) => bucket.label)).toEqual(["待执行", "执行中", "已完成", "待处理"]);
  });

  it("buckets by Plan status, letting dispatch waits win over the Plan's own state", () => {
    expect(taskBucketFor(plan("a", "READY"))).toBe("pending");
    expect(taskBucketFor(plan("b", "ENQUEUED"))).toBe("pending");
    expect(taskBucketFor(plan("c", "IN_PROGRESS"))).toBe("running");
    expect(taskBucketFor(plan("d", "VERIFYING"))).toBe("running");
    expect(taskBucketFor(plan("e", "MERGED"))).toBe("completed");
    expect(taskBucketFor(plan("f", "MERGE_READY"))).toBe("attention");
    expect(taskBucketFor(plan("g", "BLOCKED"))).toBe("attention");
    expect(taskBucketFor(plan("h", "NEEDS_PLAN_CHANGE"))).toBe("attention");
    // 排队等容量/依赖时 Plan 仍是 DISPATCHED：只看 status 会把它错报成"待执行"。
    expect(taskBucketFor(plan("i", "DISPATCHED", "WAITING"))).toBe("pending");
    expect(taskBucketFor(plan("j", "DISPATCHED", "NEEDS_REVIEW"))).toBe("attention");
  });

  it("counts every Plan into exactly one bucket", () => {
    const counts = countTaskBuckets([plan("a", "READY"), plan("b", "IN_PROGRESS"), plan("c", "MERGED"), plan("d", "BLOCKED")]);
    expect(counts).toEqual({ pending: 1, running: 1, completed: 1, attention: 1 });
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(4);
  });

  it("filters by bucket without reordering, and returns a copy for all", () => {
    const plans = [plan("a", "READY"), plan("b", "IN_PROGRESS"), plan("c", "READY")];
    expect(filterTasksByBucket(plans, "pending").map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterTasksByBucket(plans, "completed")).toEqual([]);
    const all = filterTasksByBucket(plans, "all");
    expect(all.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(all).not.toBe(plans);
  });
});
