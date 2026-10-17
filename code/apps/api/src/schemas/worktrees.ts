/**
 * 模块职责：Worktree 域的输入 schema —— 预览 / 合并 / 清理三组请求体。
 *
 * 维护提示：
 *   1) **`itemId` 走 body 而不是路径段**：它的形状是 `branch:<name>`，而分支名几乎一定含 `/`。
 *      放进路径要靠编码约定，任何一个代理或转发层重新编码都会改掉它；放 body 里就是一个字符串。
 *   2) 两个 `expected*` 字段是**乐观并发凭据**，允许 null（detached 项没有分支头），
 *      但**不允许缺省**：缺省会让"没带凭据"与"凭据恰好为空"混成一种情况。
 */
import { z } from "zod";

/** 只带 itemId 的请求：预览（预览本身不改仓库，但要跑 `merge-tree`，所以是 POST）。 */
export const worktreeItemBody = z.object({ itemId: z.string().trim().min(1).max(4096) });

/** 合并：必须带回预览给出的两个 SHA。 */
export const worktreeMergeBody = z.object({
  itemId: z.string().trim().min(1).max(4096),
  expectedBranchHead: z.string().trim().max(200).nullable(),
  expectedBaseHead: z.string().trim().max(200).nullable(),
});

/** 清理：只需分支头的并发凭据。 */
export const worktreeCleanupBody = z.object({
  itemId: z.string().trim().min(1).max(4096),
  expectedBranchHead: z.string().trim().max(200).nullable(),
});
