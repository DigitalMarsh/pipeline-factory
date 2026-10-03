/**
 * 模块职责：平台级路由 —— 与具体 Project 无关的运行状态与目录查询。共 6 条：
 *   `/health`（启动探针）、`/api/v4/model-backends`（可用 agent/模型/推理强度目录）、
 *   `/api/v4/mcp/tools`、`/api/v4/plugins/tools`、`/api/v4/explorer-plan-requirements`、
 *   `/api/v4/dialogs/select-directory`（弹系统"选择文件夹"对话框）。
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
 *   6) `/api/v4/dialogs/select-directory` 会**在跑 API 的这台机器上弹出 GUI**，所以它是 POST
 *      （不是可缓存的读）、并且只接受回环地址的调用。它的存在理由见 runtime/directory-dialog.ts
 *      的模块头（浏览器拿不到绝对路径）。测试用 `chooseDirectory` 注入假实现，不弹真对话框。
 */
import type { FastifyInstance } from "fastify";
import { EXPLORER_PLAN_REQUIREMENTS, type McpToolRegistry, type ModelGateway, type PluginRegistry } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";
import { describeModelBackends } from "../runtime/model-catalog.js";
import { chooseDirectory, DirectoryDialogError, type DirectoryDialogResult } from "../runtime/directory-dialog.js";

export type PlatformRouteDeps = {
  model: ModelGateway;
  mcpRegistry?: McpToolRegistry | undefined;
  pluginRegistry?: PluginRegistry | undefined;
  config?: FactoryConfig | undefined;
  /** 弹系统目录选择框。缺省是真实命令；测试注入假实现，避免测试机上真的弹窗。 */
  chooseDirectory?: (() => Promise<DirectoryDialogResult>) | undefined;
};

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { model, mcpRegistry, pluginRegistry, config } = deps;
  const backends = config ? describeModelBackends(config) : undefined;
  const pickDirectory = deps.chooseDirectory ?? chooseDirectory;

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
   * 模型与推理强度是**建议值与配置事实**（见 runtime/model-catalog.ts 的维护提示），不是白名单校验。
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

  /**
   * 弹系统"选择文件夹"对话框，把本机绝对路径交回浏览器——浏览器自己拿不到路径
   *   （见 runtime/directory-dialog.ts 的模块头）。**三种结果都是正常响应**，只有后端真的办不到
   *   才是错误码：`{ cancelled: true }`（用户点了取消）、`{ cancelled: false, path }`（选好了）、
   *   501 / 504 / 502（平台不支持 / 等超时 / 命令失败）。前端据此决定"回填"还是"说人话"。
   */
  app.post("/api/v4/dialogs/select-directory", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) return reply.code(403).send({ code: "DIALOG_LOCAL_ONLY", error: "目录选择框只能在运行 API 的那台机器上弹出，请改用手动输入绝对路径。" });
    try {
      const result = await pickDirectory();
      return "cancelled" in result ? { cancelled: true, path: null } : { cancelled: false, path: result.path };
    } catch (error) {
      if (error instanceof DirectoryDialogError) {
        const status = error.code === "DIALOG_UNSUPPORTED" ? 501 : error.code === "DIALOG_TIMEOUT" ? 504 : 502;
        return reply.code(status).send({ code: error.code, error: error.message });
      }
      return reply.code(502).send({ code: "DIALOG_FAILED", error: error instanceof Error ? error.message : "目录选择框调用失败" });
    }
  });
}

/** 只认回环地址：这个端点会在服务端弹 GUI，不该由远端决定什么时候弹。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
