import { describe, expect, it } from "vitest";
import { SHARED_MESSAGE_TYPES } from "./conversationTypes";
import { EXECUTION_DISPLAY_MODES } from "./executionStream";
import { EXPLORER_DISPLAY_MODES } from "./explorerPresentation";

/**
 * 测试职责：钉住"两条对话线共用一份消息词表"这件事**真的落地了**。
 *
 * `type-parity.test.ts` 已经在编译期断言两边的类型联合都覆盖了 `SharedMessageType`，
 * 但类型只保证"名字在里面"，不保证"表里给了一行呈现方式"——漏一行会在运行时读到 undefined，
 * 表现是那类消息在界面上凭空消失。这里补上运行时那一半。
 */
describe("两条对话线共用的消息词表", () => {
  it("13 类共用项，两边都各有一行呈现方式", () => {
    expect(SHARED_MESSAGE_TYPES).toHaveLength(13);
    for (const type of SHARED_MESSAGE_TYPES) {
      expect(EXPLORER_DISPLAY_MODES[type], `探索线程缺 ${type} 的呈现方式`).toBeDefined();
      expect(EXECUTION_DISPLAY_MODES[type], `执行线程缺 ${type} 的呈现方式`).toBeDefined();
    }
  });

  it("同一个概念两边同一个名字，不是各写一份同义词", () => {
    // 此前：同一个"你发的消息"，探索侧叫 USER_MESSAGE、执行侧叫 guidance；同一次工具调用，
    // 探索侧按生命周期拆成三四个名字、执行侧叫 tool。两边对不上时，只能靠人肉对照。
    expect(SHARED_MESSAGE_TYPES).toContain("USER_MESSAGE");
    expect(SHARED_MESSAGE_TYPES).toContain("TOOL_CALL");
    expect(Object.keys(EXECUTION_DISPLAY_MODES)).not.toContain("guidance");
    expect(Object.keys(EXPLORER_DISPLAY_MODES)).not.toContain("TOOL_STARTED");
  });

  it("只有一边才有的那几种各自登记在案，不混进共用词表", () => {
    // 执行侧独有的 5 类：冻结方案、执行报告协议、Plan 任务、Run 级事件、恢复流程。
    for (const type of ["PLAN", "MODEL_REPORT", "TASK_LIFECYCLE", "RUN_ACTIVITY", "RECOVERY"]) expect(SHARED_MESSAGE_TYPES).not.toContain(type);
    // 探索侧独有的 4 类：候选方案、结构化提问与它的两条兜底生命周期行。
    for (const type of ["CANDIDATE_PLAN", "INPUT_REQUEST", "INPUT_REQUIRED", "INPUT_RESOLVED"]) expect(SHARED_MESSAGE_TYPES).not.toContain(type);
  });
});
