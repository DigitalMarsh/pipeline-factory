/**
 * 模块职责：ChangeProposal 的创建请求体。
 *
 * 维护提示：`resolvedContract` 是 `z.record(z.unknown())` —— **刻意不做深校验**。它承载的是领域侧的
 *   `ResolvedPlanContract`（提案人交上来的那一份），在这里再写一遍形状只会得到两套互相漂移的规则。
 *   路由里那句 `body.data.resolvedContract as unknown as ResolvedPlanContract` 就是这条边界的显式标记。
 */
import { z } from "zod";

export const changeProposalBody = z.object({ reason: z.string().trim().min(1).max(4_000), requestedChanges: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50), resolvedContract: z.record(z.unknown()), createdBy: z.string().min(1).default("executor") });
