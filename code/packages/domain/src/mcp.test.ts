/**
 * 测试职责：验证 mcp 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { McpClient, McpToolRegistry, type McpRpcTransport } from "./index.js";

function fakeTransport(calls: Array<{ method: string; params: Record<string, unknown> }>): McpRpcTransport {
  return {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-mcp", version: "1.0.0" } };
      if (method === "tools/list") return { tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object" } }] };
      if (method === "tools/call") return { content: [{ type: "text", text: "found" }], structuredContent: { matches: 1 }, isError: false };
      return {};
    },
    async notify(method, params) {
      calls.push({ method, params });
    },
    async close() { return undefined; },
  };
}

describe("MCP client and registry", () => {
  it("initializes, discovers tools, calls a tool, and sends cancellation", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new McpClient({ name: "docs", transport: "stdio", command: "test-mcp", args: [] }, { transportFactory: async () => fakeTransport(calls) });

    await client.connect();
    await expect(client.listTools()).resolves.toMatchObject([{ name: "search", description: "Search docs" }]);
    await expect(client.callTool("search", { query: "limits" })).resolves.toMatchObject({ structuredContent: { matches: 1 } });
    await client.cancel("request-1", "user_cancelled");

    expect(calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "notifications/cancelled"]);
    expect(calls[3]).toMatchObject({ params: { name: "search", arguments: { query: "limits" } } });
    await client.close();
  });

  it("qualifies discovered tools and refuses unconfigured MCP calls", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const registry = new McpToolRegistry([{
      name: "docs",
      transport: "stdio",
      command: "test-mcp",
      args: [],
      allowedTools: ["search"],
    }], { clientFactory: (config) => new McpClient(config, { transportFactory: async () => fakeTransport(calls) }) });

    await expect(registry.discover()).resolves.toEqual([{ name: "mcp:docs:search", serverName: "docs", toolName: "search", description: "Search docs", inputSchema: { type: "object" } }]);
    await expect(registry.call("mcp:docs:search", { query: "limits" })).resolves.toMatchObject({ structuredContent: { matches: 1 } });
    await expect(registry.call("mcp:docs:unknown", {})).rejects.toThrow(/not discovered|not allowed/i);
  });
});
