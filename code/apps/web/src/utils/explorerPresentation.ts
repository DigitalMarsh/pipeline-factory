/**
 * 模块职责：Explorer 视图的**纯展示映射** —— 把领域枚举与时间戳翻成界面上的文案。
 *
 * 维护提示：
 *   1) 本文件里的每个函数都必须**无状态**：不读 ref、不碰 DOM、不发请求。凡是需要组件状态的
 *      （例如"这个请求正在提交中"），一律**加参数**传进来（见 `inputStatusLabel` 的第二参），
 *      不要让它变成 composable 或在这里引入响应式。
 *   2) 这些映射原本内联在 `views/ExplorerView.vue` 的 `<script setup>` 里，随之带来的问题是
 *      **无法单独测试**（仓库没有 `@vue/test-utils`，组件测试要手搭 `createApp` + jsdom）。
 *      下沉到这里之后每个分支都能被直接断言。
 *   3) 未知枚举值一律**回落为原字符串**而不是空串——界面宁可显示 `SOME_NEW_STATUS` 也不要留白，
 *      这样后端新增状态时在页面上一眼就能看出来。
 *   4) 「这类消息要不要显示、显示成卡片还是一行」**只有 `EXPLORER_DISPLAY_MODES` 一处**（见文件末尾）。
 *      视图不再自己比对 kind 字符串来决定显隐；要改呈现，改那张表。
 */
import type { ExplorerActivityItem, ExplorerInputRequest, ExplorerThread } from "../types";

/** 消息时间：只到分钟，中文环境。传入的一定是 ISO 时间串（调用点来自领域数据）。 */
export function formatTurnTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function explorerDisplayTitle(item: ExplorerThread | null): string {
  return item?.title || "探索线程";
}

/** 输入卡片的 DOM 锚点。`explorerTimeline.ts` 生成导航项时用的是同一条规则。 */
export function inputRequestTarget(request: Pick<ExplorerInputRequest, "id">): string {
  return `input-request-${request.id}`;
}

/**
 * 输入请求的状态文案。`inFlightRequestId` 由调用方传组件自己的 `inputAnswerInFlight` ——
 * 只有请求 id 与它相等时才覆盖为 "Submitting"，因为此时**服务端状态还没变**（仍是 OPEN），
 * 界面必须靠本地在途标记抢先反映"已提交、等确认"。
 */
export function inputStatusLabel(request: Pick<ExplorerInputRequest, "id" | "status">, inFlightRequestId: string | null): string {
  if (inFlightRequestId === request.id) return "Submitting";
  return ({
    OPEN: "Waiting for answer",
    SUBMITTING: "Submitting",
    ANSWERED: "Answered",
    AUTO_RESOLVED: "Auto-resolved",
    CANCELLED: "Cancelled",
    RECOVERY_REQUIRED: "Recovery required",
  } as Record<ExplorerInputRequest["status"], string>)[request.status];
}

export function activityStatusLabel(item: Pick<ExplorerActivityItem, "status">): string {
  if (item.status === "WAITING") return "Waiting";
  if (item.status === "FAILED") return "Failed";
  if (item.status === "RUNNING") return "Running";
  return "Completed";
}

/** 未知 kind 回落为原字符串（见模块头 3）。`USER_MESSAGE` / `ASSISTANT_MESSAGE` 走的就是这条路。 */
export function activityKindLabel(kind: ExplorerActivityItem["kind"]): string {
  return ({
    REASONING_SUMMARY: "Reasoning",
    INPUT_REQUIRED: "Input required",
    INPUT_RESOLVED: "Input resolved",
    TOOL_STARTED: "Tool started",
    TOOL_COMPLETED: "Tool completed",
    TOOL_DENIED: "Tool denied",
    MCP_ACTIVITY: "MCP activity",
    CONTEXT_COMPACTED: "Context checkpoint",
    GATE_CHECKED: "Gate checked",
    TURN_STATUS: "Turn status",
  } as Partial<Record<ExplorerActivityItem["kind"], string>>)[kind] ?? kind;
}

export function activityIconKind(kind: ExplorerActivityItem["kind"]): "info" | "success" | "warning" {
  if (kind === "TOOL_DENIED" || kind === "GATE_CHECKED") return "warning";
  if (kind === "TOOL_COMPLETED" || kind === "INPUT_RESOLVED") return "success";
  return "info";
}

/**
 * 探索会话里的消息类型。**这张联合类型就是"消息清单"**——每一种在聊天框里怎么呈现，
 * 由下面 `EXPLORER_DISPLAY_MODES` 一张表决定；要调整呈现方式，改表即可，不用翻模板。
 *
 * 前 12 项直接取自 `ExplorerActivityItem["kind"]`（即领域侧的 `ExplorerActivityKind`），
 * **不是手抄一份**：后端新增一种活动时，`type-parity.test.ts` 先报两侧类型不一致，这里随即编译不过，
 * 逼着人来表里补一次"这类消息怎么显示"的决定。后三项不是活动条目的 kind，由投影或模板在别处产生：
 * - `input-request`：`ExplorerTimelineItem` 的 `input` 分支（结构化输入卡片，提问与回答共用一张卡）
 * - `plan-created`：`plan` 分支（游离 Plan 的 PLAN CREATED 卡片）
 * - `candidate-plan`：助手消息**内嵌**的候选方案卡，不是独立时间线条目
 */
export type ExplorerMessageType = ExplorerActivityItem["kind"] | "input-request" | "plan-created" | "candidate-plan";

/**
 * 呈现档位。**探索侧今天只有三档**——这是当下事实，不是漏写：
 * - `card`：完整卡片（正文 / 方案 / 输入）
 * - `line`：紧凑活动行
 * - `hidden`：不渲染
 *
 * 执行侧那份表（`utils/executionStream.ts` 的 `EXECUTION_DISPLAY_MODES`）还有一档 `folded`
 * （折进所属执行步骤的「N 条活动」），探索侧**没有承载面**：这里的时间线是平铺的，
 * 没有"步骤"这一层可以折进去。要加这一档，得先有对应的分组实现，不要先在类型里留个空档位。
 */
export type ExplorerDisplayMode = "card" | "line" | "hidden";

/**
 * **消息类型 → 呈现档位。这张表就是"清单"本身。**
 *
 * 判据是每条消息对"看懂这次探索"的贡献：人说的话、模型正文、方案与结构化输入是 `card`；
 * 工具、MCP、上下文压缩、门禁这类过程动作是 `line`。
 *
 * `INPUT_REQUIRED` / `INPUT_RESOLVED` 标成 `hidden` 是**兜底**：正常情况下投影层
 * （`utils/explorerTimeline.ts` 的 `buildExplorerTimeline`）在存在输入卡时就已经不产出这两行——
 * "问了什么、答了什么"由结构化输入卡自己承载。漏到这里说明没有对应的输入卡，
 * 而这两行只剩一句"有 1 个结构化问题在等"，既答不了也点不进去，不该以裸行出现。
 */
export const EXPLORER_DISPLAY_MODES: Record<ExplorerMessageType, ExplorerDisplayMode> = {
  USER_MESSAGE: "card",
  ASSISTANT_MESSAGE: "card",
  REASONING_SUMMARY: "line",
  INPUT_REQUIRED: "hidden",
  INPUT_RESOLVED: "hidden",
  TOOL_STARTED: "line",
  TOOL_COMPLETED: "line",
  TOOL_DENIED: "line",
  MCP_ACTIVITY: "line",
  CONTEXT_COMPACTED: "line",
  GATE_CHECKED: "line",
  TURN_STATUS: "line",
  "input-request": "card",
  "plan-created": "card",
  "candidate-plan": "card",
};

/** 这类消息该怎么呈现。视图只问它，不再自己判断"该不该显示、显示成什么样"。 */
export function explorerDisplayMode(type: ExplorerMessageType): ExplorerDisplayMode {
  return EXPLORER_DISPLAY_MODES[type];
}
