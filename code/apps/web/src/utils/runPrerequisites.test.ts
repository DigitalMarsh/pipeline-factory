import { describe, expect, it } from "vitest";
import { canCreateConfigurationRevision, configurationBlockedCommands, parseMissingRunCommands } from "./runPrerequisites";
import type { PlanDispatchState, PlanDispatchWaitReason } from "../types";

describe("run prerequisites", () => {
  it("extracts missing registered command ids from the API error", () => {
    expect(parseMissingRunCommands("RUN_PREREQUISITES_UNSATISFIED: missing registered commands: project.test, project.typecheck")).toEqual(["project.test", "project.typecheck"]);
  });

  it("extracts missing registered command ids from a scheduler waiting reason", () => {
    expect(parseMissingRunCommands("Missing registered commands: project.test, project.typecheck")).toEqual(["project.test", "project.typecheck"]);
  });

  it("ignores unrelated errors", () => {
    expect(parseMissingRunCommands("Run cannot be started")).toEqual([]);
  });
});

const waitingPlan = (waitReason: PlanDispatchWaitReason | null, lastError: string | null): { dispatch: Pick<PlanDispatchState, "waitReason" | "lastError"> } => ({ dispatch: { waitReason, lastError } });

const projectWith = (...commandIds: string[]) => ({ settings: { commands: commandIds.map((commandId) => ({ commandId })) } });

describe("配置缺失的 Plan", () => {
  it("只在 NEEDS_CONFIGURATION 时报告缺失命令", () => {
    expect(configurationBlockedCommands(waitingPlan("NEEDS_CONFIGURATION", "missing registered commands: project.test"))).toEqual(["project.test"]);
  });

  it("lastError 里恰好有同样字样但等待原因不是配置时，不上报", () => {
    // 否则会给用户一个点不出结果的"创建更新版本"入口。
    expect(configurationBlockedCommands(waitingPlan("WAITING_CONFLICT", "missing registered commands: project.test"))).toEqual([]);
    expect(configurationBlockedCommands(waitingPlan(null, "missing registered commands: project.test"))).toEqual([]);
  });

  it("没有派发信息时返回空数组，不抛错", () => {
    expect(configurationBlockedCommands(waitingPlan(null, null))).toEqual([]);
  });
});

describe("能否一键重建 Revision", () => {
  it("缺的命令全部已注册才允许", () => {
    const plan = waitingPlan("NEEDS_CONFIGURATION", "missing registered commands: project.test, project.typecheck");

    expect(canCreateConfigurationRevision(plan, projectWith("project.test", "project.typecheck", "project.lint"))).toBe(true);
  });

  it("少注册一条就不允许——否则会造出同样跑不起来的新 Revision", () => {
    const plan = waitingPlan("NEEDS_CONFIGURATION", "missing registered commands: project.test, project.typecheck");

    expect(canCreateConfigurationRevision(plan, projectWith("project.test"))).toBe(false);
  });

  it("没有 Project 或没有缺失命令时都不允许", () => {
    expect(canCreateConfigurationRevision(waitingPlan("NEEDS_CONFIGURATION", "missing registered commands: project.test"), null)).toBe(false);
    expect(canCreateConfigurationRevision(waitingPlan("NEEDS_CONFIGURATION", "no missing commands here"), projectWith("project.test"))).toBe(false);
  });
});
