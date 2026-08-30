/**
 * 测试职责：验证 plugin 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRegistry, PluginToolBridge, type PluginManifest } from "./index.js";

const manifest: PluginManifest = {
  id: "com.example.docs",
  name: "Docs Plugin",
  version: "1.2.0",
  apiVersion: "1.0",
  tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }],
};

describe("Plugin registry and bridge", () => {
  it("registers compatible plugins, exposes tools, and bridges validated calls", async () => {
    const bridge = new PluginToolBridge();
    const registry = new PluginRegistry({ supportedApiMajor: 1, bridge });
    registry.register(manifest, async (toolName, input) => ({ toolName, query: input.query }));

    expect(registry.listTools()).toEqual([{ name: "plugin:com.example.docs:search", pluginId: manifest.id, toolName: "search", description: "Search docs", inputSchema: { type: "object" } }]);
    await expect(bridge.call("plugin:com.example.docs:search", { query: "limits" })).resolves.toMatchObject({ query: "limits" });
    registry.disable(manifest.id, "maintenance");
    await expect(bridge.call("plugin:com.example.docs:search", {})).rejects.toThrow(/disabled/i);
    registry.enable(manifest.id);
    await expect(bridge.call("plugin:com.example.docs:search", {})).resolves.toMatchObject({ toolName: "search" });
  });

  it("rejects incompatible plugin API versions and duplicate ids", () => {
    const registry = new PluginRegistry({ supportedApiMajor: 1 });
    expect(() => registry.register({ ...manifest, apiVersion: "2.0" })).toThrow(/incompatible/i);
    registry.register(manifest);
    expect(() => registry.register(manifest)).toThrow(/already registered/i);
  });

  it("discovers manifests from .codex-plugin directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-plugins-"));
    try {
      await mkdir(join(root, "docs", ".codex-plugin"), { recursive: true });
      await writeFile(join(root, "docs", ".codex-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
      const registry = new PluginRegistry({ supportedApiMajor: 1 });

      await expect(registry.discover([root])).resolves.toMatchObject([{ id: manifest.id, version: "1.2.0" }]);
      expect(registry.listTools()[0]).toMatchObject({ name: "plugin:com.example.docs:search" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
