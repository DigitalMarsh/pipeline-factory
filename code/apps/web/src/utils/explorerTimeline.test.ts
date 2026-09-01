/**
 * 测试职责：验证 Explorer 消息流把结构化输入按生成时间插入，而不是统一追加到末尾。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerInputRequest } from "../types";
import { buildExplorerTimeline } from "./explorerTimeline";

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
});
