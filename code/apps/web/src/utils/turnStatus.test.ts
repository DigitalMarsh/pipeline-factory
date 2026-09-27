/**
 * 测试职责：验证 turnStatus 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { isExplorerTurnProcessing, turnContent } from "./turnStatus";

describe("explorer turn processing state", () => {
  it("marks only a running assistant turn as processing", () => {
    expect(isExplorerTurnProcessing({ role: "assistant", status: "RUNNING" })).toBe(true);
    expect(isExplorerTurnProcessing({ role: "user", status: "RUNNING" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "COMPLETED" })).toBe(false);
    expect(isExplorerTurnProcessing({ role: "assistant", status: "WAITING_FOR_INPUT" })).toBe(false);
  });
});

describe("Turn 的展示文本", () => {
  it("有正文就用正文，不看状态", () => {
    expect(turnContent({ content: "正文", status: "FAILED" })).toBe("正文");
  });

  it("正文只有空白也算没有正文", () => {
    expect(turnContent({ content: "   ", status: "RUNNING" })).toBe("Plan Explorer 正在处理…");
  });

  it("没有正文时按状态给人话", () => {
    expect(turnContent({ content: "", status: "RUNNING" })).toBe("Plan Explorer 正在处理…");
    expect(turnContent({ content: "", status: "WAITING_FOR_INPUT" })).toBe("Plan Explorer 正在等待你的选择…");
    expect(turnContent({ content: "", status: "FAILED", error: "boom" })).toBe("模型调用失败：boom");
    expect(turnContent({ content: "", status: "FAILED" })).toBe("模型调用失败：未知错误");
  });

  it("其余状态一律落到最后一句", () => {
    expect(turnContent({ content: "", status: "COMPLETED" })).toBe("模型未返回内容");
    expect(turnContent({ content: "", status: "CANCELLED" })).toBe("模型未返回内容");
    expect(turnContent({ content: "" })).toBe("模型未返回内容");
  });
});
