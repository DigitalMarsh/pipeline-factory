/**
 * 模块职责：Run 域的输入 schema —— 目前只有 guidance（向运行中的 Run 追加人工指导）。
 *
 * 维护提示：这个文件现在很短是正常的，**不要为了"凑满"把别的域的形状挪进来**。
 *   Run 域的其余输入（pause / resume / cancel 的原因）在 `schemas/common.ts` 的
 *   `loopReasonBody`——它与 agent-loop 共用。Run 的路径参数 `:runId` 直接内联在路由里
 *   用 `z.object({ runId: ... })`，尚未提出来；等某个域的 runId 校验要加约束时再统一，
 *   现在提取只是把一行代码换个位置。
 */
import { z } from "zod";

/**
 * 投递补充要求的形状。
 *
 * `mode` 是**投递方式**，不是"这条要求重不重要"：`steer` 交给正在跑的那一轮（下一个步骤边界生效），
 * `queue` 等这一轮结束后起新的一轮。省略或 `auto` 时由服务端按"有没有在跑的 Loop"自己选——
 * 客户端不该去猜这件事（它看到的 Loop 状态可能是几百毫秒前的）。
 */
export const guidanceBody = z.object({
  content: z.string().trim().min(1).max(20_000),
  mode: z.enum(["auto", "steer", "queue"]).optional(),
});
