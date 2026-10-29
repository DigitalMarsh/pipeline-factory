/**
 * 测试职责：过程行图标映射——类型要能认出来，未知类型要有兜底。
 */
import { ChatDotRound, List, Monitor, Operation, Promotion, Tools } from "@element-plus/icons-vue";
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem } from "../types";
import type { ExecutionStreamItem } from "./executionStream";
import { executionProcessIcon, explorerProcessIcon } from "./chatIcons";

const executionItem = (kind: ExecutionStreamItem["kind"], messageType: ExecutionStreamItem["messageType"]): ExecutionStreamItem =>
  ({ kind, messageType }) as ExecutionStreamItem;

describe("过程行图标", () => {
  it("探索侧：工具、命令、推理各有各的图标", () => {
    expect(explorerProcessIcon("TOOL_CALL")).toBe(Tools);
    expect(explorerProcessIcon("COMMAND")).toBe(Monitor);
    expect(explorerProcessIcon("REASONING")).toBe(ChatDotRound);
  });

  it("探索侧：未知类型落到通用操作图标，不留空", () => {
    expect(explorerProcessIcon("SOMETHING_NEW" as ExplorerActivityItem["kind"])).toBe(Operation);
  });

  it("执行侧：方案与任务生命周期有自己的图标", () => {
    expect(executionProcessIcon(executionItem("plan", "PLAN"))).toBe(Promotion);
    expect(executionProcessIcon(executionItem("activity", "TASK_LIFECYCLE"))).toBe(List);
    expect(executionProcessIcon(executionItem("reasoning", "REASONING"))).toBe(ChatDotRound);
  });

  it("执行侧：未知类型落到工具图标，不留空", () => {
    expect(executionProcessIcon(executionItem("activity", "UNKNOWN_TYPE" as ExecutionStreamItem["messageType"]))).toBe(Tools);
  });
});
