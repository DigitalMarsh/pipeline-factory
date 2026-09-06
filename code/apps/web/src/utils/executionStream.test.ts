/**
 * 测试职责：验证 executionStream 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { projectExecutionJournal } from "./executionStream";

describe("projectExecutionJournal", () => {
  it("merges model deltas and keeps user guidance and execution activity readable", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-08-30T07:00:00.000Z", payload: { planId: "plan-1", revision: 1 } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "正在读取" } },
      { sequence: 3, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.100Z", payload: { text: "计划" } },
      { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { event: "agent.model.completed", step: 1 } },
      { sequence: 5, type: "TOOL_CALL", occurredAt: "2026-08-30T07:00:03.000Z", payload: { action: "requested", tool: "read_file", callId: "call-1" } },
      { sequence: 6, type: "USER_GUIDANCE", occurredAt: "2026-08-30T07:00:04.000Z", payload: { content: "只修改批准范围内的文件" } },
      { sequence: 7, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:05.000Z", payload: { state: "BLOCKED", reason: "MAX_DURATION_EXCEEDED" } },
    ], "BLOCKED");

    expect(items).toHaveLength(5);
    expect(items[1]).toMatchObject({ kind: "model", role: "assistant", content: "正在读取计划", status: "COMPLETED" });
    expect(items[2]).toMatchObject({ kind: "activity", status: "RUNNING", title: "Tool requested", detail: "read_file" });
    expect(items[3]).toMatchObject({ kind: "guidance", role: "user", content: "只修改批准范围内的文件" });
    expect(items[4]).toMatchObject({ kind: "activity", status: "FAILED", title: "Run blocked", detail: "MAX_DURATION_EXCEEDED" });
  });

  it("marks a trailing model message as running while the execution thread is active", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "仍在处理" } },
    ], "ACTIVE");

    expect(items).toEqual([expect.objectContaining({ kind: "model", content: "仍在处理", status: "RUNNING" })]);
  });

  it("turns the execution report protocol into a readable assistant message", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1", "task-2"], changedPaths: ["docs/guide.md"], report: "已完成内容与格式复核" })}</pipeline-factory-execution-report>` } },
      { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:01.000Z", payload: { action: "task-status", completedTaskIds: ["task-1", "task-2"] } },
    ], "BLOCKED");

    expect(items[0]).toMatchObject({ kind: "model", title: "Executor report", content: "已完成内容与格式复核\n\nCompleted 2 task(s) · 1 changed path(s)" });
    expect(items.some((item) => item.detail.includes("<pipeline-factory-execution-report>"))).toBe(false);
  });

  it("hides repetitive loop bookkeeping from the primary conversation", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:00.000Z", payload: { event: "agent.step.started", step: 1 } },
      { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:01.000Z", payload: { event: "agent.model.completed", step: 1 } },
      { sequence: 3, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { event: "agent.context.compacted", messageCount: 4 } },
    ], "ACTIVE");

    expect(items).toEqual([]);
  });

  it("folds repeated reports with unchanged task progress into one card", () => {
    const report = (text: string, sequence: number) => ({ sequence, type: "MODEL_OUTPUT", occurredAt: `2026-08-30T07:00:0${sequence}.000Z`, payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1"], changedPaths: [], report: text })}</pipeline-factory-execution-report>` } });
    const items = projectExecutionJournal([report("第一轮完成", 1), { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { action: "task-status", completedTaskIds: ["task-1"] } }, report("没有新的可执行内容", 3), { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:04.000Z", payload: { action: "task-status", completedTaskIds: ["task-1"] } }], "BLOCKED");

    expect(items.filter((item) => item.title === "Executor report")).toHaveLength(1);
    expect(items.find((item) => item.title === "Executor report")?.repetitionCount).toBe(2);
  });
});
