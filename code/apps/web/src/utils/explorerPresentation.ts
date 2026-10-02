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

/**
 * 活动行要摆的字段。**视图只负责摆位置，"摆哪个字段"全部在这里决定**——这样"这一条到底显示什么"
 * 可以单测，也不必摊进模板里的一长串三元表达式。
 */
export type ExplorerActivityLine = {
  /** 行首标签：这一条是什么。 */
  label: string;
  /** 主标识：工具名、MCP 工具名、门禁动作。没有可说的就是 null，视图不留空位。 */
  name: string | null;
  /** 诊断尾巴：调用 id、上下文条数。同样可以是 null。 */
  reference: string | null;
  /** 正文：说清发生了什么。没有可说的就是空串——宁可少一行字，也不摆"工具返回了结果"这种占位句。 */
  body: string;
};

/** 过程活动的行首标签。`USER_MESSAGE` / `ASSISTANT_MESSAGE` 刻意不在表里——它们走消息卡片，不显示标签。 */
const ACTIVITY_LABELS: Partial<Record<ExplorerActivityItem["kind"], string>> = {
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
};

/**
 * 八类过程活动各自摆什么。**未知 kind 回落为原字符串**（见模块头 3）：
 * 宁可显示 `TOOL_SOMETHING` 也不要留白——后端加了一种活动时，页面上一眼就能看出来。
 *
 * 取值上的两条取舍：
 * 1. 有身份的（工具名、MCP 工具名、门禁动作）放 `name`，**不塞进标签**——标签回答"这是什么"，
 *    名字回答"是哪一个"，混在一起读起来是一句话，扫一眼分不出层次。
 * 2. 领域给的占位句（"The tool returned a result."）不摆——它没告诉读者任何事。
 */
export function explorerActivityLine(item: ExplorerActivityItem): ExplorerActivityLine {
  const label = ACTIVITY_LABELS[item.kind] ?? item.kind;
  // **同一个 kind 有两个来源，字段形状不同。** 领域记的 Loop 步骤把工具名放在 `details.tool`、
  // 结束时只留一句"工具返回了结果"；Provider 活动（Codex / Claude 回来的 itemType）把名字放在
  // `title`、把"到底跑了什么"放在 `summary`（命令行、工具入参摘要），并在详情里打了
  // `providerControlled` 标记。不分开处理，Provider 那一路最有信息量的 summary 会被当成占位句丢掉。
  if (item.details?.providerControlled === true) {
    // 推理流没有名字可言，title 只是 Provider 的类别名，摆出来会和标签重复。
    // MCP 调用也走这一路（它只可能来自 Provider 活动），名字取 Server 给的 title。
    const named = item.kind !== "REASONING_SUMMARY";
    return { label, name: named ? item.title : null, reference: named ? detailsText(item, "itemId") : null, body: item.summary };
  }
  const tool = detailsText(item, "tool");
  const callId = detailsText(item, "callId");
  switch (item.kind) {
    case "TOOL_STARTED":
      // 领域把工具名同时写进了 summary 和 details.tool；摆一次就够。
      return { label, name: tool, reference: callId, body: tool ? "" : item.summary };
    case "TOOL_COMPLETED":
      // 结束时领域只留一句"工具返回了结果"，等于没说；真正有信息量的是 reason（有才摆）。
      // 这行靠成功图标 + 调用 id 定位，不必为了填满再补一句废话。
      return { label, name: tool, reference: callId, body: detailsText(item, "reason") ?? "" };
    case "TOOL_DENIED":
      return { label, name: tool, reference: callId, body: item.summary };
    case "CONTEXT_COMPACTED": {
      const count = item.details?.messageCount;
      return { label, name: null, reference: typeof count === "number" ? `${count} messages` : null, body: "" };
    }
    case "GATE_CHECKED":
      // 门禁的动作（allow / blocked）是判定结论本身，比标签重要。
      return { label, name: detailsText(item, "action"), reference: null, body: item.summary };
    case "TURN_STATUS":
    case "REASONING_SUMMARY":
    default:
      return { label, name: null, reference: null, body: item.summary };
  }
}

/** `details` 里取一段非空文本；取不到就是 null。 */
function detailsText(item: ExplorerActivityItem, key: string): string | null {
  const value = item.details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
 * 呈现档位。**执行侧的 card / line / folded / hidden 是按"占多少地方"分的，探索侧按"是什么"分**——
 * 因为探索时间线是平铺的，没有"步骤"这一层可以折叠，密度分档区分不出"模型在思考"和"工具被拒绝"
 * 这两件事，而它们本来就该长得不一样：
 * - `card`：完整卡片（正文 / 方案 / 结构化输入）
 * - `tool`：调用行——工具与 MCP，交代"谁在跑、跑完没、是哪一次调用"
 * - `reasoning`：推理行——背景音，最轻的一档，不该有卡片的重量
 * - `divider`：分隔行——上下文压缩是会话在这里换了上下文，是边界不是事件
 * - `gate`：判定行——门禁给出的是**结论**（放行 / 拦截），不是过程
 * - `turn-status`：状态行——轮次占位，只在没有正文可显示时出现
 * - `hidden`：不渲染
 */
export type ExplorerDisplayMode = "card" | "tool" | "reasoning" | "divider" | "gate" | "turn-status" | "hidden";

/**
 * **消息类型 → 呈现档位。这张表就是"清单"本身。**
 *
 * 判据是每条消息对"看懂这次探索"的贡献：人说的话、模型正文、方案与结构化输入是 `card`；
 * 八类过程活动按**语义**各归各的行——四类带调用身份的归 `tool`（靠标签与语调区分开始 / 完成 / 被拒 / MCP），
 * 门禁是判定，轮次是占位，推理是背景音，上下文压缩是分隔。
 *
 * `INPUT_REQUIRED` / `INPUT_RESOLVED` 标成 `hidden` 是**兜底**：正常情况下投影层
 * （`utils/explorerTimeline.ts` 的 `buildExplorerTimeline`）在存在输入卡时就已经不产出这两行——
 * "问了什么、答了什么"由结构化输入卡自己承载。漏到这里说明没有对应的输入卡，
 * 而这两行只剩一句"有 1 个结构化问题在等"，既答不了也点不进去，不该以裸行出现。
 */
export const EXPLORER_DISPLAY_MODES: Record<ExplorerMessageType, ExplorerDisplayMode> = {
  USER_MESSAGE: "card",
  ASSISTANT_MESSAGE: "card",
  REASONING_SUMMARY: "reasoning",
  INPUT_REQUIRED: "hidden",
  INPUT_RESOLVED: "hidden",
  TOOL_STARTED: "tool",
  TOOL_COMPLETED: "tool",
  TOOL_DENIED: "tool",
  MCP_ACTIVITY: "tool",
  CONTEXT_COMPACTED: "divider",
  GATE_CHECKED: "gate",
  TURN_STATUS: "turn-status",
  "input-request": "card",
  "plan-created": "card",
  "candidate-plan": "card",
};

/** 这类消息该怎么呈现。视图只问它，不再自己判断"该不该显示、显示成什么样"。 */
export function explorerDisplayMode(type: ExplorerMessageType): ExplorerDisplayMode {
  return EXPLORER_DISPLAY_MODES[type];
}
