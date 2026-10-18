/**
 * 模块职责：`@pipeline-factory/contracts` —— Web、API 与 core 共享的**最底层契约**。
 *
 * 只放两样东西：
 *   1) **业务实体与 DTO 的类型**（`entities.ts`）：跨端形状的权威定义。core 反向 import 这些类型，
 *      Web/API 也直接读它们，因此不存在"两边各抄一遍再靠 parity 测试锁住"的问题。
 *   2) **HTTP 输入 schema**（zod）：路由校验与将来的客户端预校验共用同一份。
 *
 * 维护提示：
 *   1) 本包**不依赖 core**，也不产生业务运行时代码（只有 zod schema 与 `export *`）。
 *      不要在里放工具函数、常量表或任何需要初始化副作用的东西。
 *   2) 新增跨端类型时先判断归属：业务事实（实体、状态机）放 `entities.ts`；
 *      只有 HTTP 特有的请求/响应外壳才放进 schemas。
 *   3) 类型是 type-only 的；Web 的 `export type { … }` 不会把 zod schema 打进浏览器。
 */
export * from "./entities.js";
// Web 端历史名称：同一份视图类型，别名保留以免大范围改调用点。
export type { MessageAttachmentView as MessageAttachment } from "./entities.js";
export * from "./schemas/index.js";
