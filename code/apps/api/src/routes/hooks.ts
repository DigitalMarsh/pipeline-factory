/**
 * 模块职责：项目生命周期 Hook 配置的 2 条路由 —— 读取与整体替换（GET / PUT
 *   `/api/v4/projects/:projectId/settings/hooks`）。
 *
 * 为什么用 PUT 整体替换而不是 PATCH 合并：Hook 配置是一份**完整声明**（start / cleanup 两个
 *   槽位），局部合并会让"删掉一个槽位"无法表达。PUT 的语义是"这就是新的全部"，代价是调用方
 *   必须回传完整对象——这个取舍是有意的，不要为了"方便前端"改成合并。
 *
 * 维护提示（PUT 里有三处不显眼但必须保留的行为）：
 *   1) **`enabled` / `timeoutMs` / `maxAttempts` 逐个判 `undefined` 再展开**，而不是直接
 *      展开 `body.data.start`。因为 `exactOptionalPropertyTypes: true` 下"显式传 undefined"
 *      与"键不存在"是两种类型，直接展开会造出键存在但值为 undefined 的对象。这几个
 *      `...(x === undefined ? {} : { x })` 不是啰嗦，是类型系统要求的写法。
 *   2) **`projects.update` 的失败要按消息分流 409 / 422**：含 "active runs" 的给 409
 *      （状态冲突，等 Run 结束可重试），其余给 422（配置本身不合法）。都落成 422 会让
 *      前端无法区分"稍后重试"与"改了也没用"。
 *   3) **项目不存在时静默返回请求体**（`if (project)` 包裹，末尾无条件 return
 *      `{ projectId, lifecycle: body.data }`）。这不是遗漏：这条路由此前就在，改成 404 是
 *      行为变更。注意它意味着**不存在的项目 PUT 会返回 200**。
 */
import type { FastifyInstance } from "fastify";
import type { PipelineStore, ProjectService } from "@pipeline-factory/domain";
import { hookBody } from "../schemas/hooks.js";
import { projectThreadParams } from "../schemas/common.js";

export type HookRouteDeps = {
  store: PipelineStore;
  projects: ProjectService;
};

export function registerHookRoutes(app: FastifyInstance, deps: HookRouteDeps): void {
  const { store, projects } = deps;

  app.get("/api/v4/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { projectId: params.data.projectId, lifecycle: store.getProject(params.data.projectId)?.settings.hooks ?? {} };
  });

  app.put("/api/v4/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = hookBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid hook configuration" });
    const project = store.getProject(params.data.projectId);
    if (project) {
      const lifecycle = {
        ...(body.data.start ? { start: { commandId: body.data.start.commandId, ...(body.data.start.enabled === undefined ? {} : { enabled: body.data.start.enabled }), ...(body.data.start.timeoutMs === undefined ? {} : { timeoutMs: body.data.start.timeoutMs }), ...(body.data.start.maxAttempts === undefined ? {} : { maxAttempts: body.data.start.maxAttempts }) } } : {}),
        ...(body.data.cleanup ? { cleanup: { commandId: body.data.cleanup.commandId, ...(body.data.cleanup.enabled === undefined ? {} : { enabled: body.data.cleanup.enabled }), ...(body.data.cleanup.timeoutMs === undefined ? {} : { timeoutMs: body.data.cleanup.timeoutMs }), ...(body.data.cleanup.maxAttempts === undefined ? {} : { maxAttempts: body.data.cleanup.maxAttempts }) } } : {}),
      };
      try {
        projects.update(params.data.projectId, { settings: { hooks: lifecycle } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(/active runs/i.test(message) ? 409 : 422).send({ code: /active runs/i.test(message) ? "PROJECT_HAS_ACTIVE_RUNS" : "HOOK_SETTINGS_INVALID", error: message });
      }
    }
    return { projectId: params.data.projectId, lifecycle: body.data };
  });
}
