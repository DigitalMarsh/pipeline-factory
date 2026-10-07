/**
 * 模块职责：项目级执行线程（execution-thread）的输入 schema —— 发消息、改偏好、读事件流。
 *
 * 维护提示：
 *   1) `model` 与 `reasoningEffort` 都**可置 null**，且 null 是有语义的（"回到项目默认"），
 *      与"字段缺失"（不改）是两回事。所以这里是 `.nullable()` 而不是 `.optional()`——
 *      改成 optional 会让"恢复默认"这个操作无法表达。
 *   2) `reasoningEffort` 的枚举抄自模型侧支持的推理强度，与 `apps/web` 的选择器共用同一组字面量。
 *      增删推理强度要同时看三处：这里、web 的选择器、以及模型网关对推理强度的处理。
 */
import { z } from "zod";

export const projectExecutionTurnBody = z.object({
  content: z.string().trim().min(1).max(20_000),
  clientTurnId: z.string().trim().min(1).max(160),
});
export const projectExecutionPreferencesBody = z.object({
  model: z.string().trim().min(1).max(200).nullable(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).nullable(),
});
export const projectExecutionEventsQuery = z.object({ afterSequence: z.coerce.number().int().nonnegative().optional() });
