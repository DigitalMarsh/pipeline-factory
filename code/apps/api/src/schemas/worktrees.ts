/**
 * 模块职责：Worktree 域的输入 schema —— 列表范围、预览 / 合并 / 清理的请求体，
 *   以及提交历史与 diff 的查询参数。
 *
 * 维护提示：
 *   1) **`itemId` 走 body 而不是路径段**：它的形状是 `branch:<name>`，而分支名几乎一定含 `/`。
 *      放进路径要靠编码约定，任何一个代理或转发层重新编码都会改掉它；放 body 里就是一个字符串。
 *   2) 两个 `expected*` 字段是**乐观并发凭据**，允许 null（detached 项没有分支头），
 *      但**不允许缺省**：缺省会让"没带凭据"与"凭据恰好为空"混成一种情况。
 *   3) `includeFiltered` 接受 `1/true/0/false`：它是给界面开关用的，不是业务字段；
 *      用枚举而不是 `z.coerce.boolean()`，因为后者会把字符串 `"false"` 也当成 true。
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

/** 清理：只需分支/提交头的并发凭据。 */
export const worktreeCleanupBody = z.object({
  itemId: z.string().trim().min(1).max(4096),
  expectedBranchHead: z.string().trim().max(200).nullable(),
});

/** 列表范围：`includeFiltered=1` 时忽略项目设置的默认范围（模式 / 忽略 / detached 开关）。 */
export const worktreeListQuery = z.object({
  includeFiltered: z.enum(["1", "true", "0", "false"]).optional(),
});

/** 提交历史：ref 可以是分支名或提交号；limit 与服务端上限对齐。 */
export const worktreeLogQuery = z.object({
  ref: z.string().trim().min(1).max(4096),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 单文件 diff：`previousPath` 只在 rename / copy 时需要。 */
export const worktreeDiffQuery = z.object({
  path: z.string().trim().min(1).max(4096),
  previousPath: z.string().trim().max(4096).optional(),
});

/** 提交详情 / diff 的路径参数。 */
export const worktreeCommitParams = z.object({
  projectId: z.string().min(1),
  commit: z.string().trim().min(1).max(200),
});

/** 服务清单 / 日志查询：只带 itemId（日志再带 serviceId）。 */
export const worktreeServicesQuery = z.object({ itemId: z.string().trim().min(1).max(4096) });
export const worktreeServiceLogsQuery = z.object({
  itemId: z.string().trim().min(1).max(4096),
  serviceId: z.string().trim().min(1).max(200),
});
export const worktreeServiceActionBody = z.object({
  itemId: z.string().trim().min(1).max(4096),
  serviceId: z.string().trim().min(1).max(200),
});

/** 执行目录：切换目标、单个服务的启停与日志。 */
export const worktreeRuntimeSwitchBody = z.object({ itemId: z.string().trim().min(1).max(4096) });
export const worktreeRuntimeServiceBody = z.object({ serviceId: z.string().trim().min(1).max(200) });
export const worktreeRuntimeLogsQuery = z.object({ serviceId: z.string().trim().min(1).max(200) });
