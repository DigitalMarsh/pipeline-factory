/**
 * 测试职责：锁住注入 Explorer 的 Plan 协议指令里那条"会让用户走进死路"的规则——
 *   仓库改动的需求不得把 CONVERSATION 标成推荐。
 *
 * 设计说明：提示词是契约的一部分（模型据此选产物模式），所以按源码断言锁住关键句，
 *   与 areas / artifactModes 的声明做交叉检查；不做模型调用。
 * 维护提示：改 EXPLORER_PLAN_INSTRUCTIONS 措辞时同步这里的字符串；删掉那句就等于规则消失。
 */
import { describe, expect, it } from "vitest";
import { EXPLORER_PLAN_INSTRUCTIONS, EXPLORER_PLAN_REQUIREMENTS } from "./plan-requirements.js";

describe("EXPLORER_PLAN_INSTRUCTIONS", () => {
  it("禁止把 CONVERSATION 标成推荐，并说明它确认后仍不可执行", () => {
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("不得把 CONVERSATION 标成");
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("确认后仍不能入队");
  });

  it("描述里出现 artifactModes 声明过的每一种产物模式", () => {
    for (const mode of EXPLORER_PLAN_REQUIREMENTS.artifactModes) expect(EXPLORER_PLAN_INSTRUCTIONS).toContain(mode.mode);
    expect(EXPLORER_PLAN_REQUIREMENTS.artifactModes.find((mode) => mode.mode === "CONVERSATION")?.executable).toBe(false);
  });
});
