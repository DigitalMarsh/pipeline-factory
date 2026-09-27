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
