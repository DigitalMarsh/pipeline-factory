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

export const guidanceBody = z.object({ content: z.string().trim().min(1).max(20_000) });
