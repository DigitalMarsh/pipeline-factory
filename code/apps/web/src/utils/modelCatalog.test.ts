import { describe, expect, it } from "vitest";
import { backendSwitchAdjustment, modelOptionsFor } from "./modelCatalog";
import type { ModelBackendsResponse } from "../types";

/** 两个 kind 各一个后端，外加同 kind 的第二个 Claude 网关（用来验证"同 kind 不动"）。 */
const catalog = {
  roles: { explorer: "codex-app-server", executor: "codex-app-server" },
  backends: [
    { id: "codex-app-server", kind: "codex-app-server", source: "implicit", models: ["gpt-5.6-luna", "gpt-6-sol"], reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"], endpoint: null, endpointSource: "provider-settings" },
    { id: "claude-agent-sdk", kind: "claude-agent-sdk", source: "implicit", models: ["claude-opus-5", "claude-sonnet-5"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], endpoint: null, endpointSource: "provider-settings" },
    { id: "claude-proxy", kind: "claude-agent-sdk", source: "registry", models: ["claude-opus-5", "claude-sonnet-5"], reasoningEfforts: ["low", "high"], endpoint: "proxy.internal", endpointSource: "config" },
  ],
} as unknown as ModelBackendsResponse;

describe("切换 Agent 时模型与推理强度跟着走", () => {
  it("从 Codex 切到 Claude：模型换成新后端的候选，而不是留着旧 slug", () => {
    // 不这样做的话存下去就是 `backend: claude-agent-sdk` + `model: gpt-5.6-luna`，
    // 而域里的家族迁移**刻意跳过显式写了 backend 的项目**（`migrateForeignFamilyModels`），
    // 永远不会替你改回来——界面上表现为"改完 Agent，模型那格还是旧 agent 的名字"。
    expect(backendSwitchAdjustment(catalog, "claude-agent-sdk", { model: "gpt-5.6-luna", reasoningEffort: "" })).toEqual({ model: "claude-opus-5", clearReasoningEffort: false });
  });

  it("目录里查不到的名字一律不动——手写别名与代理映射名正是要被保护的东西", () => {
    expect(backendSwitchAdjustment(catalog, "claude-agent-sdk", { model: "my-local-alias", reasoningEffort: "" }).model).toBeNull();
  });

  it("同一个 kind 内部换后端也不动：模型名大概率通用", () => {
    expect(backendSwitchAdjustment(catalog, "claude-proxy", { model: "claude-opus-5", reasoningEffort: "" }).model).toBeNull();
  });

  it("新后端不支持的推理强度清回默认——否则保存会被域直接拒绝", () => {
    // `validateRoleBackend`：`models.executor.reasoningEffort "ultra" is not supported by backend …`
    expect(backendSwitchAdjustment(catalog, "claude-agent-sdk", { model: "gpt-5.6-luna", reasoningEffort: "ultra" }).clearReasoningEffort).toBe(true);
    expect(backendSwitchAdjustment(catalog, "claude-agent-sdk", { model: "gpt-5.6-luna", reasoningEffort: "xhigh" }).clearReasoningEffort).toBe(false);
    // 目录里没有这个后端时什么都不表态。
    expect(backendSwitchAdjustment(catalog, "unknown-backend", { model: "gpt-5.6-luna", reasoningEffort: "ultra" })).toEqual({ model: null, clearReasoningEffort: false });
  });
});

describe("打开设置页时不动手写模型名", () => {
  it("`modelOptionsFor` 把当前值并进选项——这条行为是上面那条调整的**前提**，不要顺手删掉", () => {
    expect(modelOptionsFor(catalog, "claude-agent-sdk", "my-local-alias")).toEqual(["claude-opus-5", "claude-sonnet-5", "my-local-alias"]);
  });
});
