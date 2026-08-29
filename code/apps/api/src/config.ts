import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const commandSchema = z.object({
  commandId: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string()).default({}),
});

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
    maxAutoContinuationTurns: z.number().int().min(0).max(20).default(4),
  }).default({}),
});

export type FactoryConfig = z.infer<typeof configSchema> & {
  configPath: string;
};

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
