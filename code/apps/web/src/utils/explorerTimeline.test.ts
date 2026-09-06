/**
 * 测试职责：验证 Explorer 消息流把结构化输入按生成时间插入，而不是统一追加到末尾。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerInputRequest } from "../types";
import { buildExplorerMessageTimeline, buildExplorerTimeline, explorerTimelineTarget } from "./explorerTimeline";

const activity = (id: string, kind: ExplorerActivityItem["kind"], occurredAt: string): ExplorerActivityItem => ({
  id,
  explorerId: "explorer-1",
  turnId: id,
  sequence: Number(id.replace(/\D/g, "")) || 1,
  kind,
  status: "COMPLETED",
  title: kind === "USER_MESSAGE" ? "You" : "Plan Explorer",
  summary: id,
  details: null,
  occurredAt,
});

const inputRequest = (id: string, createdAt: string, status: ExplorerInputRequest["status"] = "ANSWERED"): ExplorerInputRequest => ({
  id,
  threadId: "explorer-1",
  localTurnId: `turn-${id}`,
  providerRequestId: id,
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  itemId: `item-${id}`,
  questions: [{ id: "goal", header: "Goal", question: "What should we build?", isOther: false, isSecret: false, options: [{ label: "A", description: "Option A" }] }],
  isBlocking: true,
  autoResolutionMs: null,
  status,
  createdAt,
  answeredAt: status === "ANSWERED" ? "2026-09-01T10:04:00.000Z" : null,
  answeredBy: status === "ANSWERED" ? "local-user" : null,
  redactedAnswerSummary: status === "ANSWERED" ? { goal: { answerCount: 1, secret: false, answers: ["A"] } } : null,
});

describe("Explorer timeline projection", () => {
  it("inserts generated input between the surrounding messages by created time", () => {
    const items = buildExplorerTimeline(
      [
        activity("turn-1", "USER_MESSAGE", "2026-09-01T10:00:00.000Z"),
        activity("turn-3", "ASSISTANT_MESSAGE", "2026-09-01T10:05:00.000Z"),
      ],
      [inputRequest("input-2", "2026-09-01T10:02:00.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual(["activity:turn-1", "input:input-2", "activity:turn-3"]);
  });

  it("does not duplicate provider input lifecycle events when an input request exists", () => {
    const items = buildExplorerTimeline(
      [
        activity("turn-1", "ASSISTANT_MESSAGE", "2026-09-01T10:00:00.000Z"),
        activity("input-required", "INPUT_REQUIRED", "2026-09-01T10:02:00.000Z"),
        activity("input-resolved", "INPUT_RESOLVED", "2026-09-01T10:04:00.000Z"),
      ],
      [inputRequest("input-2", "2026-09-01T10:02:00.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual(["activity:turn-1", "input:input-2"]);
  });

  it("keeps a message target stable when lifecycle activity precedes the assistant message", () => {
    const assistant = activity("assistant-turn", "ASSISTANT_MESSAGE", "2026-09-01T10:03:00.000Z");

    expect(explorerTimelineTarget(assistant, 4)).toBe("message-assistant-turn");
  });

  it("gives assistant activities in the same provider turn distinct message targets", () => {
    const first = { ...activity("assistant-activity-1", "ASSISTANT_MESSAGE", "2026-09-01T10:03:00.000Z"), turnId: "provider-turn-1" };
    const second = { ...activity("assistant-activity-2", "ASSISTANT_MESSAGE", "2026-09-01T10:04:00.000Z"), turnId: "provider-turn-1" };

    expect(explorerTimelineTarget(first, 4)).toBe("message-assistant-activity-1");
    expect(explorerTimelineTarget(second, 5)).toBe("message-assistant-activity-2");
  });

  it("projects messages and an answered structured input as chronological message, question, and answer entries", () => {
    const items = buildExplorerMessageTimeline(
      [
        activity("turn-1", "USER_MESSAGE", "2026-09-01T10:00:00.000Z"),
        activity("turn-3", "ASSISTANT_MESSAGE", "2026-09-01T10:03:00.000Z"),
      ],
      [inputRequest("input-2", "2026-09-01T10:02:00.000Z")],
    );

    expect(items.map((item) => [item.label, item.occurredAt])).toEqual([
      ["消息", "2026-09-01T10:00:00.000Z"],
      ["提问", "2026-09-01T10:02:00.000Z"],
      ["消息", "2026-09-01T10:03:00.000Z"],
      ["回答", "2026-09-01T10:04:00.000Z"],
    ]);
    expect(items.filter((item) => item.label === "提问" || item.label === "回答").map((item) => item.target)).toEqual(["input-request-input-2", "input-request-input-2"]);
  });

  it("keeps an unanswered structured input as a question only", () => {
    const items = buildExplorerMessageTimeline([], [inputRequest("input-2", "2026-09-01T10:02:00.000Z", "OPEN")]);

    expect(items.map((item) => item.label)).toEqual(["提问"]);
  });

  it("inserts detached historical plans at their creation time instead of appending them", () => {
    const plan = {
      id: "plan-1",
      title: "Historical plan",
      revision: 1,
      status: "DRAFT" as const,
      projectId: "project-1",
      sourceExplorerThreadId: "explorer-1",
      sourceTurnId: null,
      createdAt: "2026-09-01T10:02:00.000Z",
      queuedAt: null,
      runId: null,
      lastEventAt: "2026-09-01T10:02:00.000Z",
      attentionReason: null,
    };
    const items = buildExplorerTimeline(
      [activity("first", "USER_MESSAGE", "2026-09-01T10:01:00.000Z"), activity("last", "ASSISTANT_MESSAGE", "2026-09-01T10:03:00.000Z")],
      [],
      [plan],
    );

    expect(items.map((item) => item.kind)).toEqual(["activity", "plan", "activity"]);
    expect(items[1]).toMatchObject({ kind: "plan", plan: { id: "plan-1" } });
  });
});
