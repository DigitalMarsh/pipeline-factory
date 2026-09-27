/**
 * 模块职责：按 `config.model.backend` 选一个 `ModelGateway` 实现并构造它 ——
 *   `stub`（测试替身）/ `openai-responses` / `codex-app-server`（默认）。
 *
 * 维护提示：
 *   1) **这是全仓唯一读取 `config.model.openai.apiKey` 的地方**（`grep -rn apiKey apps packages` 可复核）。
 *      另外两个 backend 都不需要密钥：`stub` 没有模型，`codex-app-server` 由子进程自己持有凭证。
 *      **要接新 backend 就在这里加分支，不要在别处读 `config.model`** —— 凭据读取点收敛成一处，
 *      是"Factory 不在项目里存 API key"这条设计承诺能被审计的前提。
 *   2) `roles` 上的类型断言把 config 的松散结构收敛成 `Record<ModelRole, ...>`；真正的校验收敛在
 *      `config.ts` 的 zod schema 里，这里不做二次校验。
 *   3) 两处 `throw` 都是**启动期失败**：缺少 backend 必需字段时宁可起不来，也不要等到第一次模型调用
 *      才报错——那时错误已经离配置很远了。
 */
import { CodexAppServerGateway, OpenAIModelGateway, StubModelGateway } from "@pipeline-factory/domain";
import type { ModelGateway, ModelRole } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";

export function createModelGateway(config: FactoryConfig): ModelGateway {
  const roles = config.model.roles as Record<ModelRole, { model: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string; loopMode?: "provider-controlled" | "factory-controlled" }>;
  if (config.model.backend === "stub") return new StubModelGateway(roles);
  if (config.model.backend === "openai-responses") {
    const openai = config.model.openai;
    if (!openai?.apiKey) throw new Error("Factory configuration requires model.openai.apiKey for openai-responses backend");
    return new OpenAIModelGateway({ apiKey: openai.apiKey, roles, ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}) });
  }
  const appServer = config.model.codexAppServer;
  if (!appServer) throw new Error("Factory configuration requires model.codexAppServer for codex-app-server backend");
  return new CodexAppServerGateway({ roles, command: appServer.command, args: appServer.args, cwd: appServer.cwd, startupTimeoutMs: appServer.startupTimeoutMs, requestTimeoutMs: appServer.requestTimeoutMs, maxRestarts: appServer.maxRestarts, clientName: appServer.clientName, clientVersion: appServer.clientVersion });
}
