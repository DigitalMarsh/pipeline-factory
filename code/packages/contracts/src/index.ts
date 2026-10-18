/**
 * 模块职责：`@pipeline-factory/contracts` —— Web 与 API 之间共享的**契约层**。
 *
 * 只放两样东西：
 *   1) **API DTO / 实体视图的类型**：优先从 `@pipeline-factory/core` 再导出，保证"服务端算出来的
 *      形状"与"前端读到的形状"是同一份定义，而不是两边各抄一遍再用 parity 测试锁住。
 *   2) **HTTP 输入 schema**（zod）：路由校验与将来的客户端预校验共用同一份。
 *
 * 维护提示：
 *   1) 本包**不产生运行时代码**（只有 zod schema 与 export *）。不要在里放工具函数、常量表或
 *      任何需要初始化副作用的东西——那会让 Web 的构建被迫带上服务端依赖。
 *   2) 对 `@pipeline-factory/core` 的依赖是**类型级**的：`export type { … }` 在编译后不产生 import。
 *      别在这里写 `export { something }` 去转发值（例如模型类），那会把领域运行时拉进浏览器。
 *   3) 新增跨端类型时先判断归属：业务事实（实体、状态机）属于 domain，由这里再导出；
 *      HTTP 特有的请求/响应外壳（分页、查询参数、错误码）才在本包直接定义。
 */
export type {
  AgentLoopDiagnostics,
  AgentLoopState,
  ExecutionJournalPayload,
  ExecutionTelemetry,
  ExecutionThreadSummary,
  ExplorerActivityItem,
  ExplorerActivityKind,
  ExplorerInputRequest,
  ExplorerThreadContextSummary,
  ExplorerTurn,
  MergeRequest,
  MessageAttachmentView as MessageAttachment,
  ModelInputQuestion,
  ModelMessagePhase,
  ModelUsage,
  PlanDispatchState,
  PlanDispatchStatus,
  PlanDispatchWaitReason,
  PlanLifecycleEntry,
  PlanLifecycleStatus,
  PlanStatus,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  ProjectExecutionTurnStatus,
  RunGuidance,
  VerificationRun,
  WorktreeCleanupResult,
  WorktreeInventory,
  WorktreeItem,
  WorktreeLogCommit,
  WorktreeMergePreview,
  WorktreeMergeResult,
  WorktreeServices,
} from "@pipeline-factory/core";

export * from "./schemas/index.js";
