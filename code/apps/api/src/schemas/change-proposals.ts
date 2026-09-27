/**
 * 模块职责：ChangeProposal 的创建请求体。
 *
 * 维护提示：`contract` 是 `z.record(z.unknown())` —— **刻意不做深校验**。契约的合法性由
 *   领域侧的 `validatePlanContract` 判定（它给出的是带 code 的领域错误，不是 zod 的 issue），
 *   在这里再写一遍形状只会得到两套互相漂移的规则。路由里那句
 *   `body.data.contract as unknown as PlanContract` 就是这条边界的显式标记。
 */
import { z } from "zod";

export const changeProposalBody = z.object({ reason: z.string().trim().min(1).max(4_000), requestedChanges: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50), contract: z.record(z.unknown()), createdBy: z.string().min(1).default("executor") });
