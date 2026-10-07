/**
 * 模块职责：项目生命周期 Hook 配置的写入形状（settings/hooks 的 PUT 体）。
 *
 * 维护提示：`start` / `cleanup` 两个槽位是**领域侧的生命周期点**，加第三个槽位时必须同时
 *   改 `run/hooks.ts` 的执行器与 `HookDefinition` 类型——这里只是入口的浅校验，schema 通过
 *   不代表领域侧认得这个槽位（多出来的字段会被 zod 默认丢弃，不会报错）。
 *   `maxAttempts` 上限 5 是刻意的：重试上限写在 schema 里是为了让超限请求在入口就被拒，
 *   而不是等到 Run 执行到一半才失败。
 *   `blocking` **只出现在 start 上**：cleanup 恒为不阻塞，领域侧会拒掉配在它上面的这个键
 *   （见 run/hooks.ts 维护提示 1）。这里不给 cleanup 声明它，让多余的字段在入口就被丢弃，
 *   而不是走到 project.ts 才 422。
 */
import { z } from "zod";

export const hookBody = z.object({
  start: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(), maxAttempts: z.number().int().min(1).max(5).optional(), blocking: z.boolean().optional() })
    .optional(),
  cleanup: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(), maxAttempts: z.number().int().min(1).max(5).optional() })
    .optional(),
});
