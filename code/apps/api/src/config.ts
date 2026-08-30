/**
 * 模块职责：负责 Factory 配置的 schema 校验、路径解析和默认配置加载。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const commandSchema = z.object({
  commandId: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string()).default({}),
});

const mcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "streamable-http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  environment: z.record(z.string()).default({}),
  url: z.string().url().optional(),
  headers: z.record(z.string()).default({}),
  requestTimeoutMs: z.number().int().positive().default(120_000),
  allowedTools: z.array(z.string().min(1)).default([]),
});

const pluginsSchema = z.object({
  directories: z.array(z.string().min(1)).default([]),
  supportedApiMajor: z.number().int().positive().default(1),
  allowedTools: z.array(z.string().min(1)).default([]),
}).default({});

const computerUseSchema = z.object({
  enabled: z.boolean().default(false),
  requireApproval: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(120_000),
}).default({});

const roleSchema = z.object({
  model: z.string().min(1),
  mode: z.enum(["plan", "default"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  developerInstructions: z.string().optional(),
  loopMode: z.enum(["provider-controlled", "factory-controlled"]).default("provider-controlled"),
});

const configSchema = z.object({
  server: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(4310),
  }).default({}),
  web: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(5173),
  }).default({}),
  storage: z.object({
    databasePath: z.string().min(1).default("./var/pipeline-factory.sqlite"),
    worktreeRoot: z.string().min(1).default("./var/worktrees"),
  }).default({}),
  project: z.object({
    root: z.string().min(1).default(".."),
    commands: z.array(commandSchema).default([]),
  }).default({}),
  mcp: z.object({
    servers: z.array(mcpServerSchema).default([]),
  }).default({}),
  plugins: pluginsSchema,
  computerUse: computerUseSchema,
  model: z.object({
    backend: z.enum(["codex-app-server", "openai-responses", "stub"]).default("codex-app-server"),
    codexAppServer: z.object({
      command: z.string().min(1).default("codex"),
      args: z.array(z.string()).default(["app-server", "--stdio", "--enable", "default_mode_request_user_input"]),
      cwd: z.string().min(1).default(".."),
      startupTimeoutMs: z.number().int().positive().default(15_000),
      requestTimeoutMs: z.number().int().positive().default(120_000),
      maxRestarts: z.number().int().min(0).default(3),
      clientName: z.string().min(1).default("pipeline-factory"),
      clientVersion: z.string().min(1).default("4.0.0"),
    }).optional(),
    openai: z.object({
      apiKey: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
    }).optional(),
    roles: z.object({
      explorer: roleSchema.default({ model: "gpt-5.6-luna", temperature: 0.1 }),
      executor: roleSchema.default({ model: "gpt-5.6-luna", temperature: 0 }),
    }).default({}),
    loop: z.object({
      maxSteps: z.number().int().positive().default(40),
      maxDurationMs: z.number().int().positive().default(1_800_000),
      maxRepeatedToolCalls: z.number().int().nonnegative().default(2),
      maxNoProgressSteps: z.number().int().positive().default(3),
      requireFactoryToolGatewayForExecutor: z.boolean().default(false),
    }).default({}),
  }).default({}),
  runtime: z.object({
    globalConcurrency: z.number().int().positive().default(4),
    projectConcurrency: z.number().int().positive().default(2),
    defaultTimeoutMs: z.number().int().positive().default(120_000),
    executionTimeoutMs: z.number().int().positive().default(1_800_000),
    maxAutoContinuationTurns: z.number().int().min(0).max(20).default(4),
  }).default({}),
});

/** 经过 Zod 校验且已完成相对路径解析的服务级配置。 */
export type FactoryConfig = z.infer<typeof configSchema> & {
  configPath: string;
};

/** 从当前目录向上寻找配置文件，支持脚本从仓库任意子目录启动。 */
export function resolveConfigPath(configPath: string | undefined, startDirectory = process.cwd()): string {
  const requestedPath = configPath ?? "./config/pipeline-factory.config.json";
  if (isAbsolute(requestedPath)) return requestedPath;
  let directory = resolve(startDirectory);
  while (true) {
    const candidate = resolve(directory, requestedPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return resolve(startDirectory, requestedPath);
    directory = parent;
  }
}

/** 读取并校验严格 JSON 配置，同时将存储、Project、MCP 和插件路径解析为绝对路径。 */
export function loadFactoryConfig(configPath = resolveConfigPath(undefined)): FactoryConfig {
  const absoluteConfigPath = resolveConfigPath(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absoluteConfigPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read Factory configuration ${absoluteConfigPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid Factory configuration ${absoluteConfigPath}: ${parsed.error.message}`);
  const baseDirectory = dirname(absoluteConfigPath);
  return {
    ...parsed.data,
    configPath: absoluteConfigPath,
    storage: {
      ...parsed.data.storage,
      databasePath: resolveFromConfig(baseDirectory, parsed.data.storage.databasePath),
      worktreeRoot: resolveFromConfig(baseDirectory, parsed.data.storage.worktreeRoot),
    },
    project: {
      ...parsed.data.project,
      root: resolveFromConfig(baseDirectory, parsed.data.project.root),
    },
    mcp: {
      servers: parsed.data.mcp.servers.map((server) => ({ ...server, ...(server.cwd ? { cwd: resolveFromConfig(baseDirectory, server.cwd) } : {}) })),
    },
    plugins: {
      ...parsed.data.plugins,
      directories: parsed.data.plugins.directories.map((directory) => resolveFromConfig(baseDirectory, directory)),
    },
    model: {
      ...parsed.data.model,
      codexAppServer: parsed.data.model.codexAppServer ? {
        ...parsed.data.model.codexAppServer,
        cwd: resolveFromConfig(baseDirectory, parsed.data.model.codexAppServer.cwd),
      } : undefined,
    },
  };
}

function resolveFromConfig(baseDirectory: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}
