import { describe, expect, it } from "vitest";
import { activityIconKind, activityKindLabel, activityStatusLabel, explorerDisplayTitle, formatTurnTime, inputRequestTarget, inputStatusLabel } from "./explorerPresentation";
import type { ExplorerActivityKind, ExplorerInputRequest } from "../types";

function request(id: string, status: ExplorerInputRequest["status"]): Pick<ExplorerInputRequest, "id" | "status"> {
  return { id, status };
}

describe("Explorer 展示映射", () => {
  it("把消息时间截到分钟", () => {
    // 用固定时区无关的断言：只验形状，不验具体时区偏移。
    expect(formatTurnTime("2026-09-28T14:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("线程没有标题时给出占位标题", () => {
    expect(explorerDisplayTitle(null)).toBe("探索线程");
    expect(explorerDisplayTitle({ title: "" } as never)).toBe("探索线程");
    expect(explorerDisplayTitle({ title: "改名后的线程" } as never)).toBe("改名后的线程");
  });

  it("输入卡片的锚点只用 id 拼", () => {
    expect(inputRequestTarget({ id: "input-1" })).toBe("input-request-input-1");
  });
});

describe("输入请求状态文案", () => {
  it("六个状态各有文案，不回落成原字符串", () => {
    expect(inputStatusLabel(request("a", "OPEN"), null)).toBe("Waiting for answer");
    expect(inputStatusLabel(request("a", "SUBMITTING"), null)).toBe("Submitting");
    expect(inputStatusLabel(request("a", "ANSWERED"), null)).toBe("Answered");
    expect(inputStatusLabel(request("a", "AUTO_RESOLVED"), null)).toBe("Auto-resolved");
    expect(inputStatusLabel(request("a", "CANCELLED"), null)).toBe("Cancelled");
    expect(inputStatusLabel(request("a", "RECOVERY_REQUIRED"), null)).toBe("Recovery required");
  });

  it("本地在途标记优先于服务端状态，且只对同一个请求生效", () => {
    // 提交后服务端仍是 OPEN，界面必须靠本地标记抢先显示 Submitting。
    expect(inputStatusLabel(request("in-flight", "OPEN"), "in-flight")).toBe("Submitting");
    expect(inputStatusLabel(request("other", "OPEN"), "in-flight")).toBe("Waiting for answer");
  });
});

describe("活动条目文案", () => {
  it("状态映射四档", () => {
    expect(activityStatusLabel({ status: "WAITING" })).toBe("Waiting");
    expect(activityStatusLabel({ status: "FAILED" })).toBe("Failed");
    expect(activityStatusLabel({ status: "RUNNING" })).toBe("Running");
    expect(activityStatusLabel({ status: "COMPLETED" })).toBe("Completed");
  });

  it("已知 kind 有文案，未知 kind 回落成原字符串", () => {
    expect(activityKindLabel("REASONING_SUMMARY")).toBe("Reasoning");
    expect(activityKindLabel("TURN_STATUS")).toBe("Turn status");
    // USER_MESSAGE / ASSISTANT_MESSAGE 刻意不在表里：它们走的是消息卡片，不显示 kind 文案。
    expect(activityKindLabel("USER_MESSAGE" as ExplorerActivityKind)).toBe("USER_MESSAGE");
  });

  it("图标语义：拒绝与门禁是警告，完成与输入解决是成功，其余是信息", () => {
    expect(activityIconKind("TOOL_DENIED")).toBe("warning");
    expect(activityIconKind("GATE_CHECKED")).toBe("warning");
    expect(activityIconKind("TOOL_COMPLETED")).toBe("success");
    expect(activityIconKind("INPUT_RESOLVED")).toBe("success");
    expect(activityIconKind("REASONING_SUMMARY")).toBe("info");
    expect(activityIconKind("USER_MESSAGE")).toBe("info");
  });
});
