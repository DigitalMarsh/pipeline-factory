/**
 * 模块职责：平台级路由 —— 与具体 Project 无关的运行状态与工具目录。共 3 条：
 *   `/health`（启动探针）、`/api/v4/mcp/tools`、`/api/v4/plugins/tools`，
 *   外加 `/api/v4/explorer-plan-requirements`。
 *
 * 为什么单独一个文件：这 4 条此前混在"projects 49 条"那一桶里，但它们**不读 Project**
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
 */
import type { FastifyInstance } from "fastify";
import { EXPLORER_PLAN_REQUIREMENTS, type McpToolRegistry, type ModelGateway, type PluginRegistry } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";

export type PlatformRouteDeps = {
  model: ModelGateway;
  mcpRegistry?: McpToolRegistry | undefined;
  pluginRegistry?: PluginRegistry | undefined;
  config?: FactoryConfig | undefined;
};

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { model, mcpRegistry, pluginRegistry, config } = deps;

  // Health 端点不挂在 /api/v4/projects 下，便于启动脚本在没有 Project 上下文时确认服务就绪。
  app.get("/health", async () => ({ status: "ok", service: "pipeline-factory-api", version: "v4", modelBackend: config?.model.backend ?? "stub", model: model.configFor("explorer").model }));

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
