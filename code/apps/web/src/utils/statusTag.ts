/**
 * 模块职责：状态 → `el-tag` 的 `type` 映射。**唯一出处**。
 *
 * 为什么单独一个模块：同一类"小状态标签"原先有三套手写样式（`.agent-status` / `.processing-status` /
 * `.input-resolved-status`），颜色写在 `styles.css` 里、与"这个状态到底是什么意思"没有任何关系——
 * 改一个颜色要去翻样式表才知道它对应哪个状态。统一成 `el-tag` 之后颜色由 `type` 决定，
 * 而"哪个状态配哪个 type"必须只有一处，否则两张表迟早对不上。
 *
 * 维护提示：
 *   1) 这里只管**颜色语义**，不管文案——文案在各域的 label 函数里（如 `inputStatusLabel`）。
 *   2) `statusTagType` 与 `executionTasks.ts` 的 `executionTaskStatusType` **逐值对齐**（完成 = `success`、
 *      失败/阻塞 = `danger`、进行中 = `warning`、其余 = `info`）：同一屏里两种状态标签不能两套语义，
 *      而任务标签的取向是既有事实。
 *   3) 界面上的三段式（`size="small" effect="light"`）与 `ExecutionHeaderStatus` 的步骤标签相同，
 *      改这里就要连着看那边，别让同一屏里两种标签长得不一样。
 */
import type { ExplorerInputRequest } from "../types";
import type { ProjectExecutionMessage } from "../types";
import type { RequirementStatusTone } from "./explorerRequirementRows";

export type StatusTagType = "primary" | "success" | "info" | "warning" | "danger";

/** 执行会话条目（`ExecutionStreamItem`）与探索活动（`ExplorerActivityItem`）共用的状态取值。 */
export function statusTagType(status: "RUNNING" | "COMPLETED" | "WAITING" | "FAILED" | "INFO" | "UNKNOWN"): StatusTagType {
  return ({
    RUNNING: "warning",
    COMPLETED: "success",
    WAITING: "info",
    FAILED: "danger",
    INFO: "info",
    UNKNOWN: "info",
  } as const)[status];
}

/** 结构化提问卡的状态机（见 `docs/消息类型及事件状态机流程图.md` §1.3 B）。 */
export function inputStatusTagType(status: ExplorerInputRequest["status"]): StatusTagType {
  return ({
    OPEN: "info",
    SUBMITTING: "primary",
    ANSWERED: "success",
    CANCELLED: "info",
    RECOVERY_REQUIRED: "danger",
  } as const)[status];
}

/** 需求清单里那两个状态（`explorerRequirementRows` 的 `tone`）→ 标签类型。五种 tone 与五种类型一一对应。 */
export function requirementStatusTagType(tone: RequirementStatusTone): StatusTagType {
  return ({
    progress: "primary",
    attention: "warning",
    success: "success",
    danger: "danger",
    neutral: "info",
  } as const)[tone];
}

/** 项目执行线程面板（对话框 C）里助手消息的状态。与 `ProjectExecutionMessage.status` 同集合。 */
export function projectExecutionStatusTagType(status: ProjectExecutionMessage["status"]): StatusTagType {
  return ({
    QUEUED: "info",
    RUNNING: "warning",
    COMPLETED: "success",
    FAILED: "danger",
    CANCELLED: "info",
    RECOVERY_REQUIRED: "danger",
  } as const)[status];
}
