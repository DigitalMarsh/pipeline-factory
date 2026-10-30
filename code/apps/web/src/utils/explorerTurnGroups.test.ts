/**
 * 测试职责：探索时间线的回合分组——谁进同一个回合块、什么进「过程 N 步」、回合状态与时间取哪一份。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerInputRequest, ExplorerTurn } from "../types";
import type { ExplorerTimelineItem } from "./explorerTimeline";
import { explorerTurnActivityStatus, groupExplorerTimeline, type ExplorerTimelineEntry } from "./explorerTurnGroups";

const T = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, "0")}:00.000Z`;

function activity(
  id: string,
  turnId: string,
  kind: ExplorerActivityItem["kind"],
  status: ExplorerActivityItem["status"] = "COMPLETED",
  minute = 0,
): ExplorerActivityItem {
  return { id, explorerId: "explorer-1", turnId, sequence: 1, kind, status, title: "", summary: "", details: null, occurredAt: T(minute) };
}

function entry(activityItem: ExplorerActivityItem, index: number): ExplorerTimelineEntry {
  const item: ExplorerTimelineItem = {
    key: `activity:${activityItem.id}`,
    kind: "activity",
    activity: activityItem,
    occurredAt: activityItem.occurredAt,
  };
  return { item, index };
}

function inputEntry(request: Partial<ExplorerInputRequest>, index: number): ExplorerTimelineEntry {
  const full = { id: `input-${index}`, localTurnId: "assistant-1", createdAt: T(index), ...request } as ExplorerInputRequest;
  return { item: { key: `input:${full.id}`, kind: "input", request: full, occurredAt: full.createdAt }, index };
}

const turn = (id: string, status: ExplorerTurn["status"], minute = 0): ExplorerTurn =>
  ({ id, threadId: "explorer-1", role: "assistant", content: "", status, createdAt: T(minute), sequence: 1 }) as ExplorerTurn;

describe("探索回合分组", () => {
  it("同一回合的正文/推理/工具收成一个块：正文可见，完成态过程折起来", () => {
    const blocks = groupExplorerTimeline(
      [
        entry(activity("m1", "assistant-1", "ASSISTANT_MESSAGE"), 0),
        entry(activity("r1", "assistant-1", "REASONING"), 1),
        entry(activity("t1", "assistant-1", "TOOL_CALL"), 2),
      ],
      [turn("assistant-1", "COMPLETED", 0)],
    );

    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.kind).toBe("turn");
    if (block.kind !== "turn") return;
    expect(block.visible.map((item) => item.index)).toEqual([0]);
    expect(block.folded.map((item) => item.index)).toEqual([1, 2]);
    expect(block.status).toBe("COMPLETED");
    expect(block.occurredAt).toBe(T(0));
  });

  it("运行中与失败的过程行留在外面，只有完成态进折叠", () => {
    const blocks = groupExplorerTimeline(
      [
        entry(activity("m1", "assistant-1", "ASSISTANT_MESSAGE", "RUNNING"), 0),
        entry(activity("t1", "assistant-1", "TOOL_CALL", "RUNNING"), 1),
        entry(activity("t2", "assistant-1", "TOOL_CALL", "FAILED"), 2),
        entry(activity("t3", "assistant-1", "TOOL_CALL", "COMPLETED"), 3),
      ],
      [turn("assistant-1", "RUNNING")],
    );
    const block = blocks[0]!;
    if (block.kind !== "turn") throw new Error("expected turn block");
    expect(block.visible.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(block.folded.map((item) => item.index)).toEqual([3]);
    expect(block.status).toBe("RUNNING");
  });

  it("用户消息与分隔行独立成块，并切断回合", () => {
    const blocks = groupExplorerTimeline(
      [
        entry(activity("u1", "user-1", "USER_MESSAGE"), 0),
        entry(activity("m1", "assistant-1", "ASSISTANT_MESSAGE"), 1),
        entry(activity("d1", "assistant-1", "CONTEXT"), 2),
        entry(activity("m2", "assistant-2", "ASSISTANT_MESSAGE"), 3),
      ],
      [turn("assistant-1", "COMPLETED"), turn("assistant-2", "COMPLETED")],
    );

    expect(blocks.map((block) => block.kind)).toEqual(["item", "turn", "item", "turn"]);
  });

  it("输入卡按 localTurnId 归入回合；对不上就独立成卡", () => {
    const blocks = groupExplorerTimeline(
      [
        entry(activity("m1", "assistant-1", "ASSISTANT_MESSAGE"), 0),
        inputEntry({}, 1),
        inputEntry({ id: "input-other", localTurnId: "assistant-9" }, 2),
      ],
      [turn("assistant-1", "WAITING_FOR_INPUT")],
    );

    expect(blocks).toHaveLength(2);
    const turnBlock = blocks[0]!;
    if (turnBlock.kind !== "turn") throw new Error("expected turn block");
    expect(turnBlock.visible.map((item) => (item.item.kind === "input" ? item.item.request.id : null))).toContain("input-1");
    expect(turnBlock.status).toBe("WAITING");
    expect(blocks[1]!.kind).toBe("item");
  });

  it("没有回合记录时，状态由活动推导（运行 > 失败 > 取消 > 等待 > 完成）", () => {
    const blocks = groupExplorerTimeline(
      [entry(activity("t1", "assistant-1", "TOOL_CALL", "COMPLETED"), 0), entry(activity("t2", "assistant-1", "TOOL_CALL", "FAILED"), 1)],
      [],
    );
    const block = blocks[0]!;
    if (block.kind !== "turn") throw new Error("expected turn block");
    expect(block.status).toBe("FAILED");
  });

  it("回合状态词与聊天行一致：等待输入/排队/暂停都显示「等待中」", () => {
    expect(explorerTurnActivityStatus("WAITING_FOR_INPUT")).toBe("WAITING");
    expect(explorerTurnActivityStatus("QUEUED")).toBe("WAITING");
    expect(explorerTurnActivityStatus("PAUSED")).toBe("WAITING");
    expect(explorerTurnActivityStatus("CANCELLED")).toBe("CANCELLED");
  });
});
