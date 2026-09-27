/**
 * 模块职责：Workbench 的 2 条路由 —— 项目快照（JSON）与项目事件流（JSON 或 SSE）。
 *
 * 为什么这一组单独成文件：它们是 `/api/v4/workbench*` 的全部面，且**是唯一一处同时提供
 *   "轮询式 SSE"与"同一路径的 JSON 返回"的地方**。两条路由共用 `workbenchQuery`，差别只在
 *   `format`——放在一起，才能一眼看出两条分支对同一个 query 的处理必须保持一致。
 *
 * 两个 deps 是**函数**而不是对象，这是本文件唯一需要解释的设计：`snapshot` 与
 *   `projectEventScope` 目前都还住在组合根（server.ts 顶层的 `workbenchSnapshot` /
 *   `createProjectEventScope`），方案 P5 才把它们搬进 `projections/`。用回调注入而不是
 *   让 route 反向 import server.ts，是为了**避免 route ↔ 组合根的类型环**，也让"这两个函数
 *   还没有归属"这件事在 deps 里显式可见——P5 落地后它们会变成 `projections/` 的普通 import。
 *
 * 维护提示（下面 SSE 分支里两条容易被"顺手优化"掉的规则）：
 *   1) **游标无条件推进到本批末尾**（`cursor = event.sequence` 在 `if` 之前）。不属于本项目的
 *      中间事件若不同样推进游标，就会被每 250ms 重新扫描一遍——这是 O(事件总数) 的空转。
 *      过滤只影响"发不发帧"，不影响"游标走不走"。
 *   2) **归属索引每次 send 都按需重建**（而不是建连接时算一次并持有）。原因是连接期间会新建
 *      Plan / Run / Loop，缓存下来的索引会把它们判成"不属于本项目"。重建的代价由 1) 的游标
 *      推进控制住了：每轮只看新增的那几个事件。
 */
import type { FastifyInstance } from "fastify";
import type { DomainEvent, PipelineStore } from "@pipeline-factory/domain";
import { workbenchQuery } from "../schemas/workbench.js";
import { openSseChannel } from "../http/sse.js";

export type WorkbenchRouteDeps = {
  store: PipelineStore;
  /** Workbench 快照投影。当前仍在组合根（server.ts 的 `workbenchSnapshot`），P5 搬到 `projections/`。 */
  snapshot: (projectId: string) => unknown;
  /** 事件归属判定。当前仍在组合根（server.ts 的 `createProjectEventScope`），P5 搬到 `projections/`。 */
  projectEventScope: (projectId: string) => (event: DomainEvent) => boolean;
};

export function registerWorkbenchRoutes(app: FastifyInstance, deps: WorkbenchRouteDeps): void {
  const { store, snapshot, projectEventScope } = deps;

  app.get("/api/v4/workbench", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench query" });
    if (!store.getProject(query.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${query.data.projectId} not found` });
    return snapshot(query.data.projectId);
  });

  app.get("/api/v4/workbench/events", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench event query" });
    if (!store.getProject(query.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `PROJECT_NOT_FOUND: ${query.data.projectId}` });
    const eventsForProject = (afterSequence: number) => {
      const pending = store.listEvents({ afterSequence });
      if (pending.length === 0) return pending;
      // 归属索引按需重建，保证连接期间新建的 Plan/Run/Loop 也能被正确归类。
      const belongsToProject = projectEventScope(query.data.projectId);
      return pending.filter((event) => belongsToProject(event));
    };
    if (query.data.format !== "sse") return { items: eventsForProject(query.data.afterSequence), cursor: store.getLastEventSequence() };
    let cursor = query.data.afterSequence;
    // poll 传的是"延迟取 send"的壳：send 里要用返回的通道，只能等通道建好再定义它。
    const sse = openSseChannel(request, reply, { poll: () => send() });
    const send = () => {
      const pending = store.listEvents({ afterSequence: cursor });
      if (pending.length === 0) return;
      const belongsToProject = projectEventScope(query.data.projectId);
      // 游标无条件推进到本批末尾：不属于本项目的中间事件不应每 250ms 被重复扫描。
      for (const event of pending) {
        cursor = event.sequence;
        if (belongsToProject(event)) sse.send(event.sequence, event.type, event);
      }
    };
    send();
    sse.ready(cursor, { cursor });
  });
}
