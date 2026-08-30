/**
 * 模块职责：管理 MCP Server、工具注册、输入校验和传输适配。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** 一个 MCP Server 的启动方式、命名空间和允许工具列表。 */
export type McpServerConfig = {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string | undefined;
  args?: readonly string[] | undefined;
  cwd?: string | undefined;
  environment?: Readonly<Record<string, string>> | undefined;
  url?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  requestTimeoutMs?: number | undefined;
  allowedTools?: readonly string[] | undefined;
};

/** MCP tools/list 返回的工具定义和输入 schema。 */
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** 加上 Server 命名空间后的工具定义，供统一 ToolGateway 使用。 */
export type QualifiedMcpTool = McpToolDefinition & {
  name: string;
  serverName: string;
  toolName: string;
};

/** MCP tools/call 的归一化结果；失败和结构化内容均显式保留。 */
export type McpToolCallResult = {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

/** MCP JSON-RPC transport 端口；实现负责 stdio 或其他传输细节。 */
export interface McpRpcTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** 单个 MCP Client 的配置和可注入 transport。 */
export type McpClientOptions = {
  transportFactory?: (config: McpServerConfig) => Promise<McpRpcTransport>;
};

/** MCP 单服务客户端；负责连接生命周期、tools/list、tools/call 和取消通知。 */
export class McpClient {
  private transport: McpRpcTransport | undefined;
  private connected = false;

  constructor(private readonly config: McpServerConfig, private readonly options: McpClientOptions = {}) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = await (this.options.transportFactory ? this.options.transportFactory(this.config) : createTransport(this.config));
    const initialized = await this.transport.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pipeline-factory", version: "4.0.0" },
    });
    if (!initialized || typeof initialized !== "object") throw new Error("MCP initialize returned an invalid result");
    await this.transport.notify("notifications/initialized", {});
    this.connected = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect();
    const result = await this.transport!.request("tools/list", {});
    if (!result || typeof result !== "object" || !Array.isArray((result as Record<string, unknown>).tools)) throw new Error("MCP tools/list returned an invalid result");
    return (result as { tools: unknown[] }).tools.flatMap((tool) => isToolDefinition(tool) ? [tool] : []);
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.connect();
    const result = await this.transport!.request("tools/call", { name, arguments: input });
    if (!result || typeof result !== "object") throw new Error("MCP tools/call returned an invalid result");
    return result as McpToolCallResult;
  }

  async cancel(requestId: string | number, reason = "cancelled"): Promise<void> {
    await this.connect();
    await this.transport!.notify("notifications/cancelled", { requestId, reason });
  }

  async close(): Promise<void> {
    this.connected = false;
    const transport = this.transport;
    this.transport = undefined;
    await transport?.close();
  }
}

/** 多 Server 注册表的依赖注入选项。 */
export type McpToolRegistryOptions = {
  clientFactory?: (config: McpServerConfig) => McpClient;
};

/** 为多个 MCP Server 建立命名空间和 allowlist，防止未注册工具被模型直接调用。 */
export class McpToolRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly discovered = new Map<string, QualifiedMcpTool>();

  constructor(private readonly configs: readonly McpServerConfig[], private readonly options: McpToolRegistryOptions = {}) {}

  async discover(): Promise<QualifiedMcpTool[]> {
    this.discovered.clear();
    for (const config of this.configs) {
      const client = this.clientFor(config);
      const tools = await client.listTools();
      for (const tool of tools) {
        const qualifiedName = qualify(config.name, tool.name);
        this.discovered.set(qualifiedName, { ...tool, name: qualifiedName, serverName: config.name, toolName: tool.name });
      }
    }
    return [...this.discovered.values()];
  }

  async call(qualifiedName: string, input: Record<string, unknown>): Promise<McpToolCallResult> {
    const tool = this.discovered.get(qualifiedName) ?? (await this.discover()).find((candidate) => candidate.name === qualifiedName);
    if (!tool) throw new Error("MCP tool " + qualifiedName + " was not discovered");
    const config = this.configs.find((candidate) => candidate.name === tool.serverName);
    if (!config?.allowedTools?.includes(tool.toolName)) throw new Error("MCP tool " + qualifiedName + " is not allowed by server policy");
    validateInput(tool.inputSchema, input);
    return this.clientFor(config).callTool(tool.toolName, input);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
    this.discovered.clear();
  }

  private clientFor(config: McpServerConfig): McpClient {
    const existing = this.clients.get(config.name);
    if (existing) return existing;
    const client = this.options.clientFactory ? this.options.clientFactory(config) : new McpClient(config);
    this.clients.set(config.name, client);
    return client;
  }
}

function qualify(serverName: string, toolName: string): string {
  return "mcp:" + serverName + ":" + toolName;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string");
}

/** 在跨进程调用前执行最小 JSON Schema required/type 校验，失败不发送请求。 */
function validateInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): void {
  if (!schema) return;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) if (!(key in input)) throw new Error("MCP tool input is missing required field " + key);
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return;
  for (const [key, definition] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in input) || !definition || typeof definition !== "object") continue;
    const expected = (definition as Record<string, unknown>).type;
    if (typeof expected !== "string") continue;
    const actual = typeof input[key];
    if ((expected === "integer" && (!Number.isInteger(input[key]) || actual !== "number")) || (expected !== "integer" && expected !== "number" && actual !== expected)) throw new Error("MCP tool input field " + key + " has an invalid type");
  }
}

function createTransport(config: McpServerConfig): Promise<McpRpcTransport> {
  if (config.transport === "stdio") {
    if (!config.command) return Promise.reject(new Error("MCP stdio server " + config.name + " has no command"));
    return Promise.resolve(new StdioMcpTransport(config.command, config.args ?? [], config.cwd ?? process.cwd(), config.environment ?? {}, config.requestTimeoutMs ?? 120_000));
  }
  if (!config.url) return Promise.reject(new Error("MCP Streamable HTTP server " + config.name + " has no URL"));
  return Promise.resolve(new StreamableHttpMcpTransport(config.url, config.headers ?? {}, config.requestTimeoutMs ?? 120_000));
}

class StdioMcpTransport implements McpRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(command: string, args: readonly string[], cwd: string, environment: Readonly<Record<string, string>>, private readonly timeoutMs: number) {
    this.child = spawn(command, [...args], { cwd, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(String(chunk)));
    this.child.once("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) this.failAll(new Error("MCP stdio server exited with " + (signal ?? code ?? "unknown status")));
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP stdio transport is closed"));
    const id = String(this.nextId++);
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request " + method + " timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("MCP stdio transport is closed");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP stdio transport closed"));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (id === undefined || (message.result === undefined && message.error === undefined)) continue;
        const pending = this.pending.get(String(id));
        if (!pending) continue;
        this.pending.delete(String(id));
        clearTimeout(pending.timer);
        if (message.error && typeof message.error === "object") pending.reject(new Error(String((message.error as Record<string, unknown>).message ?? "MCP request failed")));
        else pending.resolve(message.result);
      } catch {
        this.failAll(new Error("MCP stdio transport received invalid JSON"));
      }
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class StreamableHttpMcpTransport implements McpRpcTransport {
  private sessionId: string | undefined;
  private closed = false;

  constructor(private readonly url: string, private readonly headers: Readonly<Record<string, string>>, private readonly timeoutMs: number) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("MCP HTTP transport is closed");
    return this.post({ jsonrpc: "2.0", id: String(Date.now()) + "-" + Math.random().toString(36).slice(2), method, params }, true);
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("MCP HTTP transport is closed");
    await this.post({ jsonrpc: "2.0", method, params }, false);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async post(message: Record<string, unknown>, expectsResult: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...this.headers, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;
      if (!response.ok) throw new Error("MCP HTTP request failed with status " + response.status);
      if (!expectsResult) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const value = contentType.includes("text/event-stream") ? parseSse(body) : JSON.parse(body);
      if (!value || typeof value !== "object") throw new Error("MCP HTTP response was invalid");
      const messageValue = value as Record<string, unknown>;
      if (messageValue.error && typeof messageValue.error === "object") throw new Error(String((messageValue.error as Record<string, unknown>).message ?? "MCP HTTP request failed"));
      return messageValue.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseSse(body: string): unknown {
  const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
  if (!data) throw new Error("MCP HTTP event stream did not contain a data message");
  return JSON.parse(data);
}
