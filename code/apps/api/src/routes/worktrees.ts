/**
 * 模块职责：Worktree 域的 6 条路由 —— 盘点、合并预览、执行合并、继续 / 中止合并、清理。
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
 *   3) 409 的响应体必须带 `code`：同一个 409 下有"被阻断""状态已变""没有进行中的合并"三种原因，
 *      界面要按 `code` 给不同说法（`ApiRequestError` 正是为此把 body 带出来）。
 *   4) `merge` / `cleanup` 是**长耗时**操作（git 子进程），但不要为此改成后台任务：
 *      调用方需要同步拿到"合并成功 / 冲突文件有哪些"才能继续操作，异步化只会把结果藏进另一个轮询接口。
 */
import type { FastifyInstance } from "fastify";
import { WorktreeError, type PipelineStore, type WorktreeService } from "@pipeline-factory/domain";
import { worktreeCleanupBody, worktreeItemBody, worktreeMergeBody } from "../schemas/worktrees.js";
import { projectThreadParams } from "../schemas/common.js";

export type WorktreeRouteDeps = { store: PipelineStore; worktrees: WorktreeService };

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

export function registerWorktreeRoutes(app: FastifyInstance, deps: WorktreeRouteDeps): void {
  const { store, worktrees } = deps;

  app.get("/api/v4/projects/:projectId/worktrees", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return await worktrees.list(project);
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });

  app.post("/api/v4/projects/:projectId/worktrees/preview", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = worktreeItemBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid worktree preview request" });
    const project = store.getProject(params.data.projectId);
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
    const project = store.getProject(params.data.projectId);
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
    const project = store.getProject(params.data.projectId);
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
    const project = store.getProject(params.data.projectId);
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
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return { result: await worktrees.cleanup(project, body.data) };
    } catch (error) {
      return reply.code(statusFor(error)).send(failure(error));
    }
  });
}
