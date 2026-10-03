/**
 * 测试职责：钉住"状态 → `el-tag` 类型"这两张表——界面颜色的**唯一出处**，改错了不会有编译错误。
 *
 * 为什么值得单独测：这套映射是从三份手写 CSS 收敛来的，收敛的**唯一收益**就是"同一状态处处同色"。
 * 一旦有人在这里按自己的喜好改一个值，收益立刻归零，而且没有任何测试会报错。
 */
import { describe, expect, it } from "vitest";
import { executionTaskStatusType } from "./executionTasks.js";
import { explorerThreadStatusTagType, inputStatusTagType, projectExecutionStatusTagType, projectStatusTagType, requirementStatusTagType, statusTagType, streamStatusTagType } from "./statusTag.js";

describe("statusTagType", () => {
  it("完成是 success、失败是 danger、进行中是 warning，其余中性", () => {
    expect(statusTagType("COMPLETED")).toBe("success");
    expect(statusTagType("FAILED")).toBe("danger");
    expect(statusTagType("RUNNING")).toBe("warning");
    expect(statusTagType("WAITING")).toBe("info");
    expect(statusTagType("INFO")).toBe("info");
    expect(statusTagType("UNKNOWN")).toBe("info");
  });

  it("与执行步骤的标签取向逐值对齐（同一屏里两种标签不能两套语义）", () => {
    expect(statusTagType("COMPLETED")).toBe(executionTaskStatusType("DONE"));
    expect(statusTagType("FAILED")).toBe(executionTaskStatusType("BLOCKED"));
    expect(statusTagType("RUNNING")).toBe(executionTaskStatusType("IN_PROGRESS"));
    expect(statusTagType("WAITING")).toBe(executionTaskStatusType("PENDING"));
    expect(statusTagType("UNKNOWN")).toBe(executionTaskStatusType("UNKNOWN"));
  });
});

describe("inputStatusTagType", () => {
  it("已答是 success、需要人工恢复是 danger，其余中性或进行中", () => {
    expect(inputStatusTagType("ANSWERED")).toBe("success");
    expect(inputStatusTagType("RECOVERY_REQUIRED")).toBe("danger");
    expect(inputStatusTagType("SUBMITTING")).toBe("primary");
    expect(inputStatusTagType("OPEN")).toBe("info");
    expect(inputStatusTagType("CANCELLED")).toBe("info");
  });
});

describe("requirementStatusTagType", () => {
  it("需求清单的五个 tone 与五种标签类型一一对应", () => {
    expect(requirementStatusTagType("progress")).toBe("primary");
    expect(requirementStatusTagType("attention")).toBe("warning");
    expect(requirementStatusTagType("success")).toBe("success");
    expect(requirementStatusTagType("danger")).toBe("danger");
    expect(requirementStatusTagType("neutral")).toBe("info");
  });
});

describe("projectExecutionStatusTagType", () => {
  it("面板的六个状态：完成 success、执行中 warning、失败与需要恢复 danger、排队与取消中性", () => {
    expect(projectExecutionStatusTagType("COMPLETED")).toBe("success");
    expect(projectExecutionStatusTagType("RUNNING")).toBe("warning");
    expect(projectExecutionStatusTagType("FAILED")).toBe("danger");
    expect(projectExecutionStatusTagType("RECOVERY_REQUIRED")).toBe("danger");
    expect(projectExecutionStatusTagType("QUEUED")).toBe("info");
    expect(projectExecutionStatusTagType("CANCELLED")).toBe("info");
  });
});

describe("项目与线程的状态看起来要一致", () => {
  it("ACTIVE 是 success、ARCHIVED 是 info", () => {
    expect(projectStatusTagType("ACTIVE")).toBe("success");
    expect(projectStatusTagType("ARCHIVED")).toBe("info");
    expect(explorerThreadStatusTagType("ARCHIVED")).toBe("info");
    expect(explorerThreadStatusTagType("ACTIVE")).toBe("success");
    expect(explorerThreadStatusTagType("COMPRESSED")).toBe("success");
  });
});

describe("streamStatusTagType", () => {
  it("连着是 success、重连中是 warning、历史是 info", () => {
    expect(streamStatusTagType("live")).toBe("success");
    expect(streamStatusTagType("reconnecting")).toBe("warning");
    expect(streamStatusTagType("saved")).toBe("info");
  });
});
