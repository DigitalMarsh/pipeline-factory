/**
 * 模块职责：Project 域的 10 条路由 —— 目录（列出 / 创建 / 详情 / 摘要 / 更新 / 归档 / 激活 /
 *   配置历史）、导入前的 Git 仓库校验、当前 ExplorerThread 的选择。
 *
 * 与 `routes/explorers.ts` 的边界：本文件只碰 **Project 自身的属性与生命周期**。
 *   `/projects/:projectId/explorers*` 那些路径虽然以项目开头，资源却是 ExplorerThread，
 *   全部归 `routes/explorers.ts`。**按资源归属切，不按路径前缀切。**
 *
 * 维护提示：
 *   1) 创建与更新两条路由都用**正则匹配错误文案**决定 HTTP 状态码（422 = Git 仓库不合法、
 *      404 = 找不到、409 = 冲突 / 有活跃 Run）。这是与 `ProjectService`、`runtime/git.ts`
 *      之间**靠消息文本耦合**的隐式契约：那边改了抛错的措辞，这里会静默换掉响应码。
 *      动措辞必须连这里一起动。
 *   2) 创建路由的 `existingExplorer ?? plans.registerThread(...)` 是**幂等复用**：已经有未归档的
 *      ExplorerThread 就不再建。去掉这个回退，重复导入同一个仓库会每次多出一个空线程。
 *   3) `GET /projects` 的 summary 里 `currentExplorerTitle` 由本文件补——`ProjectService.summary()`
 *      只给 threadId，列表页要显示标题，所以这里必须再查一次 store。**不是漏抽。**
 *   4) 归档状态下非 GET 请求的拦截统一在组合根的 `preHandler` 里做，本文件不重复判。
 *      但那张例外名单（`/activate`、`/validate-repository`）也在那里——改路由路径时要同步改它。
 */
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PipelineStore, PlanService, ProjectService, ProjectSettingsInput } from "@pipeline-factory/domain";
import { projectCreateBody, projectSelectExplorerBody, projectUpdateBody, projectValidateBody } from "../schemas/projects.js";
import { projectThreadParams } from "../schemas/common.js";
import { assertGitBranch, inspectGitRepository } from "../runtime/git.js";

export type ProjectRouteDeps = {
  store: PipelineStore;
  projects: ProjectService;
  /** 创建路由要用它注册首个 ExplorerThread（`plans.registerThread`），ProjectService 不管线程。 */
  plans: PlanService;
};

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { store, projects, plans } = deps;

  // Project Catalog 和设置路由只负责 HTTP 输入/输出，具体版本、路径和归档规则由 ProjectService 决定。
  app.get("/api/v4/projects", async (request) => {
    const query = z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() }).safeParse(request.query ?? {});
    const list = query.success ? projects.list(query.data.status) : projects.list();
    return {
      items: list.map((project) => {
        const summary = projects.summary(project.id);
        return {
          ...project,
          summary: {
            currentExplorerThread: summary.currentExplorerThread,
            currentExplorerTitle: summary.currentExplorerThread ? (store.getThread(summary.currentExplorerThread)?.title ?? null) : null,
            threadCount: summary.threadCount,
            planCount: summary.planCount,
            runCount: summary.runCount,
            activeRunCount: summary.activeRunCount,
            needsAttentionCount: summary.needsAttentionCount,
            lastActivityAt: summary.lastActivityAt,
          },
        };
      }),
    };
  });

  app.post("/api/v4/projects", async (request, reply) => {
    const body = projectCreateBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const repository = await inspectGitRepository(body.data.repoRoot);
      const defaultBranch = body.data.defaultBranch ?? repository.defaultBranch;
      await assertGitBranch(repository.repoRoot, defaultBranch);
      const worktreeRoot =
        body.data.worktreeRoot ?? resolvePath(dirname(repository.repoRoot), `.${basename(repository.repoRoot)}-pipeline-worktrees`);
      let project = projects.create({
        ...(body.data.id ? { id: body.data.id } : {}),
        name: body.data.name,
        ...(body.data.shortName !== undefined ? { shortName: body.data.shortName } : {}),
        repoRoot: repository.repoRoot,
        defaultBranch,
        worktreeRoot,
        ...(body.data.settings ? { settings: body.data.settings as ProjectSettingsInput } : {}),
      });
      const existingExplorer = store.listThreads().find((thread) => thread.projectId === project.id && thread.state !== "ARCHIVED");
      const explorerThread =
        existingExplorer ??
        plans.registerThread({ id: store.nextId("explorer"), projectId: project.id, parentThreadId: null, title: "New Explorer" });
      project = projects.selectExplorer(project.id, explorerThread.id);
      return reply.code(201).send({ project, explorer: explorerThread });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /Git repository|does not exist|absolute path/i.test(message) ? 422 : 409;
      return reply.code(status).send({ code: status === 422 ? "INVALID_GIT_REPOSITORY" : "PROJECT_CONFLICT", error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/validate-repository", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectValidateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid repository validation request" });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      const repository = await inspectGitRepository(body.data.repoRoot ?? project.repoRoot);
      return { valid: true, repoRoot: repository.repoRoot, defaultBranch: repository.defaultBranch };
    } catch (error) {
      return reply.code(422).send({ code: "INVALID_GIT_REPOSITORY", error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v4/projects/:projectId", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { project, summary: projects.summary(project.id) };
  });

  app.get("/api/v4/projects/:projectId/summary", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId))
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { summary: projects.summary(params.data.projectId) };
  });

  app.patch("/api/v4/projects/:projectId", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectUpdateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Project update request" });
    try {
      const project = projects.get(params.data.projectId);
      const repository = body.data.repoRoot ? await inspectGitRepository(body.data.repoRoot) : undefined;
      const defaultBranch = body.data.defaultBranch ?? (repository ? repository.defaultBranch : undefined);
      if (defaultBranch) await assertGitBranch(repository?.repoRoot ?? project.repoRoot, defaultBranch);
      const updated = projects.update(params.data.projectId, {
        ...(body.data.name ? { name: body.data.name } : {}),
        ...(body.data.shortName !== undefined ? { shortName: body.data.shortName } : {}),
        ...(repository
          ? { repoRoot: repository.repoRoot, ...(body.data.defaultBranch ? {} : { defaultBranch: repository.defaultBranch }) }
          : body.data.repoRoot
            ? { repoRoot: body.data.repoRoot }
            : {}),
        ...(body.data.defaultBranch ? { defaultBranch: body.data.defaultBranch } : {}),
        ...(body.data.worktreeRoot ? { worktreeRoot: body.data.worktreeRoot } : {}),
        ...(body.data.expectedConfigVersion ? { expectedConfigVersion: body.data.expectedConfigVersion } : {}),
        ...(body.data.settings ? { settings: body.data.settings as ProjectSettingsInput } : {}),
      });
      return { project: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /not found/i.test(message)
        ? "PROJECT_NOT_FOUND"
        : /configuration version conflict/i.test(message)
          ? "CONFIG_VERSION_CONFLICT"
          : /active runs/i.test(message)
            ? "PROJECT_HAS_ACTIVE_RUNS"
            : /Git repository|branch|does not exist|absolute path/i.test(message)
              ? "INVALID_GIT_REPOSITORY"
              : "PROJECT_UPDATE_FAILED";
      return reply.code(code === "INVALID_GIT_REPOSITORY" ? 422 : code === "PROJECT_NOT_FOUND" ? 404 : 409).send({ code, error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/archive", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return { project: projects.archive(params.data.projectId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply
        .code(/not found/i.test(message) ? 404 : 409)
        .send({ code: /not found/i.test(message) ? "PROJECT_NOT_FOUND" : "PROJECT_HAS_ACTIVE_RUNS", error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/activate", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return { project: projects.activate(params.data.projectId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply
        .code(/not found/i.test(message) ? 404 : 409)
        .send({ code: /not found/i.test(message) ? "PROJECT_NOT_FOUND" : "PROJECT_ACTIVATION_FAILED", error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/select-explorer", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectSelectExplorerBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Explorer selection request" });
    try {
      return { project: projects.selectExplorer(params.data.projectId, body.data.explorerId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply
        .code(/Project .* not found/i.test(message) ? 404 : 409)
        .send({ code: /Project .* not found/i.test(message) ? "PROJECT_NOT_FOUND" : "EXPLORER_SELECTION_FAILED", error: message });
    }
  });

  app.get("/api/v4/projects/:projectId/config-history", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return { items: projects.configHistory(params.data.projectId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: message });
    }
  });
}
