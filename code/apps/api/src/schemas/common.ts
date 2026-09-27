/**
 * 模块职责：**跨域共用**的输入 schema —— 被 3 个以上 route 文件使用的请求形状。
 *   判断一个 schema 该不该放这里：数一数它在 `routes/*.ts` 里的使用者。
 *   只有 1 个使用者 → 放在那个域的 `schemas/<域>.ts` 里，别往这里堆。
 *
 * 为什么需要这一层：此前 34 个 schema 与 97 条路由同处 server.ts 一个文件，谁用谁是隐式的。
 *   分域时暴露出一类**天然跨域**的 schema（项目级路径参数、写路径的操作者身份、暂停/取消
 *   的原因），它们若留在任何一个域里，都会逼出"plans.ts 反过来 import explorers.ts"这种
 *   循环。这些就是本文件存在的理由。
 *
 * 维护提示：**往这里加 schema 的门槛是"至少 3 个域"**，不是"看起来挺通用"。
 *   一旦某个 schema 只剩 1 个使用者，就该搬回它所属的域——本文件是共用面，不是杂物间。
 */
import { z } from "zod";

/** 项目级路径参数：`/api/v4/projects/:projectId/**` 的公共前缀。projects / explorers / hooks / execution-threads 等 8 个域都用它。 */
export const projectThreadParams = z.object({ projectId: z.string().min(1) });

/** 写路径的操作者身份。缺省 `local-user`：单机部署没有登录态，这个字段是给审计事件用的。 */
export const actorBody = z.object({ actorId: z.string().min(1).default("local-user") });

/** 暂停/取消的原因文案。**agent-loop 与 run 两个域的暂停/取消共用同一形状**，所以它在公共面而不是任一个域里。 */
export const loopReasonBody = z.object({ reason: z.string().trim().min(1).max(500).default("user_requested") });
