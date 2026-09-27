/**
 * 模块职责：路由注册的**唯一入口** —— 把 11 个按域切分的 `routes/*.ts` 汇总成一次调用，
 *   组合根只需构造依赖对象、调这一个函数。
 *
 * 设计要点（三点，都是为了让这个文件保持"没有逻辑"）：
 *   1) `ApiRouteDeps` 用**各域 deps 类型的交集**推导，不手抄字段。所以这里永远不会与某个域的
 *      deps 脱节：哪个域新增一个依赖，交集自动多一个必填字段，组合根不补就编译不过。
 *   2) 每个 `registerXxxRoutes(app, deps)` 直接传**同一个对象**。看起来像"传整个闭包环境"——
 *      与各 route 文件"显式 deps"的原则不冲突，因为**可见性由被调方的 deps 类型决定**：leaf 里
 *      只声明它要的那几个字段，多传的字段在文件内部根本看不见。P6 的度量
 *      （`grep -c "store\." routes/*.ts`）也因此不受影响。
 *   3) 本文件**只允许有 import、类型别名、注册调用**。任何 if / 变换 / 默认值都该留回组合根——
 *      否则"哪个域拿到什么"就又变得需要推理才能知道了。
 *
 * 注册顺序不影响匹配：97 条路由里没有通配符，Fastify 基数树对静态段与参数段按优先级匹配。
 * 顺序按"读起来顺"排：平台级 → 项目 / Explorer / Plan（主干）→ Run 及其下游（合并、变更提案）
 * → 观测类（workbench、hooks、agent loop、执行线程）。
 */
import type { FastifyInstance } from "fastify";
import { registerPlatformRoutes, type PlatformRouteDeps } from "./platform.js";
import { registerProjectRoutes, type ProjectRouteDeps } from "./projects.js";
import { registerExplorerRoutes, type ExplorerRouteDeps } from "./explorers.js";
import { registerPlanRoutes, type PlanRouteDeps } from "./plans.js";
import { registerRunRoutes, type RunRouteDeps } from "./runs.js";
import { registerMergeRequestRoutes, type MergeRequestRouteDeps } from "./merge-requests.js";
import { registerChangeProposalRoutes, type ChangeProposalRouteDeps } from "./change-proposals.js";
import { registerWorkbenchRoutes, type WorkbenchRouteDeps } from "./workbench.js";
import { registerHookRoutes, type HookRouteDeps } from "./hooks.js";
import { registerAgentLoopRoutes, type AgentLoopRouteDeps } from "./agent-loops.js";
import { registerExecutionThreadRoutes, type ExecutionThreadRouteDeps } from "./execution-threads.js";

/** 全部域所需依赖的并集（由各域 deps 类型交集推出，见模块头 1）。 */
export type ApiRouteDeps = PlatformRouteDeps &
  ProjectRouteDeps &
  ExplorerRouteDeps &
  PlanRouteDeps &
  RunRouteDeps &
  MergeRequestRouteDeps &
  ChangeProposalRouteDeps &
  WorkbenchRouteDeps &
  HookRouteDeps &
  AgentLoopRouteDeps &
  ExecutionThreadRouteDeps;

export function registerApiRoutes(app: FastifyInstance, deps: ApiRouteDeps): void {
  registerPlatformRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerExplorerRoutes(app, deps);
  registerPlanRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerMergeRequestRoutes(app, deps);
  registerChangeProposalRoutes(app, deps);
  registerWorkbenchRoutes(app, deps);
  registerHookRoutes(app, deps);
  registerAgentLoopRoutes(app, deps);
  registerExecutionThreadRoutes(app, deps);
}
