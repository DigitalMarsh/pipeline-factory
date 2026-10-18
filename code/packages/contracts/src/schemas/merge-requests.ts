/**
 * 模块职责：MergeRequest 域的输入 schema —— 创建 MergeRequest 时的目标提交、以及
 *   人工确认已合并时的实际合并提交。
 *
 * 维护提示：两个 schema 形状相同但**语义不同，不要合并成一个**。`sourceCommit` 是
 *   "要合并的源提交"（创建 MergeRequest 时由调用方指定），`targetCommit` 是
 *   "实际落地在目标分支上的提交"（人工确认时回填）。合成一个 `commitBody` 会让以后
 *   只给其中一个加约束（比如 targetCommit 要校验存在性）时无处安放。
 */
import { z } from "zod";

export const sourceCommitBody = z.object({ sourceCommit: z.string().trim().min(1).max(200) });
export const targetCommitBody = z.object({ targetCommit: z.string().trim().min(1).max(200) });
