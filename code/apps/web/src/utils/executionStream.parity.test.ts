/**
 * 测试职责：钉住 web 侧的中立词表镜像与领域实现**不漂移**，并回归"成功的调用不再显示状态未知"。
 *
 * 为什么需要这个文件：web 不能运行时依赖 `@pipeline-factory/domain`（会把整个领域层打进浏览器包），
 *   而 journal 载荷里的字段是无类型的字符串，所以 `utils/executionStream.ts` 里保留了一份镜像。
 *   镜像一旦漂移，同一条事件在领域侧与页面侧会得出不同结论——这正是本次要修的那类缺陷
 *   （Codex 的成功词 `completed` 两边认的不一样）。这里用同一批样例断言两边结论一致。
 */
import { describe, expect, it } from "vitest";
import { activityOutcome, classifyCodexActivity } from "@pipeline-factory/domain";
import { legacyActivityKind, legacyActivityOutcome, projectExecutionJournal, type ExecutionJournalEntry } from "./executionStream";

/** 有代表性的老事件载荷（本次改动之前写入的 journal 没有 activityKind / outcome）。 */
const SAMPLES: Array<{ name: string; itemType: string; phase: "started" | "completed"; status?: string; reason?: string }> = [
  { name: "codex 命令成功", itemType: "commandExecution", phase: "completed", status: "completed" },
  { name: "codex 命令失败", itemType: "commandExecution", phase: "completed", status: "failed", reason: "Provider command exited with code 1" },
  { name: "codex 命令进行中", itemType: "commandExecution", phase: "started" },
  { name: "codex 文件变更", itemType: "fileChange", phase: "completed", status: "completed" },
  { name: "codex 推理", itemType: "reasoning", phase: "completed" },
  { name: "codex 用户消息", itemType: "userMessage", phase: "completed" },
  { name: "codex MCP 调用", itemType: "mcpToolCall", phase: "completed", status: "completed" },
  { name: "codex 会话重建", itemType: "providerSession", phase: "completed" },
  { name: "结束但无状态", itemType: "commandExecution", phase: "completed" },
];

describe("web 的中立词表镜像与领域实现一致", () => {
  it.each(SAMPLES)("$name", (sample) => {
    const domain = classifyCodexActivity({ itemType: sample.itemType, phase: sample.phase, ...(sample.status === undefined ? {} : { status: sample.status }), ...(sample.reason === undefined ? {} : { error: sample.reason }) });
    const kind = legacyActivityKind(sample.itemType);
    const outcome = legacyActivityOutcome({ kind, phase: sample.phase, ...(sample.status === undefined ? {} : { status: sample.status }), ...(sample.reason === undefined ? {} : { reason: sample.reason }) });

    expect({ activityKind: kind, outcome }).toEqual(domain);
  });

  it("镜像里的成败词表与领域实现同源", () => {
    expect(activityOutcome({ kind: "command", phase: "completed", status: "completed" })).toBe(legacyActivityOutcome({ kind: "command", phase: "completed", status: "completed" }));
    expect(activityOutcome({ kind: "command", phase: "completed", status: "succeeded" })).toBe(legacyActivityOutcome({ kind: "command", phase: "completed", status: "succeeded" }));
    expect(activityOutcome({ kind: "command", phase: "completed" })).toBe(legacyActivityOutcome({ kind: "command", phase: "completed" }));
  });
});

describe("Provider 活动在页面上的成败呈现", () => {
  function journal(entries: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>): ExecutionJournalEntry[] {
    return entries.map((entry) => ({ ...entry, occurredAt: "2026-10-01T00:00:00.000Z" }));
  }

  it("**成功的命令显示为已完成**（回归：曾经全库 0 条成功，全被显示成状态未知）", () => {
    const items = projectExecutionJournal(journal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "succeeded" } },
    ]));

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("COMPLETED");
    expect(items[0]?.detail).toBe("执行成功");
    // 成功不再被记成"未记录项"。
    expect(items[0]?.unrecordedFields ?? []).not.toContain("调用结束状态未记录");
  });

  it("老事件也走同一张词表：completed 判为成功，不再落到状态未知", () => {
    const items = projectExecutionJournal(journal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", providerStatus: "completed" } },
    ]));

    expect(items[0]?.status).toBe("COMPLETED");
    expect(items[0]?.outcome).toBe("succeeded");
  });

  it("推理流不挂状态 chip（not-applicable → INFO），也不再被标成未记录", () => {
    const items = projectExecutionJournal(journal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", payload: { phase: "completed", itemId: "rs-1", providerItemId: "rs-1", itemType: "reasoning", activityKind: "reasoning", outcome: "not-applicable" } },
    ]));

    expect(items[0]?.status).toBe("INFO");
    expect(items[0]?.outcome).toBe("not-applicable");
    expect(items[0]?.unrecordedFields ?? []).not.toContain("调用结束状态未记录");
  });

  it("类别标签来自中立词表，两个 Provider 的同一种活动给出同一个标题前缀", () => {
    const items = projectExecutionJournal(journal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "succeeded" } },
      { sequence: 2, type: "PROVIDER_ACTIVITY", payload: { phase: "completed", itemId: "tool-1", providerItemId: "tool-1", itemType: "tool_result", activityKind: "command", outcome: "succeeded", toolName: "Bash" } },
    ]));

    expect(items[0]?.title).toBe("命令");
    expect(items[1]?.title).toBe("命令 · Bash");
  });
});
