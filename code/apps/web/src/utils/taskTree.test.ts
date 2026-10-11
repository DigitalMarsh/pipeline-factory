/**
 * 测试职责：验证需求在聊天区/左栏的显示名。
 *
 * 此前这里还测 `buildTaskTree`（把需求与当前 Plan 投影成树）和 `taskRuntimeLabel`，两者都只剩
 * 本文件在引用，已删——所以 fixture 也只剩构造 `ExplorerPlan` 需要的那部分。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerPlan } from "../types";
import { taskDisplayTitle } from "./taskTree";

const task = (id: string, ordinal: number, title = `Plan ${ordinal} / 待探索`): ExplorerPlan => ({
  id,
  explorerThreadId: "explorer-1",
  projectId: "project-1",
  ordinal,
  title,
  titleSource: "AUTO",
  titleStatus: "PLACEHOLDER",
  messageCount: 0,
  latestUserMessageSummary: null,
  exploration: { status: "INCOMPLETE", missing: [], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null },
  candidatePlanId: null,
  lastAssessedTurnId: null,
  createdAt: `2026-09-17T10:0${ordinal}:00.000Z`,
  lastActivityAt: `2026-09-17T10:0${ordinal}:00.000Z`,
});

describe("需求标题", () => {
  it("shows numbered requirement titles from the first message and preserves manual names", () => {
    expect(taskDisplayTitle(task("task-1", 1))).toBe("需求1：待探索");
    expect(taskDisplayTitle({ ...task("task-2", 2), latestUserMessageSummary: "写一份香蕉的简介" })).toBe("需求2：写一份香蕉的简介");
    expect(taskDisplayTitle({ ...task("task-2", 2, "My manual name"), titleSource: "MANUAL" })).toBe("需求2：My manual name");
  });

  it("手工命名时去掉自动编号前缀后仍取手工名；自动命名时前缀不影响", () => {
    // AUTO 的占位标题形如「Plan 3 / 待探索」，要把那段编号剥掉再拼"需求N："。
    expect(taskDisplayTitle(task("task-3", 3))).toBe("需求3：待探索");
    // MANUAL 的名字是用户写的，剥掉编号前缀后原样保留。
    expect(taskDisplayTitle({ ...task("task-4", 4, "Plan 4 / 我的名字"), titleSource: "MANUAL" })).toBe("需求4：我的名字");
  });
});
