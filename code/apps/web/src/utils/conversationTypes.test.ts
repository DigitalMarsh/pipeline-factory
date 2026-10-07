import { describe, expect, it } from "vitest";
import { MESSAGE_CLASS_LABELS, SHARED_MESSAGE_CLASSES, SHARED_MESSAGE_TYPES, type MessageClass } from "./conversationTypes";
import { EXECUTION_MESSAGE_WEIGHTS } from "./executionStream";
import { EXPLORER_MESSAGE_CLASSES, EXPLORER_DISPLAY_MODES } from "./explorerPresentation";

/**
 * 测试职责：钉住"两条对话线共用一份消息词表"与"五类划分"这两件事**真的落地了**。
 *
 * `type-parity.test.ts` 已经在编译期断言两边的类型联合都覆盖了 `SharedMessageType`，
 * 但类型只保证"名字在里面"，不保证"表里给了一行权重/呈现方式"——漏一行会在运行时读到 undefined，
 * 表现是那类消息在界面上凭空消失。这里补上运行时那一半。
 */
describe("两条对话线共用的消息词表", () => {
  it("每一类共用项，两边都各有一行权重与呈现方式", () => {
    for (const type of SHARED_MESSAGE_TYPES) {
      expect(EXPLORER_DISPLAY_MODES[type], `探索线程缺 ${type} 的呈现方式`).toBeDefined();
      expect(EXECUTION_MESSAGE_WEIGHTS[type], `执行线程缺 ${type} 的权重`).toBeDefined();
      expect(SHARED_MESSAGE_CLASSES[type], `共用词表缺 ${type} 的大类`).toBeDefined();
    }
  });

  it("同一个概念两边同一个名字，不是各写一份同义词", () => {
    // 此前：同一个"你发的消息"，探索侧叫 USER_MESSAGE、执行侧叫 guidance；同一次工具调用，
    // 探索侧按生命周期拆成三四个名字、执行侧叫 tool。两边对不上时，只能靠人肉对照。
    expect(SHARED_MESSAGE_TYPES).toContain("USER_MESSAGE");
    expect(SHARED_MESSAGE_TYPES).toContain("TOOL_CALL");
    expect(Object.keys(EXECUTION_MESSAGE_WEIGHTS)).not.toContain("guidance");
    expect(Object.keys(EXPLORER_DISPLAY_MODES)).not.toContain("TOOL_STARTED");
  });

  it("只有一边才有的那几种各自登记在案，不混进共用词表", () => {
    // 执行侧独有的 5 类：冻结方案、执行报告协议、Plan 任务、Run 级事件、恢复流程。
    for (const type of ["PLAN", "MODEL_REPORT", "TASK_LIFECYCLE", "RUN_ACTIVITY", "RECOVERY"])
      expect(SHARED_MESSAGE_TYPES).not.toContain(type);
    // 探索侧独有的 2 类：候选方案与结构化提问卡。
    for (const type of ["CANDIDATE_PLAN", "INPUT_REQUEST"]) expect(SHARED_MESSAGE_TYPES).not.toContain(type);
  });
});

/**
 * 五类划分：比"用户 / 模型 / 运行时"三分法更管用的那一层。
 * 它有两个直接后果，都是可断言的行为，不只是命名：
 *   1) `provider` 这一类**不进会话正文**；
 *   2) `model` 与 `action` 必须是两种排版（前者铺开读、后者折成一行）。
 */
describe("消息的五类划分", () => {
  it("每一类都有展示名（文档里清单表的「分类」列照它写）", () => {
    const classes: MessageClass[] = ["user", "model", "action", "provider", "factory"];
    for (const key of classes) expect(MESSAGE_CLASS_LABELS[key]).toBeTruthy();
    expect(new Set(Object.values(MESSAGE_CLASS_LABELS)).size).toBe(5);
  });

  it("**④「Provider 说的」不进会话正文**：探索侧一律 `hidden`（`UNCLASSIFIED` 例外）", () => {
    for (const [type, klass] of Object.entries(SHARED_MESSAGE_CLASSES)) {
      if (klass !== "provider") continue;
      // `UNCLASSIFIED` 是 ④ 里唯一露面的那个："Provider 给了我不认识的东西"必须当场可见，
      // 否则新活动类型会静默消失——那正是这一整轮在修的那类毛病。
      if (type === "UNCLASSIFIED") continue;
      expect(EXPLORER_DISPLAY_MODES[type as keyof typeof EXPLORER_DISPLAY_MODES], `${type} 属于 ④，不该进正文`).toBe("hidden");
      expect(EXECUTION_MESSAGE_WEIGHTS[type as keyof typeof EXECUTION_MESSAGE_WEIGHTS], `${type} 属于 ④，不该进正文`).toBe("hidden");
    }
  });

  it("② 模型说的与 ③ 模型做的是两种排版：正文常驻，动作进过程记录", () => {
    for (const [type, klass] of Object.entries(SHARED_MESSAGE_CLASSES)) {
      if (klass === "action") {
        expect(EXECUTION_MESSAGE_WEIGHTS[type as keyof typeof EXECUTION_MESSAGE_WEIGHTS], `${type} 是 ③，该折进过程记录`).toBe("process");
      }
      if (klass === "model" && type !== "REASONING") {
        expect(EXECUTION_MESSAGE_WEIGHTS[type as keyof typeof EXECUTION_MESSAGE_WEIGHTS], `${type} 是 ②，该常驻`).toBe("answer");
      }
      if (type === "USER_MESSAGE") {
        expect(EXECUTION_MESSAGE_WEIGHTS.USER_MESSAGE, "你说的那条永远常驻").toBe("answer");
      }
    }
  });

  it("探索侧的大类表覆盖全部消息类型，且共用项直接取共用表", () => {
    for (const type of SHARED_MESSAGE_TYPES) expect(EXPLORER_MESSAGE_CLASSES[type]).toBe(SHARED_MESSAGE_CLASSES[type]);
    // 探索侧独有的两项都是"模型做的"：候选方案是模型产出的产物，输入卡是模型发起、要你回话的动作。
    expect(EXPLORER_MESSAGE_CLASSES.INPUT_REQUEST).toBe("action");
    expect(EXPLORER_MESSAGE_CLASSES.CANDIDATE_PLAN).toBe("action");
  });
});
