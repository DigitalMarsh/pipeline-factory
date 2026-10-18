/**
 * 模块职责：Worktree 域的 20 条路由 —— 盘点（含项目范围过滤）、合并预览、执行合并、继续 / 中止合并、
 *   清理、提交历史、提交文件、单文件 diff、服务启停与日志、执行目录（切换/清空/runtime 服务），
 *   以及项目级 Worktree 事件流。
 *
 * 为什么这一组单独成文件：它们是**唯一会真的改动受管仓库 Git 状态**的 HTTP 入口
 *   （`run/merge.ts` 那条 MergeRequest 链路只观察、不回写）。把"会写仓库"的入口集中在一处，
 *   审查与收紧权限时只需要读这一个文件。
 *
 * 维护提示：
 *   1) **错误码映射按 `WorktreeError.code`，不按错误文案**。`routes/projects.ts` 那种用正则匹配
 *      消息决定状态码的做法是历史包袱（那边自己也标了"动措辞必须连这里一起动"），本文件不复制。
 *   2) 未找到项目一律 404（组合根的 `preHandler` 已经拦过一次，这里保留是为了让本文件单独可测）；
 *      归档项目由 `preHandler` 统一拦非 GET 请求，本文件不重复判。
 *   3) 409 的响应体必须带 `code`：同一个 409 下有"被阻断""状态已变""没有进行中的合并""仓库读不到"
 *      几种原因，界面要按 `code` 给不同说法（`ApiRequestError` 正是为此把 body 带出来）。
 *   4) `merge` / `cleanup` 是**长耗时**操作（git 子进程），但不要为此改成后台任务：
 *      调用方需要同步拿到"合并成功 / 冲突文件有哪些"才能继续操作，异步化只会把结果藏进另一个轮询接口。
 *   5) **事件流只推"该刷新了"，不推业务内容**：帧里只有 type / sequence / occurredAt，客户端据此
 *      防抖重拉清单。这样既不用为每个事件设计投影，也不会把可能带敏感字段的 payload 直接送出进程。
 *   6) `includeFiltered=1` 只影响**读**：写路径（preview / merge / cleanup）在领域层一律按全量清单
 *      解析目标，所以"被项目范围隐藏的分支"不会变成"不存在"。
 */
import { resolve as resolvePath } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { WorktreeError, type PipelineStore, type Project, type WorktreeService } from "@pipeline-factory/core";
import {
  worktreeCleanupBody,
  worktreeCommitParams,
  worktreeDiffQuery,
  worktreeItemBody,
  worktreeListQuery,
  worktreeLogQuery,
  worktreeMergeBody,
  worktreeItemOnlyBody,
  worktreeRuntimeLogsQuery,
  worktreeRuntimeServiceBody,
  worktreeRuntimeSwitchBody,
  worktreeServiceActionBody,
  worktreeServiceLogsQuery,
  worktreeServicesQuery,
} from "@pipeline-factory/contracts";
import type { WorktreeServiceRunner } from "../runtime/worktree-services.js";
import { projectThreadParams } from "@pipeline-factory/contracts";
import { openSseChannel } from "../http/sse.js";

export type WorktreeRouteDeps = {
  store: PipelineStore;
  worktrees: WorktreeService;
  /** 可缺省：测试与只读实例不装服务进程管理，此时服务相关路由返回 503。 */
  worktreeServices?: WorktreeServiceRunner | undefined;
};

/** 领域错误码 → HTTP 状态。未知错误一律 500（组合根的 onError 会留栈）。 */
function statusFor(error: unknown): number {
  if (!(error instanceof WorktreeError)) return 500;
  switch (error.code) {
    case "WORKTREE_NOT_FOUND":
      return 404;
    // 下面这五个都是"当前状态不允许"：409 + `code`，由界面给不同说法。
    // 其中 WORKTREE_GIT_FAILED 是仓库读不到（目录被删、不是 Git 仓库）——同样是状态问题，不是 500。
    case "WORKTREE_MERGE_BLOCKED":
    case "WORKTREE_CLEANUP_BLOCKED":
    case "WORKTREE_STATE_CHANGED":
    case "WORKTREE_NO_MERGE_IN_PROGRESS":
    case "WORKTREE_RUNTIME_BLOCKED":
    case "WORKTREE_DEPENDENCY_BLOCKED":
    case "WORKTREE_GIT_FAILED":
      return 409;
    default:
      return 500;
  }
}

/** 统一的错误响应：`code` 给程序分支，`error` 给人看。 */
function failure(error: unknown) {
  const code = error instanceof WorktreeError ? error.code : "WORKTREE_FAILED";
  return { code, error: error instanceof Error ? error.message : String(error) };
}

/**
 * 事件流转发的类型白名单：Worktree 自身的写操作 + 会影响清单状态的 Run/Plan 变化。
 * **不是"所有项目事件"**——把模型输出、探索回调也推过来既浪费又扩大暴露面。
 */
/** runtime 服务在进程管理器里的键段；与单个 worktree 的 `itemId` 区分开。 */
const RUNTIME_SERVICE_KEY = "runtime";

const WORKTREE_EVENT_TYPES = new Set<string>([
  "worktree.merge.completed",
  "worktree.merge.conflict",
  "worktree.merge.continued",
  "worktree.merge.aborted",
  "worktree.cleaned",
  "worktree.runtime.switched",
  "merge.request.created",
  "merge.detected",
  "merge.confirmed",
  "run.paused",
  "run.resumed",
  "run.recovery_required",
  "plan.status.changed",
  "plan.dispatched",
]);

/**
 * 服务只能跑在 worktree 里：无 worktree 的本地分支与 detached 项没有"当前工作目录"这回事。
 * 返回 `{ item }` 或 `{ error }`（后者已经是一个可直接 return 的 reply）。
 *
 * 这里**只解析路径**（`worktrees.worktreePathFor`），不拉完整清单：服务面板每选一次条目就会调它，
 * 而完整清单要为每条分支跑 `rev-list`、为每个 worktree 跑 `status`——为了拿一个路径做十几次
 * git 调用是不必要的。
 */
async function resolveServiceTarget(
  worktrees: WorktreeService,
  project: Project,
  itemId: string,
  reply: FastifyReply,
): Promise<{ item: { itemId: string; worktreePath: string } } | { error: unknown }> {
  try {
    const worktreePath = await worktrees.worktreePathFor(project, itemId);
    if (!worktreePath) {
      return {
        error: reply.code(409).send({
          code: "WORKTREE_SERVICES_UNSUPPORTED",
          error: "服务只能在 worktree 中运行，请先为这条分支创建 worktree。",
        }),
      };
    }
    return { item: { itemId, worktreePath } };
  } catch (error) {
    return { error: reply.code(statusFor(error)).send(failure(error)) };
  }
}

export function registerWorktreeRoutes(app: FastifyInstance, deps: WorktreeRouteDeps): void {
  const { store, worktrees, worktreeServices } = deps;

  /** 项目存在性：本文件每条路由都要，抽一处免得八处重复。 */
  function projectOf(projectId: string) {
    return store.getProject(projectId);
  }

  app.get("/api/v4/projects/:projectId/worktrees", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = worktreeListQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree list request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return await worktrees.list(project, {
        includeFiltered: query.data.includeFiltered === "1" || query.data.includeFiltered === "true",
      });
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/preview", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeItemBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree preview request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { preview: await worktrees.preview(project, body.data.itemId) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/merge", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeMergeBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree merge request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { result: await worktrees.merge(project, body.data) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/merge/continue", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid worktree merge continue request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { result: await worktrees.continueMerge(project) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/merge/abort", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid worktree merge abort request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { result: await worktrees.abortMerge(project) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/cleanup", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeCleanupBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree cleanup request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      // 先停掉这个 item 上跑着的服务：目录删掉之后进程会变成没有归属的孤儿。
      // 放在 cleanup 之前是有意的——cleanup 的判据需要看当前状态，而"停服务"不会改变那些判据；
      // 万一 cleanup 随后被拒，代价只是服务被停了一次（用户重新启动即可）。
      const stoppedServices = worktreeServices ? await worktreeServices.stopItem(project.id, body.data.itemId) : 0;
      return { result: await worktrees.cleanup(project, body.data), stoppedServices };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.get("/api/v4/projects/:projectId/worktrees/log", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = worktreeLogQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree log request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { items: await worktrees.log(project, query.data) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.get("/api/v4/projects/:projectId/worktrees/commits/:commit", async (request, reply) => {
    const params = worktreeCommitParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid worktree commit request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { items: await worktrees.commitFiles(project, params.data.commit) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.get("/api/v4/projects/:projectId/worktrees/commits/:commit/diff", async (request, reply) => {
    const params = worktreeCommitParams.safeParse(request.params);
    const query = worktreeDiffQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree diff request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { diff: await worktrees.commitDiff(project, { commit: params.data.commit, ...query.data }) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  /**
   * 执行目录的 7 条路由。**进程管理与工作树面板共用同一套 runner**：runtime 的服务统一以
   * `itemId = "runtime"` 作为键段，于是"切换前全停"只需一条 `stopItem(projectId, "runtime")`。
   */
  const runtimeRepoRoot = (runtimePath: string) => resolvePath(runtimePath, "repo");

  /** 组装执行目录的现状 + 从 runtime 配置链解析出的服务清单。 */
  async function runtimeSnapshot(project: NonNullable<ReturnType<PipelineStore["getProject"]>>) {
    const runtime = await worktrees.runtime(project);
    const usable = Boolean(runtime.current && runtime.link?.exists);
    const services =
      usable && worktreeServices
        ? worktreeServices.inspect(
            project.id,
            RUNTIME_SERVICE_KEY,
            runtimeRepoRoot(runtime.path),
            project.settings.worktreeServices ?? [],
            runtime.path,
          )
        : null;
    return { runtime, services };
  }

  app.get("/api/v4/projects/:projectId/runtime", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid runtime request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return await runtimeSnapshot(project);
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/runtime/switch", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeRuntimeSwitchBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid runtime switch request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      // 先停服务再换链接：进程还开着旧路径时换链接，日志与写入都会指错分支。
      const stoppedServices = worktreeServices ? await worktreeServices.stopItem(project.id, RUNTIME_SERVICE_KEY) : 0;
      const result = await worktrees.switchRuntime(project, body.data.itemId);
      const { services } = await runtimeSnapshot(project);
      return { ...result, stoppedServices, services };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/runtime/clear", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid runtime clear request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      const stoppedServices = worktreeServices ? await worktreeServices.stopItem(project.id, RUNTIME_SERVICE_KEY) : 0;
      const result = await worktrees.clearRuntime(project);
      return { ...result, stoppedServices };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  /** runtime 服务相关路由共同的守卫：执行目录必须已经指向一个可用的 worktree。 */
  async function requireRuntime(project: NonNullable<ReturnType<PipelineStore["getProject"]>>, reply: FastifyReply) {
    const runtime = await worktrees.runtime(project);
    if (!runtime.current || !runtime.link?.exists) {
      return {
        error: reply
          .code(409)
          .send({ code: "WORKTREE_RUNTIME_BLOCKED", error: "执行目录还没有指向可用的 worktree，请先在 Worktree 面板里切换。" }),
      };
    }
    if (!worktreeServices) {
      return {
        error: reply.code(503).send({ code: "WORKTREE_SERVICES_UNAVAILABLE", error: "本实例没有装配服务进程管理。" }),
      };
    }
    return { runtime };
  }

  app.get("/api/v4/projects/:projectId/runtime/services", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid runtime services request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      const target = await requireRuntime(project, reply);
      if ("error" in target) return target.error;
      return worktreeServices!.inspect(
        project.id,
        RUNTIME_SERVICE_KEY,
        runtimeRepoRoot(target.runtime.path),
        project.settings.worktreeServices ?? [],
        target.runtime.path,
      );
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/runtime/services/start", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeRuntimeServiceBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid runtime service start request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const target = await requireRuntime(project, reply);
    if ("error" in target) return target.error;
    const root = runtimeRepoRoot(target.runtime.path);
    const services = worktreeServices!.inspect(
      project.id,
      RUNTIME_SERVICE_KEY,
      root,
      project.settings.worktreeServices ?? [],
      target.runtime.path,
    );
    const config = services.services.find((service) => service.serviceId === body.data.serviceId);
    if (!config) return reply.code(404).send({ code: "WORKTREE_SERVICE_NOT_FOUND", error: `服务不存在：${body.data.serviceId}` });
    try {
      return { state: worktreeServices!.start(project.id, RUNTIME_SERVICE_KEY, root, config) };
    } catch (error) {
      return reply
        .code(409)
        .send({ code: "WORKTREE_SERVICE_START_FAILED", error: error instanceof Error ? error.message : "服务启动失败" });
    }
  });

  app.post("/api/v4/projects/:projectId/runtime/services/stop", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeRuntimeServiceBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid runtime service stop request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const target = await requireRuntime(project, reply);
    if ("error" in target) return target.error;
    return { state: await worktreeServices!.stop(project.id, RUNTIME_SERVICE_KEY, body.data.serviceId) };
  });

  app.get("/api/v4/projects/:projectId/runtime/services/logs", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = worktreeRuntimeLogsQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid runtime service logs request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const target = await requireRuntime(project, reply);
    if ("error" in target) return target.error;
    return { items: worktreeServices!.logs(project.id, RUNTIME_SERVICE_KEY, query.data.serviceId) };
  });

  /** 给已有 worktree 补齐依赖软链（`node_modules` 等）；判据与 Run 创建时同一套。 */
  app.post("/api/v4/projects/:projectId/worktrees/dependencies", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeItemOnlyBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree dependency request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { result: await worktrees.linkDependencies(project, body.data.itemId) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  // ───────────── 单个 worktree 的服务启停（第三个参数是 worktree 根目录，进程管理在 runtime） ─────────────

  app.get("/api/v4/projects/:projectId/worktrees/services", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = worktreeServicesQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree services request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const target = await resolveServiceTarget(worktrees, project, query.data.itemId, reply);
    if ("error" in target) return target.error;
    if (!worktreeServices) return reply.code(503).send({ code: "WORKTREE_SERVICES_UNAVAILABLE", error: "本实例没有装配服务进程管理。" });
    return worktreeServices.inspect(project.id, target.item.itemId, target.item.worktreePath, project.settings.worktreeServices ?? []);
  });

  app.post("/api/v4/projects/:projectId/worktrees/services/start", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeServiceActionBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree service start request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    if (!worktreeServices) return reply.code(503).send({ code: "WORKTREE_SERVICES_UNAVAILABLE", error: "本实例没有装配服务进程管理。" });
    const target = await resolveServiceTarget(worktrees, project, body.data.itemId, reply);
    if ("error" in target) return target.error;
    const services = worktreeServices.inspect(
      project.id,
      target.item.itemId,
      target.item.worktreePath,
      project.settings.worktreeServices ?? [],
    );
    const config = services.services.find((service) => service.serviceId === body.data.serviceId);
    if (!config) return reply.code(404).send({ code: "WORKTREE_SERVICE_NOT_FOUND", error: `服务不存在：${body.data.serviceId}` });
    try {
      return { state: worktreeServices.start(project.id, target.item.itemId, target.item.worktreePath, config) };
    } catch (error) {
      return reply
        .code(409)
        .send({ code: "WORKTREE_SERVICE_START_FAILED", error: error instanceof Error ? error.message : "服务启动失败" });
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/services/stop", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeServiceActionBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree service stop request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    if (!worktreeServices) return reply.code(503).send({ code: "WORKTREE_SERVICES_UNAVAILABLE", error: "本实例没有装配服务进程管理。" });
    const target = await resolveServiceTarget(worktrees, project, body.data.itemId, reply);
    if ("error" in target) return target.error;
    const state = await worktreeServices.stop(project.id, target.item.itemId, body.data.serviceId);
    return { state };
  });

  app.get("/api/v4/projects/:projectId/worktrees/services/logs", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = worktreeServiceLogsQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree service logs request" });
    const project = projectOf(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    if (!worktreeServices) return reply.code(503).send({ code: "WORKTREE_SERVICES_UNAVAILABLE", error: "本实例没有装配服务进程管理。" });
    const target = await resolveServiceTarget(worktrees, project, query.data.itemId, reply);
    if ("error" in target) return target.error;
    return { items: worktreeServices.logs(project.id, target.item.itemId, query.data.serviceId) };
  });

  /**
   * 项目级 Worktree 事件流：推的是"该刷新了"而不是业务内容（见维护提示 5）。
   * 订阅式通道——`store.subscribeEvents` 的回调里直接写帧；`onClose(unsubscribe)` 是必需的清理。
   */
  app.get("/api/v4/projects/:projectId/worktrees/events", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = z.object({ afterSequence: z.coerce.number().int().min(0).optional() }).safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid worktree event stream request" });
    const projectId = params.data.projectId;
    const project = projectOf(projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${projectId} not found` });

    // 先对齐库里已有的序号再握手：否则重连的客户端会以为中间丢了事件。
    let cursor = Math.max(query.data.afterSequence ?? 0, store.getLastEventSequence(projectId));
    const channel = openSseChannel(request, reply);
    channel.ready(cursor, { projectId });

    if (!store.subscribeEvents) return;
    const unsubscribe = store.subscribeEvents((event) => {
      if (event.aggregateId !== projectId) return;
      if (!WORKTREE_EVENT_TYPES.has(event.type)) return;
      if (event.sequence <= cursor) return;
      cursor = event.sequence;
      // 只发"发生了什么"的最小形状：类型 + 序号。payload 留在库里按需查。
      channel.send(event.sequence, "worktree", { type: event.type, sequence: event.sequence, occurredAt: event.occurredAt });
    });
    channel.onClose(unsubscribe);
  });
}
