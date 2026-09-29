/**
 * 模块职责：按 `config.model.backend` 选一个 `ModelGateway` 实现并构造它 ——
 *   `stub`（测试替身）/ `openai-responses` / `codex-app-server`（默认）/ `claude-agent-sdk`。
 *
 * 维护提示：
 *   1) **这是全仓唯一读取 `config.model.openai.apiKey` 与 `config.model.claudeAgent.authToken`
 *      的地方**（`grep -rn apiKey apps packages` 可复核）。其余 backend 都不需要密钥：`stub` 没有模型，
 *      `codex-app-server` 与 `claude-agent-sdk` 的缺省形态都由子进程自己持有凭证（Claude 侧即
 *      ~/.claude/settings.json，cc-switch 作用的那一层）。**要接新 backend 就在这里加分支，
 *      不要在别处读 `config.model`** —— 凭据读取点收敛成一处，是"Factory 不在项目里存 API key"
 *      这条设计承诺能被审计的前提。
 *   2) `roles` 上的类型断言把 config 的松散结构收敛成 `Record<ModelRole, ...>`；真正的校验收敛在
 *      `config.ts` 的 zod schema 里，这里不做二次校验。
 *   3) 几处 `throw` 都是**启动期失败**：缺少 backend 必需字段时宁可起不来，也不要等到第一次模型调用
 *      才报错——那时错误已经离配置很远了。`probeClaudeEndpoint` 是同一原则的延伸：显式配了
 *      baseUrl（例如 cc-switch 的本地代理）就先探一次，省得第一次探索跑到一半才发现代理没起。
 */
import { ClaudeAgentSdkGateway, CodexAppServerGateway, OpenAIModelGateway, StubModelGateway } from "@pipeline-factory/domain";
import type { ModelGateway, ModelRole } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";

const CLAUDE_ENDPOINT_PROBE_TIMEOUT_MS = 2_000;

export function createModelGateway(config: FactoryConfig): ModelGateway {
  const roles = config.model.roles as Record<ModelRole, { model: string; mode?: "plan" | "default"; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string; loopMode?: "provider-controlled" | "factory-controlled" }>;
  if (config.model.backend === "stub") return new StubModelGateway(roles);
  if (config.model.backend === "claude-agent-sdk") {
    const claude = config.model.claudeAgent;
    return new ClaudeAgentSdkGateway({
      roles,
      ...(claude?.baseUrl ? { baseUrl: claude.baseUrl } : {}),
      ...(claude?.authToken ? { authToken: claude.authToken } : {}),
      ...(claude?.settingsPath ? { settingsPath: claude.settingsPath } : {}),
      ...(claude?.env && Object.keys(claude.env).length > 0 ? { env: claude.env } : {}),
      // 单次 query 的回合上限与 loop 的步数上限同源：Provider 内部回合不该比 loop 允许的步骤还多。
      maxTurns: claude?.maxTurns ?? config.model.loop.maxSteps,
    });
  }
  if (config.model.backend === "openai-responses") {
    const openai = config.model.openai;
    if (!openai?.apiKey) throw new Error("Factory configuration requires model.openai.apiKey for openai-responses backend");
    return new OpenAIModelGateway({ apiKey: openai.apiKey, roles, ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}) });
  }
  const appServer = config.model.codexAppServer;
  if (!appServer) throw new Error("Factory configuration requires model.codexAppServer for codex-app-server backend");
  return new CodexAppServerGateway({ roles, command: appServer.command, args: appServer.args, cwd: appServer.cwd, startupTimeoutMs: appServer.startupTimeoutMs, requestTimeoutMs: appServer.requestTimeoutMs, maxRestarts: appServer.maxRestarts, clientName: appServer.clientName, clientVersion: appServer.clientVersion });
}

/**
 * 显式配置了 Claude 端点时先探一次；由组合根在启动阶段 await。
 * 不探"继承 CLI 解析"那一档：那时端点不在配置里，凭空发一次请求既费额度也说明不了问题。
 */
export async function probeClaudeEndpoint(config: FactoryConfig): Promise<void> {
  const baseUrl = config.model.claudeAgent?.baseUrl;
  if (config.model.backend !== "claude-agent-sdk" || !baseUrl) return;
  try {
    await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(CLAUDE_ENDPOINT_PROBE_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Claude Agent endpoint ${baseUrl} is not reachable: ${error instanceof Error ? error.message : String(error)}. Start the provider proxy (e.g. cc-switch) or fix model.claudeAgent.baseUrl before launching.`);
  }
}
