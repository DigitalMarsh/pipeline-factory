/**
 * 测试职责：验证 planProtocolDisplay 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { parsePlanProtocolDisplay, readableAssistantText } from "./planProtocolDisplay";

const artifact = {
  title: "Personal information manager",
  goal: "Build a local single-user personal information manager",
  acceptanceCriteria: ["User can create records", "Data is encrypted at rest"],
  include: ["apps/web", "apps/api"],
  exclude: ["deploy/*"],
  tasks: [{ id: "task-1", title: "Implement record management", dependencies: [], status: "READY" }],
  verificationCommandIds: ["project.test"],
};

describe("plan protocol display", () => {
  it("turns a complete READY protocol into a readable summary", () => {
    const result = parsePlanProtocolDisplay(`方案已整理完成。\n<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>\n<pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`);

    expect(result).toEqual({
      kind: "ready",
      prose: "方案已整理完成。",
      title: "Personal information manager",
      goal: "Build a local single-user personal information manager",
      includeCount: 2,
      excludeCount: 1,
      taskCount: 1,
      acceptanceCount: 2,
      verificationCount: 1,
    });
  });

  it("hides an incomplete protocol while it is still streaming", () => {
    const result = parsePlanProtocolDisplay(`<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"Personal`);

    expect(result.kind).toBe("generating");
    if (result.kind === "generating") {
      expect(result.text).not.toContain("pipeline-factory-plan");
      expect(result.text).not.toContain("{\"title\"");
    }
  });

  it("hides malformed protocol content without affecting ordinary text", () => {
    const invalid = parsePlanProtocolDisplay("前置说明 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad}</pipeline-factory-plan>");
    const plain = parsePlanProtocolDisplay("普通消息：请选择你偏好的实现方式。");

    expect(invalid).toMatchObject({ kind: "invalid", text: "前置说明 结构化计划校验失败，请继续完善。" });
    if (invalid.kind === "invalid") expect(invalid.text).not.toContain("{bad}");
    expect(plain).toEqual({ kind: "plain", text: "普通消息：请选择你偏好的实现方式。" });
  });
});

describe("助手消息的可读文本", () => {
  it("READY 时把方案标题接在正文后面", () => {
    const content = '先说两句 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"接入登录","goal":"g"}</pipeline-factory-plan>';

    expect(readableAssistantText(content)).toBe("先说两句 完整执行方案已生成：接入登录");
  });

  it("只有协议没有正文时只留提示句，不留多余空格", () => {
    const content = '<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"接入登录","goal":"g"}</pipeline-factory-plan>';

    expect(readableAssistantText(content)).toBe("完整执行方案已生成：接入登录");
  });

  it("普通消息原样返回", () => {
    expect(readableAssistantText("普通消息")).toBe("普通消息");
  });

  it("生成中与校验失败都回退到展示对象自带的提示语", () => {
    expect(readableAssistantText("说明 <pipeline-factory-plan-status>GENERATING</pipeline-factory-plan-status>")).toBe("说明 正在整理结构化计划…");
    expect(readableAssistantText("说明 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad}</pipeline-factory-plan>")).toBe("说明 结构化计划校验失败，请继续完善。");
  });
});
