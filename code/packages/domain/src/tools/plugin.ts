/**
 * 模块职责：管理插件清单、插件工具注册及其受控调用桥接。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Plugin manifest 声明的工具名称、描述和输入约束。 */
export type PluginToolDefinition = {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
};

/** 插件身份、协议版本和工具清单；注册前必须通过 manifest 校验。 */
export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  tools: PluginToolDefinition[];
};

/** 宿主为插件工具提供的受控调用入口。 */
export type PluginToolHandler = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
/** 插件是否允许被 ToolGateway 调用。 */
export type PluginStatus = "ACTIVE" | "DISABLED";

type RegisteredPlugin = {
  manifest: PluginManifest;
  status: PluginStatus;
  disabledReason: string | null;
  handler?: PluginToolHandler | undefined;
};

/** 暴露给模型的带插件命名空间的工具定义。 */
export type PluginTool = {
  name: string;
  pluginId: string;
  toolName: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
};

/** 插件工具的宿主桥接；插件状态和输入校验在进入 handler 前统一检查。 */
export class PluginToolBridge {
  private readonly plugins = new Map<string, RegisteredPlugin>();

  register(manifest: PluginManifest, handler?: PluginToolHandler): void {
    this.plugins.set(manifest.id, { manifest, status: "ACTIVE", disabledReason: null, ...(handler ? { handler } : {}) });
  }

  unregister(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  disable(pluginId: string, reason = "disabled"): void {
    const plugin = this.requirePlugin(pluginId);
    plugin.status = "DISABLED";
    plugin.disabledReason = reason;
  }

  enable(pluginId: string): void {
    const plugin = this.requirePlugin(pluginId);
    plugin.status = "ACTIVE";
    plugin.disabledReason = null;
  }

  listTools(): PluginTool[] {
    return [...this.plugins.values()].flatMap((plugin) => plugin.manifest.tools.map((tool) => ({
      ...tool,
      name: qualify(plugin.manifest.id, tool.name),
      pluginId: plugin.manifest.id,
      toolName: tool.name,
    })));
  }

  async call(qualifiedName: string, input: Record<string, unknown>): Promise<unknown> {
    const parsed = parseQualifiedName(qualifiedName);
    const plugin = this.requirePlugin(parsed.pluginId);
    if (plugin.status !== "ACTIVE") throw new Error("Plugin " + parsed.pluginId + " is disabled");
    const tool = plugin.manifest.tools.find((candidate) => candidate.name === parsed.toolName);
    if (!tool) throw new Error("Plugin tool " + qualifiedName + " was not registered");
    validateInput(tool.inputSchema, input);
    if (!plugin.handler) throw new Error("Plugin " + parsed.pluginId + " has no host bridge");
    return plugin.handler(parsed.toolName, input);
  }

  private requirePlugin(pluginId: string): RegisteredPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error("Plugin " + pluginId + " is not registered");
    return plugin;
  }
}

/** 插件发现和注册策略；supportedApiMajor 防止协议不兼容插件被加载。 */
export type PluginRegistryOptions = {
  supportedApiMajor?: number;
  bridge?: PluginToolBridge;
};

/** 从插件目录发现并校验 manifest，注册后再暴露给 ToolGateway。 */
export class PluginRegistry {
  readonly bridge: PluginToolBridge;
  private readonly supportedApiMajor: number;

  constructor(options: PluginRegistryOptions = {}) {
    this.bridge = options.bridge ?? new PluginToolBridge();
    this.supportedApiMajor = options.supportedApiMajor ?? 1;
  }

  register(manifest: PluginManifest, handler?: PluginToolHandler): void {
    validateManifest(manifest, this.supportedApiMajor);
    if (this.bridge.listTools().some((tool) => tool.pluginId === manifest.id)) throw new Error("Plugin " + manifest.id + " is already registered");
    this.bridge.register(manifest, handler);
  }

  async discover(directories: readonly string[]): Promise<PluginManifest[]> {
    const discovered: PluginManifest[] = [];
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifest = await readManifest(join(directory, entry.name, ".codex-plugin", "plugin.json"));
        if (!manifest) continue;
        if (this.bridge.listTools().some((tool) => tool.pluginId === manifest.id)) {
          discovered.push(manifest);
          continue;
        }
        this.register(manifest);
        discovered.push(manifest);
      }
    }
    return discovered;
  }

  listTools(): PluginTool[] {
    return this.bridge.listTools();
  }

  disable(pluginId: string, reason?: string): void {
    this.bridge.disable(pluginId, reason);
  }

  enable(pluginId: string): void {
    this.bridge.enable(pluginId);
  }

  unregister(pluginId: string): void {
    this.bridge.unregister(pluginId);
  }
}

function qualify(pluginId: string, toolName: string): string {
  return "plugin:" + pluginId + ":" + toolName;
}

function parseQualifiedName(qualifiedName: string): { pluginId: string; toolName: string } {
  const prefix = "plugin:";
  if (!qualifiedName.startsWith(prefix)) throw new Error("Invalid plugin tool name " + qualifiedName);
  const value = qualifiedName.slice(prefix.length);
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new Error("Invalid plugin tool name " + qualifiedName);
  return { pluginId: value.slice(0, separator), toolName: value.slice(separator + 1) };
}

/** 拒绝缺少身份、工具或不兼容 API major version 的插件。 */
function validateManifest(manifest: PluginManifest, supportedApiMajor: number): void {
  if (!manifest.id || !manifest.name || !manifest.version || !manifest.apiVersion || !Array.isArray(manifest.tools)) throw new Error("Invalid plugin manifest");
  const apiMajor = Number.parseInt(manifest.apiVersion.split(".")[0] ?? "", 10);
  if (!Number.isInteger(apiMajor) || apiMajor !== supportedApiMajor) throw new Error("Plugin API version is incompatible");
  if (manifest.tools.some((tool) => !tool.name)) throw new Error("Plugin manifest contains an invalid tool");
}

function validateInput(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): void {
  if (!schema) return;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) if (!(key in input)) throw new Error("Plugin tool input is missing required field " + key);
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return;
  for (const [key, definition] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in input) || !definition || typeof definition !== "object") continue;
    const expected = (definition as Record<string, unknown>).type;
    if (typeof expected !== "string") continue;
    const actual = typeof input[key];
    if ((expected === "integer" && (!Number.isInteger(input[key]) || actual !== "number")) || (expected !== "integer" && expected !== "number" && actual !== expected)) throw new Error("Plugin tool input field " + key + " has an invalid type");
  }
}

async function readManifest(path: string): Promise<PluginManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PluginManifest;
  } catch {
    return null;
  }
}
