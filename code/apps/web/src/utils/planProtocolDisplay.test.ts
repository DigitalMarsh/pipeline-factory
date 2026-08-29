import { describe, expect, it } from "vitest";
import { parsePlanProtocolDisplay } from "./planProtocolDisplay";

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
