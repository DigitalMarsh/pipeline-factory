/**
 * 模块职责：项目级长期执行会话（ProjectExecutionThread）的持久化契约 ——
 *   会话本身、它的轮次状态，以及会话中一条有序消息。
 *
 * 为什么从 index.ts 抽出来（批 E）：这三个类型与 agent/project-execution-thread.ts
 *   （ProjectExecutionThreadService）本是一对，却一直留在 index.ts 里。搬进 agent/ 之后
 *   "会话怎么存"与"会话怎么被驱动"同目录，ProjectExecutionTurnStatus 的取值可以
 *   与 Service 里的转换点逐条对照。
 *
 * 维护提示：
 *   1) **这是三个"线程"里最容易认错的一个**：ProjectExecutionThread 是 Project 下唯一的
 *      长期 Executor 对话（每个项目一条）；ExplorerThread 是探索会话；
 *      run/types.ts 的 ExecutionThread 是某个 Run 专属的消息流聚合。三者不通用。
 *   2) **modelOverride / reasoningEffortOverride 为 null 表示"跟随 Project 的默认值"**，
 *      不是"没有配置"。写入空字符串会**覆盖**默认值 —— 空串与 null 在这里是两个意思。
 *   3) **RECOVERY_REQUIRED 必须与 FAILED 分开处理**：它是进程中断后的待恢复态
 *      （需要显式的恢复流程），把它当成 FAILED 会让用户看到"失败"而实际上是"待继续"。
 *      （曾经还有一个 WAITING_FOR_INPUT 属于同一类，但这条线没有回答入口，已删除——见下。）
 *   4) ProjectExecutionMessage 的一次轮次会产生**用户与助手两条消息，共享同一个 turnId**；
 *      sequence 在会话内单调。clientTurnId 是**客户端幂等键**，服务端用它去重，
 *      它与 turnId 不是一回事，不要互相赋值。
 *   5) loopId / model / reasoningEffort 是"这条消息由哪个 Loop、哪个模型产生"的回溯字段。
 *      它们不是所有历史行都有（老数据可能为 null），读路径要容忍 null，不要当必填用。
 */

import type { ProjectExecutionMessage, ProjectExecutionThread, ProjectExecutionTurnStatus } from "@pipeline-factory/contracts";

export type { ProjectExecutionMessage, ProjectExecutionThread, ProjectExecutionTurnStatus };
