/**
 * 模块职责：Workbench 快照与事件流的查询参数。
 *
 * 维护提示：`format` 在这里**有**默认值 `"json"`，与 agent-loop 的 `loopEventsQuery` 相反——
 *   Workbench 的 SSE 分支靠 `format=sse` 显式开启，而不看 accept 头。两处语义不同是既有
 *   事实，搬迁时逐字保留；要统一的话是行为变更，得单独立项，别顺手改。
 *   `afterSequence` 默认 0 表示"从头开始"，SSE 断线重连由客户端的 Last-Event-ID 覆写它。
 */
import { z } from "zod";

export const workbenchQuery = z.object({
  projectId: z.string().min(1),
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  format: z.enum(["json", "sse"]).default("json"),
});
