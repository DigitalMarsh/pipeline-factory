/**
 * 模块职责：负责 Factory 配置的 schema 校验、路径解析和默认配置加载。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_PLAN_DIRECTORY } from "@pipeline-factory/domain";
import { z } from "zod";

const commandSchema = z.object({
  commandId: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string()).default({}),
  /**
   * 验证 tag 词表（只对 verification 命令有意义）：Plan 的 `verification.suites` 用它挑验证子集。
   * 播种到 Project 设置后即可在控制台里编辑；命令 ID 永远不进模型提示词。
   */
  tags: z.array(z.string().min(1)).default([]),
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

/** 可用的模型后端种类；`model.backends` 的注册项与旧的 `model.backend` 共用这一份取值。 */
const modelKindSchema = z.enum(["codex-app-server", "claude-agent-sdk", "openai-responses", "stub"]);

// 各 kind 的端点字段拆成可复用片段：`model.codexAppServer` / `model.claudeAgent` / `model.openai`
// 与 `model.backends.*` 的注册项共用同一份定义，避免"注册表里少一个字段"这类分叉。
const codexAppServerShape = {
  command: z.string().min(1).default("codex"),
  args: z.array(z.string()).default(["app-server", "--stdio", "--enable", "default_mode_request_user_input"]),
  cwd: z.string().min(1).default(".."),
  startupTimeoutMs: z.number().int().positive().default(15_000),
  requestTimeoutMs: z.number().int().positive().default(120_000),
  maxRestarts: z.number().int().min(0).default(3),
  clientName: z.string().min(1).default("pipeline-factory"),
  clientVersion: z.string().min(1).default("4.0.0"),
};

const claudeAgentShape = {
  baseUrl: z.string().url().optional(),
  authToken: z.string().min(1).optional(),
  /** 等价于 CLI 的 --settings；相对路径按配置文件所在目录解析。 */
  settingsPath: z.string().min(1).optional(),
  env: z.record(z.string()).default({}),
  /** 单次 query 的回合上限；缺省不限制，由 model.loop.maxSteps 兜住步数。 */
  maxTurns: z.number().int().positive().optional(),
};

const openAiShape = {
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
};

const codexAppServerSchema = z.object(codexAppServerShape);
const claudeAgentSchema = z.object(claudeAgentShape);
const openAiSchema = z.object(openAiShape);

/**
 * `model.backends` 的一个注册项：一个具名后端。`kind` 决定它由哪个 Provider 实现，
 * 其余字段按 kind 取用（同一个对象里允许同时出现三类字段，未用到的那些被忽略）。
 * `models` 只驱动控制台的模型下拉，不参与任何后端校验——Factory 不知道 provider 支持什么。
 */
const backendEntrySchema = z.object({
  kind: modelKindSchema,
  ...codexAppServerShape,
  ...claudeAgentShape,
  ...openAiShape,
  models: z.array(z.string().min(1)).default([]),
});

const roleSchema = z.object({
  model: z.string().min(1),
  /**
   * 本角色使用哪个后端。取值为 `model.backends` 的键，或四个 kind 名之一（由
   * `model.codexAppServer` / `model.claudeAgent` / `model.openai` 隐式提供的后端）。
   * 缺省时跟随 `model.backend`。**这是"探索用 Codex、执行用 Claude"的唯一开关。**
   */
  backend: z.string().min(1).optional(),
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
    /**
     * 是否由本进程托管 Web 构建产物。默认关闭，这样测试与 `pnpm dev:api` 的行为
     * 与引入单进程托管之前完全一致；生产方式由 config 显式打开。
     */
    serveWeb: z.boolean().default(false),
    /** Web 构建产物目录，相对配置文件所在目录解析。 */
    webDistPath: z.string().min(1).default("../apps/web/dist"),
  }).default({}),
  web: z.object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(5173),
  }).default({}),
  storage: z.object({
    databasePath: z.string().min(1).default("./var/pipeline-factory.sqlite"),
    worktreeRoot: z.string().min(1).default("./var/worktrees"),
    /**
     * 高频事件的保留天数。**0（缺省）表示不回收**——回收是不可逆地删除事件行，
     * 不该在升级后第一次启动时悄悄开始。设成正数即在每次启动时清理一次。
     * 可回收的类型白名单与判定规则见 packages/domain/src/store/event-retention.ts。
     */
    eventRetentionDays: z.number().int().min(0).default(0),
    /** 每个聚合至少保留多少条可回收事件（避免正在进行的回合被删空）。仅在 eventRetentionDays > 0 时有意义。 */
    eventRetentionMinPerAggregate: z.number().int().min(0).default(200),
  }).default({}),
  project: z.object({
    root: z.string().min(1).default(".."),
    /**
     * Plan 落盘目录，**相对受管工程根目录**（缺省 `docs/pipeline/plans`），也接受绝对路径。
     * 这是**唯一不按配置目录解析**的路径字段：它描述的是"每个受管工程自己的 docs 目录"，
     * 而不是 Factory 自己的目录树——解析放在 runtime/plan-directory.ts，因为那里才知道
     * 当前工程的 repoRoot（每个 Project 可以有不同的根）。见 domain 的 plan/plan-directory.ts。
     */
    planDirectory: z.string().min(1).default(DEFAULT_PLAN_DIRECTORY),
    commands: z.array(commandSchema).default([]),
  }).default({}),
  mcp: z.object({
    servers: z.array(mcpServerSchema).default([]),
  }).default({}),
  plugins: pluginsSchema,
  computerUse: computerUseSchema,
  model: z.object({
    /** 未在角色（或 Project）上指定 backend 时使用的默认后端。 */
    backend: modelKindSchema.default("codex-app-server"),
    /**
     * 具名后端注册表。**整块缺省是合法且常见的用法**：四个 kind 名本身就能当 id 用
     * （`codex-app-server` / `claude-agent-sdk` / `openai-responses` / `stub`），端点由下面
     * 三块兼容配置提供。只有需要"同类两个不同端点"（例如探索走官方 Claude、执行走
     * DeepSeek 兼容端点）时才在这里注册第二个同 kind 的后端。
     *
     * 同名注册项会**覆盖**隐式后端（例如把 `codex-app-server` 重新指到另一个 cwd）。
     */
    backends: z.record(z.string().min(1), backendEntrySchema).default({}),
    codexAppServer: codexAppServerSchema.optional(),
    /**
     * Claude Agent SDK 后端的可选覆盖。**整块缺省是完全合法的用法**：不传 env、不读密钥，
     * 端点与凭据都由 CLI 自己解析（~/.claude/settings.json，cc-switch 就作用在这一层）。
     * 只有需要把端点写死在配置里时才填 baseUrl/authToken。
     */
    claudeAgent: claudeAgentSchema.optional(),
    openai: openAiSchema.optional(),
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
    /** @deprecated Retained for reading legacy config; Agent Loop uses model.loop.maxSteps. */
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
    throw new Error(`Unable to read Factory configuration ${absoluteConfigPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid Factory configuration ${absoluteConfigPath}: ${parsed.error.message}`);
  const baseDirectory = dirname(absoluteConfigPath);
  return {
    ...parsed.data,
    configPath: absoluteConfigPath,
    server: {
      ...parsed.data.server,
      webDistPath: resolveFromConfig(baseDirectory, parsed.data.server.webDistPath),
    },
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
      backends: Object.fromEntries(Object.entries(parsed.data.model.backends).map(([id, backend]) => [id, resolveBackendPaths(baseDirectory, backend)])),
      codexAppServer: parsed.data.model.codexAppServer ? {
        ...parsed.data.model.codexAppServer,
        cwd: resolveFromConfig(baseDirectory, parsed.data.model.codexAppServer.cwd),
      } : undefined,
      claudeAgent: parsed.data.model.claudeAgent ? {
        ...parsed.data.model.claudeAgent,
        ...(parsed.data.model.claudeAgent.settingsPath ? { settingsPath: resolveFromConfig(baseDirectory, parsed.data.model.claudeAgent.settingsPath) } : {}),
      } : undefined,
    },
  };
}

/** 注册项里的相对路径与兼容配置块按同一规则解析，避免同一个含义出现两种基准目录。 */
function resolveBackendPaths(baseDirectory: string, backend: z.infer<typeof backendEntrySchema>): z.infer<typeof backendEntrySchema> {
  return {
    ...backend,
    cwd: resolveFromConfig(baseDirectory, backend.cwd),
    ...(backend.settingsPath ? { settingsPath: resolveFromConfig(baseDirectory, backend.settingsPath) } : {}),
  };
}

export type ModelBackendKind = z.infer<typeof modelKindSchema>;
/** 一个可被角色（或 Project）引用的后端；`source` 说明它是注册表项还是兼容配置块生成的隐式后端。 */
export type ResolvedModelBackend = {
  id: string;
  kind: ModelBackendKind;
  source: "registry" | "implicit";
  /** 控制台模型下拉用的候选模型；空数组表示"由使用方自行填写"。 */
  models: string[];
  codexAppServer?: z.infer<typeof codexAppServerSchema> | undefined;
  claudeAgent?: z.infer<typeof claudeAgentSchema> | undefined;
  openai?: z.infer<typeof openAiSchema> | undefined;
};

/**
 * 把配置解析成"后端 id → 后端定义"的映射，并校验**每个角色引用的 id 都能解析**。
 *
 * 隐式 id（四个 kind 名）永远存在，端点来自 `model.codexAppServer` / `model.claudeAgent` /
 * `model.openai`；缺块时不是在这里报错，而是由构造具体网关时按各自必需字段失败——
 * 与"缺配置宁可起不来"同一条原则，只是换了个更靠近原因的层（见 runtime/model-gateway.ts）。
 * 注册表项**同名覆盖**隐式项，这也让"把 codex-app-server 指到另一个 cwd"不需要新概念。
 */
export function resolveModelBackends(model: FactoryConfig["model"]): Map<string, ResolvedModelBackend> {
  const backends = new Map<string, ResolvedModelBackend>();
  const implicit = (id: ModelBackendKind): ResolvedModelBackend => ({
    id,
    kind: id,
    source: "implicit",
    models: [],
    ...(id === "codex-app-server" ? { codexAppServer: model.codexAppServer } : {}),
    ...(id === "claude-agent-sdk" ? { claudeAgent: model.claudeAgent } : {}),
    ...(id === "openai-responses" ? { openai: model.openai } : {}),
  });
  for (const kind of modelKindSchema.options) backends.set(kind, implicit(kind));
  for (const [id, backend] of Object.entries(model.backends)) {
    backends.set(id, {
      id,
      kind: backend.kind,
      source: "registry",
      models: backend.models,
      ...(backend.kind === "codex-app-server" ? { codexAppServer: backend } : {}),
      ...(backend.kind === "claude-agent-sdk" ? { claudeAgent: backend } : {}),
      ...(backend.kind === "openai-responses" ? { openai: backend } : {}),
    });
  }
  for (const role of ["explorer", "executor"] as const) {
    const id = model.roles[role].backend ?? model.backend;
    if (!backends.has(id)) throw new Error(`Invalid Factory configuration: model.roles.${role}.backend "${id}" is not defined. Known backends: ${[...backends.keys()].join(", ")}.`);
  }
  return backends;
}

/** 某个角色（在全局配置这一层）当前生效的后端 id。Project 级覆盖在 domain 侧解析。 */
export function roleBackendId(model: FactoryConfig["model"], role: "explorer" | "executor"): string {
  return model.roles[role].backend ?? model.backend;
}

function resolveFromConfig(baseDirectory: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}
