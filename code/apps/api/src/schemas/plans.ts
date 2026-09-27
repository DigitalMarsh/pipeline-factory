/**
 * 模块职责：Plan 域的输入 schema —— 路径参数（plan / revision / revision-draft）、
 *   Plan 列表查询（`threadPlanQuery`）、创建 revision draft 的请求体。
 *
 * 维护提示：
 *   1) `planRevisionParams` 里的 `revision` 用 `z.coerce.number()`：HTTP 路径参数天生是
 *      字符串，URL 里的 `3` 必须被当成数字 3。**不要改成 `z.number()`**，那会让所有
 *      `/revisions/3` 请求变成 400。
 *   2) `threadPlanQuery` 的 `includeLineage` 与其余布尔项不同，用 `z.preprocess` 手工处理
 *      "true"/"false" 字符串——query string 里的布尔值不能靠 coerce，`Boolean("false")`
 *      是 `true`。新增布尔 query 参数时照抄这个写法。
 */
import { z } from "zod";

export const planIdParams = z.object({ planId: z.string().min(1) });
export const planRevisionParams = z.object({ planId: z.string().min(1), revision: z.coerce.number().int().positive() });
export const revisionDraftParams = z.object({ planId: z.string().min(1), draftId: z.string().min(1) });

export const threadPlanQuery = z.object({
  explorerThreadId: z.string().min(1).optional(),
  includeLineage: z.preprocess((value) => value === "false" ? false : value === "true" ? true : value, z.boolean().default(true)),
  status: z.string().optional(),
  q: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["queued_at", "last_event_at", "priority", "status"]).default("queued_at"),
});

export const revisionDraftBody = z.object({ fromRevision: z.number().int().positive(), explorerThreadId: z.string().min(1), discardUnmergedRun: z.boolean(), clientRequestId: z.string().min(1).max(200) });
