/**
 * 模块职责：Agent Loop 域的输入 schema —— 路径参数（loopId）与 events 路由的查询参数。
 *
 * 维护提示：`loopEventsQuery.format` 是 SSE/JSON 双分支的开关之一（另一条是 `accept` 头）。
 *   `format` 用 `z.enum(["json","sse"])` 且**无默认值**——它的"未指定"是有意义的第三种状态
 *   （此时看 accept 头），所以那些同时提供两种格式的路由里，**不要给它补 `.default("json")`**。
 */
import { z } from "zod";

export const agentLoopParams = z.object({ loopId: z.string().min(1) });
export const loopEventsQuery = z.object({ format: z.enum(["json", "sse"]).optional(), afterSequence: z.coerce.number().int().nonnegative().optional() });
