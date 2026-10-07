/**
 * 模块职责：Workbench 的 3 条路由 —— 项目快照（JSON）、项目事件流（JSON 或 SSE），
 *   以及项目「今日活动」`/api/v4/projects/:projectId/activity`。
 *
 * 为什么这一组单独成文件：它们是 `/api/v4/workbench*` 的全部面，且**是唯一一处同时提供
 *   "轮询式 SSE"与"同一路径的 JSON 返回"的地方**。两条路由共用 `workbenchQuery`，差别只在
 *   `format`——放在一起，才能一眼看出两条分支对同一个 query 的处理必须保持一致。
 *   今日活动放在这里是因为它服务的正是同一个页面（Workbench 的"今日"面板）；它的路径挂在
 *   projects 下是按资源归属（读 Project 的历史），而不是按页面归属。
 *
 * 本文件曾经用两个**回调 dep**（`snapshot` / `projectEventScope`）注入投影，因为那时它们还住在
 *   组合根，直接 import 会形成 route ↔ 组合根的类型环。P5 的 `projections/` 落地后这两个函数
 *   有了归属，回调壳已删除，改成普通 import —— **这是显式 deps 想要的结果，不是需要保留的形状**。
 *
 * 维护提示（下面 SSE 分支里两条容易被"顺手优化"掉的规则）：
 *   1) **游标无条件推进到本批末尾**（`cursor = event.sequence` 在 `if` 之前）。不属于本项目的
 *      中间事件若不同样推进游标，就会被每 250ms 重新扫描一遍——这是 O(事件总数) 的空转。
 *      过滤只影响"发不发帧"，不影响"游标走不走"。
 *   2) **归属索引每次 send 都按需重建**（而不是建连接时算一次并持有）。原因是连接期间会新建
 *      Plan / Run / Loop，缓存下来的索引会把它们判成"不属于本项目"。重建的代价由 1) 的游标
 *      推进控制住了：每轮只看新增的那几个事件。**不要把它挪出 send**——那会引入"新 Plan 的
 *      事件被判成不属于本项目、而游标已经越过它们"的静默丢事件，且丢掉的补不回来。
 *   3) **每一次读取都必须带 limit**（`batchOptions`）。缺 limit 时 `afterSequence: 0`
 *      会把整张事件表读进内存再逐条 JSON.parse；生产库已有十几万条事件，
 *      其中绝大多数与当前 Project 无关。首次连接取尾部窗口，之后从游标向前读。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PipelineStore, ProjectService } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";
import { workbenchQuery } from "../schemas/workbench.js";
import { openSseChannel } from "../http/sse.js";
import { WORKBENCH_EVENT_TAIL_LIMIT, createProjectEventScope, workbenchSnapshot } from "../projections/workbench.js";
import { dailyActivity, localToday } from "../projections/activity.js";

/** 轮询一轮最多读取的事件条数；游标式增量读取用它给单轮兜底，避免突发写入时单轮读爆。 */
const WORKBENCH_EVENT_POLL_LIMIT = 500;

const activityParams = z.object({ projectId: z.string().min(1) });
/** `date` 由投影校验（必须是真实存在的本地日历日）；这里只约束形状。 */
const activityQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type WorkbenchRouteDeps = {
  store: PipelineStore;
  /** `workbenchSnapshot` 需要它算 summary；投影本身无状态，由这里显式传入。 */
  projects: ProjectService;
  /** 只用于把事件保留窗口透给"今日活动"（那组数据受回收影响）；缺省视为不回收。 */
  config?: FactoryConfig | undefined;
};

export function registerWorkbenchRoutes(app: FastifyInstance, deps: WorkbenchRouteDeps): void {
  const { store, projects } = deps;

  app.get("/api/v4/workbench", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench query" });
    if (!store.getProject(query.data.projectId))
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${query.data.projectId} not found` });
    return workbenchSnapshot(store, projects, query.data.projectId);
  });

  /**
   * 项目「今日活动」：执行完成 / 已合并 / 失败或阻塞 / 跨日仍在跑 四组。
   * 与 Workbench 快照分开：那是"现在有什么"，这是"这一天做了什么"，两者的时间语义不同
   * （见 projections/activity.ts 维护提示 1）。date 缺省是**服务器本地时区**的今天。
   */
  app.get("/api/v4/projects/:projectId/activity", async (request, reply) => {
    const params = activityParams.safeParse(request.params);
    const query = activityQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid activity query" });
    try {
      return dailyActivity(
        store,
        projects,
        params.data.projectId,
        query.data.date ?? localToday(),
        deps.config?.storage.eventRetentionDays ?? 0,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Activity unavailable";
      if (/not found/i.test(message)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: message });
      return reply.code(400).send({ code: "ACTIVITY_DATE_INVALID", error: message });
    }
  });

  app.get("/api/v4/workbench/events", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench event query" });
    if (!store.getProject(query.data.projectId))
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `PROJECT_NOT_FOUND: ${query.data.projectId}` });
    // 游标为 0 = 首次连接：只取尾部窗口（与 workbenchSnapshot 的窗口语义一致）。
    // 其余情况是"从游标接着读"，必须用 head —— 用 tail 会在游标落后时反复读到最新那一批，
    // 而游标又推进到本批末尾，中间的事件被永久跳过。
    const batchOptions = (afterSequence: number) =>
      afterSequence === 0
        ? { limit: WORKBENCH_EVENT_TAIL_LIMIT, limitFrom: "tail" as const }
        : { afterSequence, limit: WORKBENCH_EVENT_POLL_LIMIT, limitFrom: "head" as const };
    const eventsForProject = (afterSequence: number) => {
      const pending = store.listEvents(batchOptions(afterSequence));
      if (pending.length === 0) return pending;
      // 归属索引按需重建，保证连接期间新建的 Plan/Run/Loop 也能被正确归类。
      const belongsToProject = createProjectEventScope(store, query.data.projectId);
      return pending.filter((event) => belongsToProject(event));
    };
    if (query.data.format !== "sse") return { items: eventsForProject(query.data.afterSequence), cursor: store.getLastEventSequence() };
    let cursor = query.data.afterSequence;
    // poll 传的是"延迟取 send"的壳：send 里要用返回的通道，只能等通道建好再定义它。
    const sse = openSseChannel(request, reply, { poll: () => send() });
    const send = () => {
      const pending = store.listEvents(batchOptions(cursor));
      if (pending.length === 0) return;
      const belongsToProject = createProjectEventScope(store, query.data.projectId);
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
