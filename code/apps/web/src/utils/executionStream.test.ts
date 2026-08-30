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

    expect(items).toHaveLength(6);
    expect(items[1]).toMatchObject({ kind: "model", role: "assistant", content: "正在读取计划", status: "COMPLETED" });
    expect(items[3]).toMatchObject({ kind: "activity", status: "RUNNING", title: "Tool requested", detail: "read_file" });
    expect(items[4]).toMatchObject({ kind: "guidance", role: "user", content: "只修改批准范围内的文件" });
    expect(items[5]).toMatchObject({ kind: "activity", status: "FAILED", title: "Run blocked", detail: "MAX_DURATION_EXCEEDED" });
  });

  it("marks a trailing model message as running while the execution thread is active", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "仍在处理" } },
    ], "ACTIVE");

    expect(items).toEqual([expect.objectContaining({ kind: "model", content: "仍在处理", status: "RUNNING" })]);
  });
});
