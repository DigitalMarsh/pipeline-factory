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
 *   5) **消息类型名与执行线程共用一份词表**（`conversationTypes.ts`），状态文案也与执行线程
 *      （`RunDetailView` 的 `executionMessageStatusLabel`）用同一套中文——同一种状态在两个对话框里
 *      必须是同一个词，否则用户要自己翻译一遍才知道它们是一回事。
 */
import type { ExplorerActivityItem, ExplorerInputRequest, ExplorerThread } from "../types";
import type { SharedMessageType } from "./conversationTypes";

/** 消息时间：只到分钟，中文环境。传入的一定是 ISO 时间串（调用点来自领域数据）。 */
export function formatTurnTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function explorerDisplayTitle(item: ExplorerThread | null): string {
  return item?.title || "探索线程";
}

/**
 * 输入请求的状态文案。`inFlightRequestId` 由调用方传组件自己的 `inputAnswerInFlight` ——
 * 只有请求 id 与它相等时才覆盖为"提交中"，因为此时**服务端状态还没变**（仍是 OPEN），
 * 界面必须靠本地在途标记抢先反映"已提交、等确认"。
 */
export function inputStatusLabel(request: Pick<ExplorerInputRequest, "id" | "status">, inFlightRequestId: string | null): string {
  if (inFlightRequestId === request.id) return "提交中";
  return ({
    OPEN: "等待回答",
    SUBMITTING: "提交中",
    ANSWERED: "已回答",
    CANCELLED: "已取消",
    RECOVERY_REQUIRED: "需要恢复",
  } as Record<ExplorerInputRequest["status"], string>)[request.status];
}

/** 条目状态文案。与执行线程的 `executionMessageStatusLabel` 同一套词。 */
export function activityStatusLabel(item: Pick<ExplorerActivityItem, "status">): string {
  return ({
    RUNNING: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    WAITING: "等待中",
    UNKNOWN: "状态未知",
  } as Record<ExplorerActivityItem["status"], string>)[item.status];
}

/**
 * 助手消息卡片上的状态标签。回合的 7 个状态在这里归成 3 种观感
 * （完整映射见 `docs/消息类型及事件状态机流程图.md` §1.3 A）。
 */
export function assistantActivityLabel(item: Pick<ExplorerActivityItem, "status">): string {
  if (item.status === "RUNNING") return "进行中";
  if (item.status === "FAILED") return "失败";
  return "已完成";
}

/**
 * 活动行要摆的字段。**视图只负责摆位置，"摆哪个字段"全部在这里决定**——这样"这一条到底显示什么"
 * 可以单测，也不必摊进模板里的一长串三元表达式。
 */
export type ExplorerActivityLine = {
  /** 行首标签：这一条是什么。 */
  label: string;
  /** 主标识：工具名、命令原文、文件路径、门禁动作。没有可说的就是 null，视图不留空位。 */
  name: string | null;
  /** 诊断尾巴：调用 id、上下文条数。同样可以是 null。 */
  reference: string | null;
  /** 正文：说清发生了什么。没有可说的就是空串——宁可少一行字，也不摆"工具返回了结果"这种占位句。 */
  body: string;
};

/** 过程活动的行首标签。`USER_MESSAGE` / `ASSISTANT_MESSAGE` 刻意不在表里——它们走消息行/卡片，不显示标签。 */
const ACTIVITY_LABELS: Partial<Record<ExplorerActivityItem["kind"], string>> = {
  REASONING: "推理",
  INPUT_REQUIRED: "需要输入",
  INPUT_RESOLVED: "输入已提交",
  COMMAND: "命令",
  FILE_CHANGE: "文件变更",
  TOOL_CALL: "工具调用",
  MCP_CALL: "MCP 调用",
  UNCLASSIFIED: "未识别",
  CONTEXT: "上下文压缩",
  GATE: "执行门禁",
  TURN_STATUS: "回合状态",
  PROVIDER_MESSAGE: "消息回显",
  SESSION: "会话重建",
};

/** 工具类的四种：名字、身份、正文的摆法完全相同，只有标签不同。 */
const TOOL_LINE_KINDS: ReadonlySet<ExplorerActivityItem["kind"]> = new Set(["COMMAND", "FILE_CHANGE", "TOOL_CALL", "MCP_CALL"]);

/** 主标识放不下整条命令，截断到可读长度。 */
function truncateLine(value: string): string | null {
  const single = value.replaceAll(/\s+/g, " ").trim();
  if (!single) return null;
  return single.length > 80 ? `${single.slice(0, 79)}…` : single;
}

/**
 * 各类过程活动各自摆什么。**未知 kind 回落为原字符串**（见模块头 3）：
 * 宁可显示 `TOOL_SOMETHING` 也不要留白——后端加了一种活动时，页面上一眼就能看出来。
 *
 * 取值上的三条取舍：
 * 1. 有身份的（工具名、命令原文、门禁动作）放 `name`，**不塞进标签**——标签回答"这是什么"，
 *    名字回答"是哪一个"，混在一起读起来是一句话，扫一眼分不出层次。
 * 2. 领域给的占位句（"The tool returned a result."）不摆——它没告诉读者任何事。
 * 3. **名字与正文只摆一次**：Provider 只在 `summary` 里给了内容时（命令原文、文件路径），
 *    它就是名字，正文留空；只有名字另外给出来时，`summary` 才是正文。
 */
export function explorerActivityLine(item: ExplorerActivityItem): ExplorerActivityLine {
  const label = ACTIVITY_LABELS[item.kind] ?? item.kind;
  const itemId = detailsText(item, "itemId");
  if (TOOL_LINE_KINDS.has(item.kind)) {
    const titled = item.title.trim();
    return {
      label,
      name: titled || truncateLine(item.summary),
      reference: detailsText(item, "callId") ?? itemId,
      // 有原因就先说原因（被拒、失败、结束状态没记录）；没有原因时，摘要才是正文。
      body: detailsText(item, "reason") ?? (titled ? item.summary : ""),
    };
  }
  switch (item.kind) {
    case "CONTEXT": {
      const count = item.details?.messageCount;
      return { label, name: null, reference: typeof count === "number" ? `${count} 条消息` : null, body: "" };
    }
  case "GATE":
      // 门禁的动作（blocked）是判定结论本身，比标签重要。
      return { label, name: detailsText(item, "action"), reference: null, body: item.summary };
    case "UNCLASSIFIED":
      // 认不出来就说认不出来：标签直接摆 Provider 的原生 itemType，不要给它编一个像样的类别名。
      return { label: detailsText(item, "itemType") ?? label, name: null, reference: itemId, body: item.summary };
    case "TURN_STATUS":
    case "REASONING":
    default:
      // 推理行是纯文本行，空着只剩一个点和时间，比补一句占位句更糟——退回标签顶上。
      return { label, name: null, reference: null, body: item.summary || (item.kind === "REASONING" ? label : "") };
  }
}

/** `details` 里取一段非空文本；取不到就是 null。 */
function detailsText(item: ExplorerActivityItem, key: string): string | null {
  const value = item.details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 行首图标只由状态决定：进行中是信息、完成是成功、失败与状态未知都值得看一眼。 */
export function activityIconKind(status: ExplorerActivityItem["status"]): "info" | "success" | "warning" {
  if (status === "FAILED" || status === "UNKNOWN") return "warning";
  if (status === "COMPLETED") return "success";
  return "info";
}

/**
 * 探索会话里的消息类型。**这张联合类型就是"消息清单"**——每一种在聊天框里怎么呈现，
 * 由下面 `EXPLORER_DISPLAY_MODES` 一张表决定；要调整呈现方式，改表即可，不用翻模板。
 *
 * 前 15 项直接取自 `ExplorerActivityItem["kind"]`（即领域侧的 `ExplorerActivityKind`），
 * **不是手抄一份**：后端新增一种活动时，`type-parity.test.ts` 先报两侧类型不一致，这里随即编译不过，
 * 逼着人来表里补一次"这类消息怎么显示"的决定。其中 13 项与执行线程共用（`SharedMessageType`）。
 * 后两项不是活动条目的 kind，由投影或模板在别处产生，**只有探索线程有**：
 * - `INPUT_REQUEST`：`ExplorerTimelineItem` 的 `input` 分支（结构化输入卡片，提问与回答共用一张卡）
 * - `CANDIDATE_PLAN`：助手消息**内嵌**的候选方案卡，不是独立时间线条目
 *
 * 曾经还有第三个非活动类型 `plan-created`（游离 Plan 的独立卡片）：它只在"方案没能绑到任何一条
 * 助手消息"时出现，而现代代码里每个 Plan 的标题与 `sourceTurnId` 都来自同一次协议解析，
 * 必然绑得上——全量数据实测 21/21 全部绑定。已删除，理由见 docs/消息类型及事件状态机流程图.md。
 */
export type ExplorerMessageType = ExplorerActivityItem["kind"] | "INPUT_REQUEST" | "CANDIDATE_PLAN";

/**
 * 上面这张清单里**与执行线程共用的**那些。`type-parity.test.ts` 断言它逐字等于
 * `SharedMessageType`——两边任何一个漏了共用项，编译期就红（见 conversationTypes.ts）。
 */
export type ExplorerSharedMessageType = Extract<ExplorerMessageType, SharedMessageType>;

/**
 * 呈现方式。**执行侧的 card / text / line / folded / hidden 是按"占多少地方"分的，探索侧按"是什么"分**——
 * 因为探索时间线是平铺的，没有"步骤"这一层可以折叠，密度分档区分不出"模型在思考"和"工具被拒绝"
 * 这两件事，而它们本来就该长得不一样：
 * - `card`：完整卡片（正文 / 方案 / 结构化输入）
 * - `text`：纯文本一行（你自己说的话——不套卡片，也不折叠）
 * - `tool`：调用行——命令 / 文件 / 工具 / MCP，交代"谁在跑、跑完没、是哪一次调用"
 * - `reasoning`：推理行——背景音，最轻的一档，不该有卡片的重量
 * - `divider`：分隔行——上下文压缩是会话在这里换了上下文，是边界不是事件
 * - `gate`：判定行——门禁给出的是**结论**（拦截），不是过程
 * - `turn-status`：状态行——回合占位与未识别的活动，虚线框，比调用行更淡
 * - `hidden`：不渲染
 */
export type ExplorerDisplayMode = "card" | "text" | "tool" | "reasoning" | "divider" | "gate" | "turn-status" | "hidden";

/**
 * **消息类型 → 呈现方式。这张表就是"清单"本身。**
 *
 * 判据是每条消息对"看懂这次探索"的贡献：人说的话、模型正文、方案与结构化输入是 `card`；
 * 四类调用按**语义**同归 `tool`（标签与图标区分命令 / 文件 / 工具 / MCP 与被拒 / 失败），
 * 门禁是判定，回合状态是占位，推理是背景音，上下文压缩是分隔。
 *
 * `PROVIDER_MESSAGE` / `SESSION` 标成 `hidden`：它们是"Provider 把你那句话回显一次"与
 * "Provider 会话重建"——内容在时间线上已经有了（用户消息本身、回合状态），
 * 但**名字留在共用词表里**，两边才不会各起一个（见 `conversationTypes.ts`）。
 *
 * `INPUT_REQUIRED` / `INPUT_RESOLVED` 标成 `hidden` 同理由：正常情况下投影层
 * （`utils/explorerTimeline.ts` 的 `buildExplorerTimeline`）在存在输入卡时就已经不产出这两行——
 * "问了什么、答了什么"由结构化输入卡自己承载。
 */
export const EXPLORER_DISPLAY_MODES: Record<ExplorerMessageType, ExplorerDisplayMode> = {
  USER_MESSAGE: "text",
  ASSISTANT_MESSAGE: "card",
  REASONING: "reasoning",
  INPUT_REQUIRED: "hidden",
  INPUT_RESOLVED: "hidden",
  COMMAND: "tool",
  FILE_CHANGE: "tool",
  TOOL_CALL: "tool",
  MCP_CALL: "tool",
  UNCLASSIFIED: "turn-status",
  CONTEXT: "divider",
  GATE: "gate",
  TURN_STATUS: "turn-status",
  PROVIDER_MESSAGE: "hidden",
  SESSION: "hidden",
  INPUT_REQUEST: "card",
  CANDIDATE_PLAN: "card",
};

/** 这类消息该怎么呈现。视图只问它，不再自己判断"该不该显示、显示成什么样"。 */
export function explorerDisplayMode(type: ExplorerMessageType): ExplorerDisplayMode {
  return EXPLORER_DISPLAY_MODES[type];
}
