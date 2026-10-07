/**
 * 测试职责：验证 Explorer 消息流把结构化输入按生成时间插入，而不是统一追加到末尾。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerInputRequest } from "../types";
import {
  buildExplorerTimeline,
  explorerPlanAnchorId,
  explorerTimelineMessageType,
  explorerTimelineTarget,
  inputRequestTarget,
} from "./explorerTimeline";

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
  questions: [
    {
      id: "goal",
      header: "Goal",
      question: "What should we build?",
      isOther: false,
      isSecret: false,
      options: [{ label: "A", description: "Option A" }],
    },
  ],
  isBlocking: true,
  status,
  createdAt,
  answeredAt: status === "ANSWERED" ? "2026-09-01T10:04:00.000Z" : null,
  answeredBy: status === "ANSWERED" ? "local-user" : null,
  redactedAnswerSummary: status === "ANSWERED" ? { goal: { answerCount: 1, secret: false, answers: ["A"] } } : null,
});

describe("Explorer timeline projection", () => {
  it("inserts generated input between the surrounding messages by created time", () => {
    const items = buildExplorerTimeline(
      [activity("turn-1", "USER_MESSAGE", "2026-09-01T10:00:00.000Z"), activity("turn-3", "ASSISTANT_MESSAGE", "2026-09-01T10:05:00.000Z")],
      [inputRequest("input-2", "2026-09-01T10:02:00.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual(["activity:turn-1", "input:input-2", "activity:turn-3"]);
  });

  it("把活动与输入卡按时间合成一条，不额外过滤什么", () => {
    // 结构化输入的生命周期行不再需要在这里过滤：投影层已经不产出它们
    // （写步骤与写 input_requests 行是同一次调用，见 explorer-activity.ts 的模块注释 3）。
    const items = buildExplorerTimeline(
      [activity("turn-1", "ASSISTANT_MESSAGE", "2026-09-01T10:00:00.000Z"), activity("turn-3", "COMMAND", "2026-09-01T10:06:00.000Z")],
      [inputRequest("input-2", "2026-09-01T10:02:00.000Z")],
    );

    expect(items.map((item) => item.key)).toEqual(["activity:turn-1", "input:input-2", "activity:turn-3"]);
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
});

describe("时间线条目 → 消息类型", () => {
  it("活动条目原样交出它的 kind，交给展示表去决定怎么显示", () => {
    const item = buildExplorerTimeline([activity("turn-1", "TOOL_CALL", "2026-09-01T10:00:00.000Z")], [])[0];
    expect(item && explorerTimelineMessageType(item)).toBe("TOOL_CALL");
  });

  it("输入卡翻成表里的非活动类型", () => {
    const input = buildExplorerTimeline([], [inputRequest("input-2", "2026-09-01T10:02:00.000Z")])[0];

    expect(input && explorerTimelineMessageType(input)).toBe("INPUT_REQUEST");
  });
});

describe("Explorer 锚点 id", () => {
  it("输入卡片的锚点只用 id 拼，视图直接引它当 DOM id", () => {
    expect(inputRequestTarget({ id: "input-2" })).toBe("input-request-input-2");
  });

  it("需求区块锚点由 explorerPlanId 直接拼出", () => {
    expect(explorerPlanAnchorId("explorer-plan-9")).toBe("explorer-plan-explorer-plan-9");
    expect(explorerPlanAnchorId("")).toBe("explorer-plan-");
  });
});
