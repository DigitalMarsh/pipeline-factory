/**
 * 模块职责：**模型后端适配器注册表** —— 把"配置里的 kind"映射到具体 `ModelGateway` 实现。
 *
 * 为什么需要它：此前 `createBackendGateway()` 用一条 `if (kind === …)` 链同时承担"有哪些后端"
 *   与"每个后端怎么构造"。加一个后端就要改核心组合根、改测试里的白名单，且顺序一旦写错
 *   （例如 codex 落在默认分支）会把配置错误变成运行期才出现的怪行为。注册表把这两件事分开：
 *   组合根只问注册表"用这个 kind 造一个"，扩展方自己声明构造方式。
 *
 * 维护提示：
 *   1) **凭据仍然只从 `ResolvedModelBackend` 读**：注册表是构造点的分发，不是配置读取点。
 *      不要在这里读 `process.env` 或配置文件——"Factory 不在项目里存 API key"的边界靠这一点。
 *   2) 缺必需字段时**构造期抛错**（例如 openai 没 apiKey、codex 没 codexAppServer 块）：
 *      启动期失败好过第一次探索跑到一半才失败。
 *   3) 这里只做进程内注册，不做插件隔离；第三方后端若要做成独立包，注册表就是入口，
 *      但加载与信任策略应留在组合根。
 *   4) 工具/命令的扩展不走这里：MCP 与 Plugin 已有 `McpToolRegistry` / `PluginRegistry`，
 *      项目命令是数据驱动（`RegisteredCommandExecutor`），不要重复造一套。
 */
import { ClaudeAgentSdkGateway, CodexAppServerGateway, OpenAIModelGateway, StubModelGateway } from "@pipeline-factory/core";
import type { ModelGateway, ModelRole } from "@pipeline-factory/core";
import type { ResolvedModelBackend } from "../config.js";

/** `config.model.roles` 经 zod 校验后的形状；注册表不二次校验，只做类型收敛。 */
export type ModelBackendRoleConfig = {
  model: string;
  backend?: string | undefined;
  mode?: "plan" | "default" | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
  loopMode?: "provider-controlled" | "factory-controlled" | undefined;
};

export type ModelBackendFactoryContext = {
  roles: Record<ModelRole, ModelBackendRoleConfig>;
  /** Loop 的步数上限；Claude 的单次 query 回合上限与它同源。 */
  maxSteps: number;
};

/** 一个后端 kind 的构造器。允许抛错——错误在第一次真正用到该后端时暴露。 */
export type ModelBackendFactory = (backend: ResolvedModelBackend, context: ModelBackendFactoryContext) => ModelGateway;

export class ModelBackendRegistry {
  private readonly factories = new Map<string, ModelBackendFactory>();

  register(kind: string, factory: ModelBackendFactory): this {
    if (this.factories.has(kind)) throw new Error(`Model backend kind "${kind}" is already registered`);
    this.factories.set(kind, factory);
    return this;
  }

  has(kind: string): boolean {
    return this.factories.has(kind);
  }

  /** 已注册的 kind，按名称排序；诊断与错误信息用。 */
  kinds(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(backend: ResolvedModelBackend, context: ModelBackendFactoryContext): ModelGateway {
    const factory = this.factories.get(backend.kind);
    if (!factory) throw new Error(`Unsupported model backend kind "${backend.kind}". Registered kinds: ${this.kinds().join(", ")}.`);
    return factory(backend, context);
  }
}

/**
 * 内置的四个后端。顺序无关；重复注册会在 `register()` 里直接失败，避免"后注册的悄悄覆盖"。
 */
export function createDefaultModelBackendRegistry(): ModelBackendRegistry {
  return new ModelBackendRegistry()
    .register("stub", (_backend, { roles }) => new StubModelGateway(roles as never))
    .register("claude-agent-sdk", (backend, { roles, maxSteps }) => {
      const claude = backend.claudeAgent;
      return new ClaudeAgentSdkGateway({
        roles: roles as never,
        ...(claude?.baseUrl ? { baseUrl: claude.baseUrl } : {}),
        ...(claude?.authToken ? { authToken: claude.authToken } : {}),
        ...(claude?.settingsPath ? { settingsPath: claude.settingsPath } : {}),
        ...(claude?.env && Object.keys(claude.env).length > 0 ? { env: claude.env } : {}),
        // 单次 query 的回合上限与 loop 的步数上限同源：Provider 内部回合不该比 loop 允许的步骤还多。
        maxTurns: claude?.maxTurns ?? maxSteps,
      });
    })
    .register("openai-responses", (backend, { roles }) => {
      const openai = backend.openai;
      if (!openai?.apiKey)
        throw new Error(
          `Factory configuration requires an apiKey for the openai-responses backend${backend.source === "registry" ? ` "${backend.id}"` : ""}`,
        );
      return new OpenAIModelGateway({
        apiKey: openai.apiKey,
        roles: roles as never,
        ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}),
      });
    })
    .register("codex-app-server", (backend, { roles }) => {
      const appServer = backend.codexAppServer;
      if (!appServer)
        throw new Error(`Factory configuration requires model.codexAppServer (or a model.backends entry) for the codex-app-server backend`);
      return new CodexAppServerGateway({
        roles: roles as never,
        command: appServer.command,
        args: appServer.args,
        cwd: appServer.cwd,
        startupTimeoutMs: appServer.startupTimeoutMs,
        requestTimeoutMs: appServer.requestTimeoutMs,
        maxRestarts: appServer.maxRestarts,
        clientName: appServer.clientName,
        clientVersion: appServer.clientVersion,
      });
    });
}
