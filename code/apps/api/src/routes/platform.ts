/**
 * 模块职责：平台级路由 —— 与具体 Project 无关的运行状态与目录查询。共 5 条：
 *   `/health`（启动探针）、`/api/v4/model-backends`（可用 agent/模型/档位目录）、
 *   `/api/v4/mcp/tools`、`/api/v4/plugins/tools`、`/api/v4/explorer-plan-requirements`。
 *
 * 为什么单独一个文件：这几条此前混在"projects 49 条"那一桶里，但它们**不读 Project**
 *   （不查 store.getProject、不受预处理器里 Project 存在性/归档守卫的约束），
 *   混在一起会让"CORS/路径前缀/Project 上下文"这三件事的边界变模糊。
 *
 * 维护提示：
 *   1) `/health` 是**启动脚本的判据**（scripts/service.mjs 靠它判断服务就绪），
 *      它的字段名是外部契约：`status` 与 `service` 改名前先全仓 grep。
 *   2) `mcpRegistry` / `pluginRegistry` 在**没有 config 时会整体缺省**（见 createApp 的
 *      构造），所以这两条路由必须先判空返回 `{ tools: [] }` —— 那是"这次运行没配"的
 *      正确表达，不是错误；不要改成 500。
 *   3) 这里**曾经有一条 `/api/v4/codex/rate-limits`**，它的数据源只有 Codex App Server
 *      的账号额度接口，已随额度面板一起移除（页面与后端两侧同一提交）。再要加
 *      账号级用量，先想清楚"没有该接口的后端显示什么"，别退回到静默 `available:false`。
 *   4) plugins 的 discover 需要 config 里的目录列表，所以这条路由要拿 `config` 而不是
 *      只拿 registry。
 *   5) `/api/v4/model-backends` 是"这个进程里能用哪些 agent"的唯一答案，控制台的三件事
 *      （选 agent、选模型、选推理强度）都读它。没有 config 时返回空目录而不是报错——
 *      与 mcp/plugins 同一条约定：**"这次运行没配"不是错误**。
 */
import type { FastifyInstance } from "fastify";
import { EXPLORER_PLAN_REQUIREMENTS, type McpToolRegistry, type ModelGateway, type PluginRegistry } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";
import { describeModelBackends } from "../runtime/model-catalog.js";

export type PlatformRouteDeps = {
  model: ModelGateway;
  mcpRegistry?: McpToolRegistry | undefined;
  pluginRegistry?: PluginRegistry | undefined;
  config?: FactoryConfig | undefined;
};

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { model, mcpRegistry, pluginRegistry, config } = deps;
  const backends = config ? describeModelBackends(config) : undefined;

  // Health 端点不挂在 /api/v4/projects 下，便于启动脚本在没有 Project 上下文时确认服务就绪。
  // `modelBackend` 保留为**explorer 生效的后端**（旧调用方的兼容键）；多后端下请读 modelBackends，
  // 它才是"这个进程里有哪几个 agent、各自给哪个角色用"的完整答案。
  app.get("/health", async () => ({
    status: "ok",
    service: "pipeline-factory-api",
    version: "v4",
    modelBackend: backends?.roles.explorer ?? config?.model.backend ?? "stub",
    modelBackends: backends?.roles ?? { explorer: config?.model.backend ?? "stub", executor: config?.model.backend ?? "stub" },
    model: model.configFor("explorer").model,
  }));

  /**
   * 可用后端目录。控制台的"给这个角色选哪个 agent / 哪个模型 / 哪档推理强度"三件事都取自这里：
   * 模型与档位是**建议值与接线事实**（见 runtime/model-catalog.ts 的维护提示），不是白名单校验。
   */
  app.get("/api/v4/model-backends", async () => backends ?? { backends: [], roles: { explorer: "stub", executor: "stub" }, defaultBackend: "stub" });

  app.get("/api/v4/mcp/tools", async (request, reply) => {
    if (!mcpRegistry) return { tools: [] };
    try {
      return { tools: await mcpRegistry.discover() };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "MCP discovery failed" });
    }
  });

  app.get("/api/v4/plugins/tools", async (request, reply) => {
    if (!pluginRegistry) return { tools: [] };
    try {
      if (config?.plugins.directories.length) await pluginRegistry.discover(config.plugins.directories);
      return { tools: pluginRegistry.listTools() };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Plugin discovery failed" });
    }
  });

  app.get("/api/v4/explorer-plan-requirements", async () => ({ requirements: EXPLORER_PLAN_REQUIREMENTS }));
}
