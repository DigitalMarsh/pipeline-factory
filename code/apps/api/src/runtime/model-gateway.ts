/**
 * 模块职责：按 `model.backends` 注册表构造**按角色路由**的 `ModelGateway` ——
 *   `RoutingModelGateway` 负责"这次调用该交给哪个后端"，各具体后端实现保持原样。
 *
 * 为什么需要它：`model.backend` 是进程级单选，而"探索用 Codex、执行用 Claude"要求同一个进程里
 *   两个角色打向不同后端。路由层放在组合根（本文件）而不是 domain，是因为它需要读配置里的端点与
 *   凭据 —— 让 domain 认识 `backends` 会把"Factory 只在组合根读一次密钥"这条边界打破。
 *
 * 维护提示：
 *   1) **这是全仓唯一读取 `config.model.openai.apiKey` 与 `config.model.claudeAgent.authToken`
 *      的地方**（`grep -rn apiKey apps packages` 可复核）。其余 backend 都不需要密钥：`stub` 没有模型，
 *      `codex-app-server` 与 `claude-agent-sdk` 的缺省形态都由子进程自己持有凭证（Claude 侧即
 *      ~/.claude/settings.json，cc-switch 作用的那一层）。**要接新 backend 就在这里加分支，
 *      不要在别处读 `config.model`** —— 凭据读取点收敛成一处，是"Factory 不在项目里存 API key"
 *      这条设计承诺能被审计的前提。
 *   2) 几处 `throw` 都是**启动期失败**：缺少 backend 必需字段时宁可起不来，也不要等到第一次模型调用
 *      才报错——那时错误已经离配置很远了。`probeClaudeEndpoint` 是同一原则的延伸：显式配了
 *      baseUrl（例如 cc-switch 的本地代理）就先探一次，省得第一次探索跑到一半才发现代理没起。
 *   3) **构造分两档**：角色默认后端在启动期构造（配置写错要起不来，warmUp），注册表里其余后端
 *      懒构造（只有某个 Project 真指向它们时才实例化）。构造任何网关都不会拉起 CLI 子进程
 *      （`CodexAppServerGateway` / `ClaudeAgentSdkGateway` 都在第一次 stream 才 spawn），
 *      所以"懒"不改变启动行为，只是让没用到的后端连对象都不存在。
 *   4) **`describeEndpoint(role)` 必须传角色**：多后端下不传就只能回答"混合"，而 Run 事后要回答的
 *      是"这一次到底打到了哪里"。`agent.loop.started` 的 `provider` 字段就靠它。
 *   5) **`answerUserInput` 与 `cancel` 的失败语义刻意不对称**：答案找不到归属就**抛错**（静默丢弃会
 *      让模型一直等输入，用户只看到卡住）；取消找不到归属则**广播给所有已实例化的后端**（漏掉一次
 *      取消会留下一个还在跑的 Provider turn，而每个后端都会忽略不属于自己的 conversationId）。
 */

import { ClaudeAgentSdkGateway, CodexAppServerGateway, OpenAIModelGateway, StubModelGateway } from "@pipeline-factory/domain";
import type { ModelCapabilities, ModelEvent, ModelGateway, ModelInputAnswers, ModelRole, ModelRoleConfig, ModelRequest, ProviderEndpoint } from "@pipeline-factory/domain";
import { resolveModelBackends, roleBackendId, type FactoryConfig, type ResolvedModelBackend } from "../config.js";

const CLAUDE_ENDPOINT_PROBE_TIMEOUT_MS = 2_000;

/** 路由网关的实现依赖；测试可以直接注入替身而不碰配置文件。 */
export type RoutingModelGatewayOptions = {
  /** 按后端 id 造网关。允许抛错（缺必需字段时），错误在第一次用到该后端时暴露。 */
  create: (id: string, backend: ResolvedModelBackend) => ModelGateway;
  backends: Map<string, ResolvedModelBackend>;
  /** 每个角色在全局配置这一层生效的后端 id；Project 覆盖由请求自带的 modelConfig 表达。 */
  roleBackend: Record<ModelRole, string>;
  defaultBackendId: string;
};

/**
 * 把一次调用按"请求覆盖 → 角色默认 → 全局默认"解析到具体后端，并委派给它的实现。
 * 不实现任何模型语义：它只做分派、归属记账和端点汇总。
 */
export class RoutingModelGateway implements ModelGateway {
  private readonly instances = new Map<string, ModelGateway>();
  /** conversationId / inputRequestId → 后端 id，供 answerUserInput 与 cancel 反查。 */
  private readonly owners = new Map<string, string>();

  constructor(private readonly options: RoutingModelGatewayOptions) {}

  /** 已实例化的后端 id；诊断与测试用，不参与业务判定。 */
  instantiatedBackends(): string[] {
    return [...this.instances.keys()];
  }

  /**
   * 启动期构造这些后端（缺必需字段就在这里抛）。**角色默认后端必须走这一步**：
   * 懒构造单独用会把"少了 codexAppServer 块"这类配置错误从启动期推迟到第一次 /health
   * 或第一个回合，而"缺配置宁可起不来"是这个仓的既有立场。
   * 注册表里其余后端仍保持懒构造——它们只有在某个 Project 真的指向它们时才有用。
   */
  warmUp(ids: string[]): void {
    for (const id of new Set(ids)) this.instance(id);
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const id = this.backendIdFor(request.role, request.modelConfig);
    const gateway = this.instance(id);
    // 归属登记必须是**同步**的：async generator 的函数体要等第一次 next() 才执行，而 cancel
    // 可能在第一次 next() 之前就被调用（loop 的截止时间定时器）。
    if (request.conversationId) this.owners.set(request.conversationId, id);
    return this.forward(gateway, request);
  }

  private async *forward(gateway: ModelGateway, request: ModelRequest): AsyncIterable<ModelEvent> {
    for await (const event of gateway.stream(request)) {
      // 结构化提问的答案要回到提出问题的那一个后端；requestId 是 Provider 自己发的标识。
      if (event.type === "turn.input_required") this.owners.set(String(event.request.requestId), this.ownerOfConversation(request));
      yield event;
    }
  }

  async answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void> {
    const owner = this.owners.get(String(input.requestId));
    if (!owner) throw new Error(`No model backend is known for input request ${input.requestId}; the answer cannot be delivered`);
    await this.instance(owner).answerUserInput(input);
  }

  async cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void> {
    const owner = this.owners.get(request.conversationId);
    // 未知归属时广播：漏掉一次取消会留下还在跑的 Provider turn，而被广播的后端都会忽略
    // 不属于自己的 conversationId。这里是 best-effort，与 answerUserInput 的抛错语义不同（见文件头 5）。
    const targets = owner ? [this.instance(owner)] : [...this.instances.values()];
    await Promise.all(targets.map((gateway) => gateway.cancel(request)));
  }

  configFor(role: ModelRole): ModelRoleConfig {
    const id = this.backendIdFor(role);
    return { ...this.instance(id).configFor(role), backend: id };
  }

  capabilities(role: ModelRole, config?: ModelRoleConfig | undefined): ModelCapabilities {
    const id = this.backendIdFor(role, config);
    const gateway = this.instance(id);
    return gateway.capabilities?.(role) ?? unsupportedCapabilities();
  }

  /**
   * `config` 是**调用点这次真正会用的那份角色配置**（Project 快照可以覆盖后端），与
   * `capabilities` 的第二个参数同源。曾经这里只吃角色名，于是按全局角色默认回答——而
   * `agent.loop.started` 的 `provider` 拿它当"这次 Run 由哪个 agent 执行"的**指纹**写进
   * telemetry，最终显示在用量栏的 Agent 那一格。项目覆盖了执行侧后端时，那个格子会指向
   * 根本没跑过的后端（现场：frozen 与项目都写 claude-agent-sdk，用量栏却写 codex）。
   */
  describeEndpoint(role?: ModelRole, config?: ModelRoleConfig | undefined): ProviderEndpoint {
    // 不传角色：只有当两个角色确实指向同一个后端时才敢报一个具体端点，否则如实回答"混合"。
    // 这条路上**不看 `config`** —— 没有角色，那份覆盖配置就无从归属。
    if (!role) {
      const explorer = this.backendIdFor("explorer");
      const executor = this.backendIdFor("executor");
      return explorer === executor ? this.instantiateFingerprint(explorer) : { backend: "mixed", endpoint: null, source: "provider-settings", cliVersion: null, credentialSource: null, providerModel: null };
    }
    // 传了角色就按该角色生效的后端点回答（注意 role 是**角色名**，不是后端 id），
    // 并尊重调用点这次真正会用的那份覆盖配置（见上面的说明）。
    return this.instantiateFingerprint(this.backendIdFor(role, config));
  }

  async close(): Promise<void> {
    const closing = [...this.instances.values()].map((gateway) => {
      const closeable = gateway as ModelGateway & { close?: () => Promise<void> | void };
      return typeof closeable.close === "function" ? Promise.resolve(closeable.close()) : Promise.resolve();
    });
    this.instances.clear();
    this.owners.clear();
    await Promise.all(closing);
  }

  /** 已实例化就返回实例，未实例化则按需构造；构造失败（缺必需字段）在**用到时**抛。 */
  private instance(id: string): ModelGateway {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const backend = this.options.backends.get(id);
    if (!backend) throw new Error(`Unknown model backend "${id}". Known backends: ${[...this.options.backends.keys()].join(", ")}.`);
    const gateway = this.options.create(id, backend);
    this.instances.set(id, gateway);
    return gateway;
  }

  private instantiateFingerprint(id: string): ProviderEndpoint {
    const gateway = this.instance(id);
    const fingerprint = gateway.describeEndpoint?.();
    if (fingerprint) return fingerprint;
    return { backend: this.options.backends.get(id)?.kind ?? id, endpoint: null, source: "provider-settings", cliVersion: null, credentialSource: null, providerModel: null };
  }

  /** 请求覆盖优先于角色默认；都缺省时回到全局默认。 */
  private backendIdFor(role: ModelRole, config?: ModelRoleConfig | undefined): string {
    return config?.backend ?? this.options.roleBackend[role] ?? this.options.defaultBackendId;
  }

  /** 记账用：本次 stream 的 conversationId 实际落在了哪个后端。 */
  private ownerOfConversation(request: ModelRequest): string {
    return request.conversationId ? this.owners.get(request.conversationId) ?? this.backendIdFor(request.role, request.modelConfig) : this.backendIdFor(request.role, request.modelConfig);
  }
}

function unsupportedCapabilities(): ModelCapabilities {
  // 缺省等于"不支持"：Provider 没声明能力时不要把空当成齐全（见 model/types.ts 维护提示 3）。
  return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: [] };
}

/**
 * 按 `model.backends` 注册表构造网关。**单后端时也返回路由网关**，但行为与直接返回该后端一致：
 * `describeEndpoint()` 在两个角色同后端时给出的是同一个指纹。之所以不特判"单后端就直接返回"，
 * 是因为 Project 可以在运行期把某个角色覆盖到另一个后端 —— 特判会让那种覆盖被静默忽略。
 */
export function createModelGateway(config: FactoryConfig): ModelGateway {
  const backends = resolveModelBackends(config.model);
  const roles = config.model.roles as Record<ModelRole, ModelRoleConfigLike>;
  const roleBackend = { explorer: roleBackendId(config.model, "explorer"), executor: roleBackendId(config.model, "executor") };
  const gateway = new RoutingModelGateway({
    backends,
    roleBackend,
    defaultBackendId: config.model.backend,
    create: (_id, backend) => createBackendGateway(backend, roles, config.model.loop.maxSteps),
  });
  // 角色默认后端在启动期构造：配置写错（例如 codex 少了 codexAppServer 块）要在这里就失败。
  gateway.warmUp([roleBackend.explorer, roleBackend.executor]);
  return gateway;
}

/** `config.model.roles` 经 zod 校验后的形状；路由层不二次校验，只做类型收敛。 */
type ModelRoleConfigLike = {
  model: string;
  backend?: string | undefined;
  mode?: "plan" | "default" | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
  loopMode?: "provider-controlled" | "factory-controlled" | undefined;
};

/** 一个后端定义 → 具体实现。缺必需字段在这里抛，错误信息指向配置项本身。 */
function createBackendGateway(backend: ResolvedModelBackend, roles: Record<ModelRole, ModelRoleConfigLike>, maxSteps: number): ModelGateway {
  const kind = backend.kind;
  if (kind === "stub") return new StubModelGateway(roles as never);
  if (kind === "claude-agent-sdk") {
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
  }
  if (kind === "openai-responses") {
    const openai = backend.openai;
    if (!openai?.apiKey) throw new Error(`Factory configuration requires an apiKey for the openai-responses backend${backend.source === "registry" ? ` "${backend.id}"` : ""}`);
    return new OpenAIModelGateway({ apiKey: openai.apiKey, roles: roles as never, ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}) });
  }
  const appServer = backend.codexAppServer;
  if (!appServer) throw new Error(`Factory configuration requires model.codexAppServer (or a model.backends entry) for the codex-app-server backend`);
  return new CodexAppServerGateway({ roles: roles as never, command: appServer.command, args: appServer.args, cwd: appServer.cwd, startupTimeoutMs: appServer.startupTimeoutMs, requestTimeoutMs: appServer.requestTimeoutMs, maxRestarts: appServer.maxRestarts, clientName: appServer.clientName, clientVersion: appServer.clientVersion });
}

/**
 * 显式配置了 Claude 端点的后端各探一次；由组合根在启动阶段 await。
 * 不探"继承 CLI 解析"那一档：那时端点不在配置里，凭空发一次请求既费额度也说明不了问题。
 * 多后端时逐后端探，错误里带上后端 id —— 只说"有个 Claude 端点不通"对排查没用。
 */
export async function probeClaudeEndpoint(config: FactoryConfig): Promise<void> {
  for (const backend of resolveModelBackends(config.model).values()) {
    if (backend.kind !== "claude-agent-sdk") continue;
    const baseUrl = backend.claudeAgent?.baseUrl;
    if (!baseUrl) continue;
    try {
      await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(CLAUDE_ENDPOINT_PROBE_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`Claude Agent endpoint ${baseUrl} (backend "${backend.id}") is not reachable: ${error instanceof Error ? error.message : String(error)}. Start the provider proxy (e.g. cc-switch) or fix model.claudeAgent.baseUrl before launching.`);
    }
  }
}
