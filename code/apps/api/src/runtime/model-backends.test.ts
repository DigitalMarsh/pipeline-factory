/**
 * 测试职责：模型后端注册表的分发语义 —— 内置 kind 齐全、未知 kind 给出可读错误、
 *   重复注册不静默覆盖、扩展 kind 能真的被 `createModelGateway` 用到。
 *
 * 设计说明：不构造任何真实 Provider（不 spawn CLI、不发网络请求）；自定义 kind 用的是
 *   一个只满足 `ModelGateway` 形状的替身。
 */
import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelGateway, ModelRole } from "@pipeline-factory/core";
import type { ResolvedModelBackend } from "../config.js";
import { createDefaultModelBackendRegistry, ModelBackendRegistry } from "./model-backends.js";

const roles = { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } };

function backend(kind: string, overrides: Partial<ResolvedModelBackend> = {}): ResolvedModelBackend {
  return { id: kind, kind: kind as ResolvedModelBackend["kind"], source: "registry", models: [], ...overrides };
}

function fakeGateway(): ModelGateway {
  return {
    stream: async function* (): AsyncIterable<ModelEvent> {
      yield { type: "turn.completed" };
    },
    answerUserInput: async () => undefined,
    cancel: async () => undefined,
    configFor: (role: ModelRole) => roles[role],
  };
}

describe("ModelBackendRegistry", () => {
  it("registers the four built-in backends", () => {
    expect(createDefaultModelBackendRegistry().kinds()).toEqual(["claude-agent-sdk", "codex-app-server", "openai-responses", "stub"]);
  });

  it("rejects an unknown kind and lists what is available", () => {
    const registry = new ModelBackendRegistry().register("stub", () => fakeGateway());
    expect(() => registry.create(backend("custom"), { roles, maxSteps: 1 })).toThrow(
      'Unsupported model backend kind "custom". Registered kinds: stub.',
    );
  });

  it("refuses to silently overwrite a registered kind", () => {
    const registry = new ModelBackendRegistry().register("stub", () => fakeGateway());
    expect(() => registry.register("stub", () => fakeGateway())).toThrow('Model backend kind "stub" is already registered');
  });

  it("constructs an extension backend through its factory", () => {
    const created: string[] = [];
    const registry = new ModelBackendRegistry().register("custom", (definition, context) => {
      created.push(`${definition.id}:${context.roles.executor.model}:${context.maxSteps}`);
      return fakeGateway();
    });

    const gateway = registry.create(backend("custom", { id: "my-custom-backend" }), { roles, maxSteps: 7 });
    expect(gateway).toBeDefined();
    expect(created).toEqual(["my-custom-backend:executor-model:7"]);
  });

  it("fails at construction for a backend missing its required config block", () => {
    expect(() => createDefaultModelBackendRegistry().create(backend("codex-app-server"), { roles, maxSteps: 1 })).toThrow(
      /model\.codexAppServer/,
    );
    expect(() => createDefaultModelBackendRegistry().create(backend("openai-responses"), { roles, maxSteps: 1 })).toThrow(/apiKey/);
  });
});
