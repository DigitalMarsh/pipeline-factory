/**
 * 模块职责：Explorer 与 ExplorerThread 域的输入 schema —— 路径参数（explorer /
 *   explorer-plan）、创建与改名请求体、activity/candidate 查询、以及 v4 对话相关的
 *   turn / answer / thread 查询 / 结构化追问查询。
 *
 * 维护提示：
 *   1) `clientTurnId` / `clientRequestId` 是**幂等键**，长度上限（200）来自 Store 侧对
 *      客户端标识的约束。改这个上限前先查 `store/` 里的去重实现，别只看这里。
 *   2) `v4InputQuery.status` 的枚举**与领域的 `ExplorerInputRequestStatus` 一一对应**。
 *      领域新增状态时必须同步这个列表，否则新状态的追问在查询侧被静默过滤掉——这类
 *      "枚举写死在 HTTP 层"的地方是本仓最典型的隐式契约之一。
 *   3) `content` 上限 20_000 与 `projectExecutionTurnBody` 保持一致（同一棵对话树的两个入口）。
 */
import { z } from "zod";

export const projectExplorerParams = z.object({ projectId: z.string().min(1), explorerId: z.string().min(1) });
export const projectExplorerPlanParams = z.object({ projectId: z.string().min(1), explorerId: z.string().min(1), explorerPlanId: z.string().min(1) });

export const explorerCreateBody = z.object({ title: z.string().trim().min(1).max(200).optional(), originThreadId: z.string().min(1).optional() });
export const explorerRenameBody = z.object({ title: z.string().trim().min(1).max(200) });
export const explorerActivityQuery = z.object({ explorerPlanId: z.string().min(1), afterSequence: z.coerce.number().int().nonnegative().optional() });
export const explorerCandidateQuery = z.object({ explorerPlanId: z.string().min(1).optional() });

export const v4TurnBody = z.object({ threadId: z.string().min(1), explorerPlanId: z.string().min(1), content: z.string().trim().min(1).max(20_000), clientTurnId: z.string().min(1).max(200) });
export const v4AnswerBody = z.object({ clientRequestId: z.string().min(1).max(200), answers: z.record(z.object({ answers: z.array(z.string().max(20_000)).min(1) })), actorId: z.string().min(1).default("local-user") });
export const v4ThreadQuery = z.object({ threadId: z.string().min(1).optional(), explorerPlanId: z.string().min(1), afterSequence: z.coerce.number().int().nonnegative().optional() });
export const v4ThreadStatusQuery = z.object({ threadId: z.string().min(1), afterSequence: z.coerce.number().int().nonnegative().optional() });
export const v4InputQuery = z.object({ threadId: z.string().min(1).optional(), explorerPlanId: z.string().min(1), status: z.enum(["OPEN", "SUBMITTING", "ANSWERED", "CANCELLED", "AUTO_RESOLVED", "RECOVERY_REQUIRED"]).optional() });
