/**
 * 测试职责：锁住执行消息"哪些诊断字段默认收起来、hover 里写什么"。
 *
 * 为什么值得测：这几个字段原本全摊在标题行上（Turn #1 · Call … · Provider item … · Provider session linked），
 *   一屏下来像日志不像对话。收起之后，"什么该收"就成了会被反复调整的展示规则——它同时是
 *   **安全边界的外沿**：只允许排版已有字段，不得顺手把工具参数或结果拼进来。
 */
import { describe, expect, it } from "vitest";
import { executionMessageDetails, executionMessageDiagnosticsTitle } from "./executionMessageDetails.js";

describe("executionMessageDetails", () => {
  it("keeps the order people ask about: which turn, which call, which provider session", () => {
    expect(executionMessageDetails({ modelStep: 3, callId: "call-1", providerThreadId: "thread-1" })).toEqual([
      "Turn #3",
      "Call call-1",
      "Provider session linked",
    ]);
  });

  it("prefers the Factory call id and only falls back to the provider item id", () => {
    // 两个都有时只显示 Call：Factory 的 id 才是能在本地查到的那一个。
    expect(executionMessageDetails({ callId: "call-1", providerItemId: "msg_abc" })).toEqual(["Call call-1"]);
    expect(executionMessageDetails({ providerItemId: "msg_abc" })).toEqual(["Provider item msg_abc"]);
  });

  it("drops what is not there instead of printing empty placeholders", () => {
    expect(executionMessageDetails({})).toEqual([]);
    expect(executionMessageDetails({ modelStep: 0 })).toEqual(["Turn #0"]);
    expect(executionMessageDiagnosticsTitle({})).toBeUndefined();
  });

  it("joins the same fields into a hover line", () => {
    expect(executionMessageDiagnosticsTitle({ modelStep: 1, providerTurnId: "turn-2" })).toBe("Turn #1 · Provider session linked");
  });
});
