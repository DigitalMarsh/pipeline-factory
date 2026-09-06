/**
 * 测试职责：验证执行页计划任务状态的持久化事实投影。
 */
import { describe, expect, it } from "vitest";
import { projectExecutionTasks } from "./executionTasks";

const tasks = [
  { id: "task-1", title: "Create the document", dependencies: [], status: "READY" },
  { id: "task-2", title: "Verify the document", dependencies: ["task-1"], status: "PENDING" },
  { id: "task-3", title: "Prepare review", dependencies: ["task-2"], status: "PENDING" },
];

describe("projectExecutionTasks", () => {
  it("projects structured task progress and the next dependency-ready task", () => {
    const result = projectExecutionTasks(tasks, [{ sequence: 8, type: "TASK_PROGRESS", occurredAt: "2026-09-06T03:00:00.000Z", payload: { action: "task-status", completedTaskIds: ["task-1"], activeTaskId: "task-2" } }], "IN_PROGRESS");

    expect(result).toMatchObject([
      { id: "task-1", status: "DONE", evidenceSequence: 8 },
      { id: "task-2", status: "IN_PROGRESS", evidenceSequence: 8 },
      { id: "task-3", status: "PENDING", evidenceSequence: null },
    ]);
  });

  it("keeps a blocked task and reason without marking unrelated tasks failed", () => {
    const result = projectExecutionTasks(tasks, [{ sequence: 9, type: "TASK_PROGRESS", occurredAt: "2026-09-06T03:00:00.000Z", payload: { action: "task-status", completedTaskIds: ["task-1", "task-2"], blockedTaskId: "task-3", blockedReason: "No Git remote" } }], "BLOCKED");

    expect(result).toMatchObject([
      { id: "task-1", status: "DONE" },
      { id: "task-2", status: "DONE" },
      { id: "task-3", status: "BLOCKED", blockedReason: "No Git remote", evidenceSequence: 9 },
    ]);
  });

  it("supports legacy report blocks without trusting ordinary model prose", () => {
    const result = projectExecutionTasks(tasks, [
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-09-06T03:00:00.000Z", payload: { text: "已完成 task-1。" } },
      { sequence: 3, type: "TASK_PROGRESS", occurredAt: "2026-09-06T03:00:01.000Z", payload: { event: "agent.model.completed" } },
      { sequence: 4, type: "MODEL_OUTPUT", occurredAt: "2026-09-06T03:00:02.000Z", payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1"], changedPaths: [], report: "done" })}</pipeline-factory-execution-report>` } },
      { sequence: 5, type: "TASK_PROGRESS", occurredAt: "2026-09-06T03:00:03.000Z", payload: { event: "agent.model.completed" } },
    ], "BLOCKED");

    expect(result[0]).toMatchObject({ id: "task-1", status: "DONE", evidenceSequence: 4 });
    expect(result[1]?.status).toBe("PENDING");
  });
});
