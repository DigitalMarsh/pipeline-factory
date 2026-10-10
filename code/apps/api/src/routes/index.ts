/**
 * 模块职责：路由注册的**唯一入口** —— 把 10 个按域切分的 `routes/*.ts` 汇总成一次调用，
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
 * 读路径的约定（P6 的结论，动任何 route 之前先读这条）：
 *   各域 route 里的 **Store 直连读**是**有意保留**的，不是漏抽。原因可核查：六个业务 Service
 *   都是**写优先**的，它们的读方法在实体缺失时**抛错**，而 HTTP 读路径需要的是"返回 null → 404"
 *   或 `?.` / `??` 降级。`ExplorerService.list(projectId)` 更隐蔽——它会带上 ARCHIVED 线程，
 *   与 `listThreads()` 再按 `state !== "ARCHIVED"` 过滤**不等价**。逐字透传的读方法只有
 *   MergeService 的 `findByRun` / `get` / `list` 三个，都已接上。
 *   **不要为了把这类调用清零而现造 Service 读方法**——那是把重构变成功能开发。真实缺口逐条
 *   记在 `docs/api-read-path-service-gaps.md`（含出现次数、为什么不能直接用、所需签名），
 *   要补的时候按那张表补，一次补一个并同时改掉对应的 route 调用点。
 *   （上一段刻意不写出那个"store + 点"的字面量：它是 P6 的棘轮度量对象，注释里出现一次就会
 *   让计数假性增高——`routes/platform.ts` 模块头里那处就是这么来的。）
 *
 * 注册顺序不影响匹配：100 条路由里没有通配符，Fastify 基数树对静态段与参数段按优先级匹配。
 * 顺序按"读起来顺"排：平台级 → 项目 / Explorer / Plan（主干）→ Run 及其下游（合并、变更提案）
 * → 观测类（hooks、agent loop、执行线程）。
 */
import type { FastifyInstance } from "fastify";
import { registerPlatformRoutes, type PlatformRouteDeps } from "./platform.js";
import { registerProjectRoutes, type ProjectRouteDeps } from "./projects.js";
import { registerExplorerRoutes, type ExplorerRouteDeps } from "./explorers.js";
import { registerPlanRoutes, type PlanRouteDeps } from "./plans.js";
import { registerRunRoutes, type RunRouteDeps } from "./runs.js";
import { registerMergeRequestRoutes, type MergeRequestRouteDeps } from "./merge-requests.js";
import { registerChangeProposalRoutes, type ChangeProposalRouteDeps } from "./change-proposals.js";
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
  registerHookRoutes(app, deps);
  registerAgentLoopRoutes(app, deps);
  registerExecutionThreadRoutes(app, deps);
}
