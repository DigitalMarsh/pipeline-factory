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
import type { ExplorerActivityItem, ExplorerActivityKind, ExplorerInputRequest, ExplorerThread } from "../types";
import { SHARED_MESSAGE_CLASSES, type MessageClass, type SharedMessageType } from "./conversationTypes";

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
  return (
    {
      OPEN: "等待回答",
      SUBMITTING: "提交中",
      ANSWERED: "已回答",
      CANCELLED: "已取消",
      RECOVERY_REQUIRED: "需要恢复",
    } as Record<ExplorerInputRequest["status"], string>
  )[request.status];
}

/** 条目状态文案。与执行线程的 `executionMessageStatusLabel` 同一套词。 */
export function activityStatusLabel(item: Pick<ExplorerActivityItem, "status">): string {
  return (
    {
      RUNNING: "进行中",
      COMPLETED: "已完成",
      FAILED: "失败",
      WAITING: "等待中",
      UNKNOWN: "状态未知",
    } as Record<ExplorerActivityItem["status"], string>
  )[item.status];
}

/**
 * 助手消息卡片上的状态标签。回合的 7 个状态在这里归成 **4 种观感**
 * （完整映射见 `docs/消息类型及事件状态机流程图.md` §1.3 A）。
 *
 * **`WAITING` 必须自己一档**：它对应"这条需求上已有回合在跑，这一条在排队"与"模型正等你回答"
 * 两种情形（见 `assistantActivityStatus`），把它们并进 `COMPLETED` 会让卡片在**还没开始跑**的
 * 时候就写「已完成」——而活动行（`activityStatusLabel`）一直有独立的「等待中」，两条线就此说两套话。
 */
export function assistantActivityLabel(item: Pick<ExplorerActivityItem, "status">): string {
  if (item.status === "RUNNING") return "进行中";
  if (item.status === "WAITING") return "等待中";
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
  COMMAND: "命令",
  FILE_CHANGE: "文件变更",
  TOOL_CALL: "工具调用",
  MCP_CALL: "MCP 调用",
  SUBAGENT: "子代理",
  WEB_SEARCH: "联网搜索",
  IMAGE_GENERATION: "生成图片",
  UNCLASSIFIED: "未识别",
  // 这三类不是模型说的话，是 **Factory 自己记的**（终止门禁、续跑检查点、模型轮次标记与调度占位）。
  // 行首那个点说的是"线程侧"，这三个词说的是"线程侧里的哪一边"——名字只在有歧义的地方出现，
  // 模型那一侧（正文 / 推理 / 调用）不点名，因为它就是这条线程本身。
  //
  // `CONTEXT` 曾写作「Factory · 上下文压缩」，**是错的**：那条步骤只是"一轮跑完、Factory 让接着做下一项"
  // 之前打的检查点，`messages` 只增不减，什么都没压。真被压缩只有 Provider 自己压那一种（④ 的
  // `PROVIDER_COMPACTION`，标签「上下文已压缩」）——两者一度被写成同一件事，用户看到"探索没聊几句却老在压缩"。
  CONTEXT: "Factory · 续跑检查点",
  GATE: "Factory · 执行门禁",
  TURN_STATUS: "Factory · 模型轮次",
  PROVIDER_MESSAGE: "消息回显",
  SESSION: "会话重建",
  // ④ 那几类的标签。它们不进时间线，用在自己的诊断区里。
  PROVIDER_COMPACTION: "上下文已压缩",
  PERMISSION_DENIED: "权限被拒",
  RATE_LIMIT: "配额",
  PROVIDER_RETRY: "自动重试",
  BACKGROUND_TASK: "后台子任务",
  HOOK: "钩子",
  PROVIDER_WARNING: "Provider 警告",
};

/** 工具类的七种：名字、身份、正文的摆法完全相同，只有标签不同。 */
const TOOL_LINE_KINDS: ReadonlySet<ExplorerActivityItem["kind"]> = new Set([
  "COMMAND",
  "FILE_CHANGE",
  "TOOL_CALL",
  "MCP_CALL",
  "SUBAGENT",
  "WEB_SEARCH",
  "IMAGE_GENERATION",
]);

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
    // 推理行是纯文本行：**有正文就摆正文，没有就什么也不编**——上面那行 meta 已经写着「推理」，
    // 正文留空就是"这一轮没有可说的"。曾经这里会退回标签顶上，于是行组件渲染出一个
    // `<details>`，点开只有重复的「推理」两个字——一个点开是空白的展开区比没有更糟。
    case "REASONING":
    case "TURN_STATUS":
    default:
      return { label, name: null, reference: null, body: item.summary };
  }
}

/**
 * 这条是不是 **Provider 报的活动**（而不是 Factory 自己的步骤标记）。
 *
 * 用来区分推理行为空的两种原因——这个区别对读的人是全部意义所在：
 *   - Provider 报了这次推理、但没给可读正文（Codex 的 `reasoning` item 只有 `encrypted_content`）
 *     → 该明说，否则那一行看着像"这一轮根本没推理"；
 *   - Factory 自己的 `MODEL_STARTED` 标记（"这一轮跑起来了"）→ 本来就没话可说，留空即可。
 */
export function isProviderControlled(item: ExplorerActivityItem): boolean {
  return item.details?.providerControlled === true;
}

/** `details` 里取一段非空文本；取不到就是 null。 */
function detailsText(item: ExplorerActivityItem, key: string): string | null {
  const value = item.details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
 * - `card`：完整卡片（方案 / 结构化输入）
 * - `text`：纯文本一行（你自己说的话——靠右、带 `›` 记号，不套卡片）
 * - `prose`：铺开的正文（模型的回复——左侧、带一行 meta，内嵌的方案卡照旧挂在这里面）
 * - `line`：调用行——命令 / 文件 / 工具 / MCP，交代"谁在跑、跑完没、是哪一次调用"（**与执行侧同名**）
 * - `reasoning`：推理行——背景音，最轻的一档，不该有卡片的重量
 * - `divider`：分隔行——续跑检查点是"这一轮跑完、Factory 让接着做下一项"的边界，是边界不是事件
 * - `gate`：判定行——门禁给出的是**结论**（拦截），不是过程
 * - `turn-status`：状态行——回合占位与未识别的活动，虚线框，比调用行更淡
 * - `hidden`：不渲染
 */
export type ExplorerDisplayMode = "card" | "text" | "prose" | "line" | "reasoning" | "divider" | "gate" | "turn-status" | "hidden";

/**
 * **消息类型 → 呈现方式。这张表就是"清单"本身。**
 *
 * 判据是每条消息对"看懂这次探索"的贡献：**人说的话与模型的回复都是铺开的正文**（`text` / `prose`——
 * 它们本来就是一段话，外面的白底边框不承载任何信息），方案与结构化输入是 `card`；
 * 七类调用按**语义**同归 `line`（标签与状态标签区分命令 / 文件 / 工具 / MCP / 子代理 / 搜索 / 生图），
 * 门禁是判定，回合状态是占位，推理是背景音，续跑检查点是分隔。
 *
 * **④「跑模型的程序报的」一律 `hidden`**：那是跑模型的那个程序在报自己的状态，不是模型或你的发言。它们的归宿是
 * 头部状态卡的「Provider 运行事实」一节（`explorerRuntimeFacts()`），与"不进会话正文"是同一条判据。
 * 唯一的例外是 `UNCLASSIFIED`——"Provider 给了我不认识的东西"这件事**必须当场可见**，
 * 否则新活动类型会静默消失（它是 ④ 里唯一露面的那个）。
 *
 * 注意 `INPUT_REQUIRED` / `INPUT_RESOLVED` **不在这张表里**：那两条生命周期行已经不产出条目
 * （见 `packages/domain/src/explorer/explorer-activity.ts` 的模块注释 3），
 * "问了什么、答了什么"由结构化输入卡自己承载。
 */
export const EXPLORER_DISPLAY_MODES: Record<ExplorerMessageType, ExplorerDisplayMode> = {
  // ① 你说的
  USER_MESSAGE: "text",
  // ② 模型说的
  ASSISTANT_MESSAGE: "prose",
  REASONING: "reasoning",
  // ③ 模型做的
  COMMAND: "line",
  FILE_CHANGE: "line",
  TOOL_CALL: "line",
  MCP_CALL: "line",
  SUBAGENT: "line",
  WEB_SEARCH: "line",
  IMAGE_GENERATION: "line",
  // ④ Provider 说的：不进正文（`UNCLASSIFIED` 例外，见上）
  PROVIDER_COMPACTION: "hidden",
  PERMISSION_DENIED: "hidden",
  RATE_LIMIT: "hidden",
  PROVIDER_RETRY: "hidden",
  BACKGROUND_TASK: "hidden",
  HOOK: "hidden",
  PROVIDER_WARNING: "hidden",
  UNCLASSIFIED: "turn-status",
  PROVIDER_MESSAGE: "hidden",
  SESSION: "hidden",
  // ⑤ Factory 说的
  CONTEXT: "divider",
  GATE: "gate",
  TURN_STATUS: "turn-status",
  // 投影与模板在别处产生的两类
  INPUT_REQUEST: "card",
  CANDIDATE_PLAN: "card",
};

/**
 * 探索侧的大类表：共用项直接取 `SHARED_MESSAGE_CLASSES`（**分类的唯一定义处**），
 * 这里只补探索侧独有的两项。两项都是"模型做的"——候选方案是模型产出的产物，
 * 输入卡是模型发起、需要你回话的动作。
 */
export const EXPLORER_MESSAGE_CLASSES: Record<ExplorerMessageType, MessageClass> = {
  ...SHARED_MESSAGE_CLASSES,
  INPUT_REQUEST: "action",
  CANDIDATE_PLAN: "action",
};

/**
 * **这三种行型共用一个行组件**（`ExplorerActivityRow`）：它们的 DOM 逐字相同——线程侧标记点 +
 * 标签 + 名字 + 时间 + 状态标签 + 正文 + 引用——差别**全在 CSS 类上**（`activity-line` 给名字加等宽底色、
 * `activity-gate` 加一道竖线、`activity-turn-status` 换成虚线框）。按行型写三份同构模板，
 * 与按消息类型写四份同构模板是同一个错误。
 */
export const EXPLORER_ROW_MODES = ["line", "gate", "turn-status"] as const;
export type ExplorerRowMode = (typeof EXPLORER_ROW_MODES)[number];

/** 剩下的取值各由自己的模板分支负责：`card`/`text`/`prose` 是块级内容，`reasoning`/`divider` 各有行型，`hidden` 不渲染。 */
export const EXPLORER_INLINE_MODES = ["card", "text", "prose", "reasoning", "divider", "hidden"] as const;

/**
 * 编译期护栏：上面两张清单合起来必须**正好**是 `ExplorerDisplayMode` 的全部取值。
 * 新增一种呈现方式却没归到任何一边时，下面这行编译不过——这正是"新增行型会静默渲染成裸卡"的堵口。
 */
const _modeCoverage: Record<Exclude<ExplorerDisplayMode, ExplorerRowMode | (typeof EXPLORER_INLINE_MODES)[number]>, true> = {};
void _modeCoverage;

/** 这类消息该怎么呈现。视图只问它，不再自己判断"该不该显示、显示成什么样"。 */
export function explorerDisplayMode(type: ExplorerMessageType): ExplorerDisplayMode {
  return EXPLORER_DISPLAY_MODES[type];
}

/** 这类消息属于哪一大类。见 `conversationTypes.ts` 的 `MessageClass`。 */
export function explorerMessageClass(type: ExplorerMessageType): MessageClass {
  return EXPLORER_MESSAGE_CLASSES[type];
}

/**
 * 这条调用的**结构化载荷**（参数、返回、输出、退出码、耗时）。
 *
 * 载荷由领域的 `structuredProviderPayload` 写进 `details`（见
 * `packages/domain/src/platform/provider-payload.ts`），这里只把它取出来给展开区用。
 * 取不到的键**不写**：`undefined` 是"Provider 没给"，空串是"Provider 说这里什么都没有"。
 */
export function explorerActivityResult(activity: ExplorerActivityItem): {
  arguments?: unknown;
  result?: unknown;
  output?: string | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
} {
  const details = activity.details ?? {};
  return {
    ...(details.arguments === undefined ? {} : { arguments: details.arguments }),
    ...(details.result === undefined ? {} : { result: details.result }),
    ...(typeof details.output === "string" ? { output: details.output } : {}),
    ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
    ...(typeof details.durationMs === "number" ? { durationMs: details.durationMs } : {}),
  };
}

/**
 * ④「跑模型的程序报的」里**没在时间线上露过面**的那些条目 —— 头部状态卡的「Provider 运行事实」一节读它。
 *
 * 判据是三条一起看：大类是 `provider`，呈现方式为 `hidden`，**且不是 `PROVIDER_MESSAGE`**。
 * 前两条自动排除 `UNCLASSIFIED`（它虽然是 ④，但已经作为一行「未识别」出现在时间线上，收进诊断区
 * 就成了同一个事实的第二份）；第三条排除"Provider 把你那句话回显一次"——那是纯回声，诊断价值为零。
 * 三条判据都来自既有的表，所以**新增一类 ④ 不需要回来改这里**。
 */
export function explorerRuntimeFacts(activities: readonly ExplorerActivityItem[]): ExplorerActivityItem[] {
  return activities.filter(
    (activity) =>
      EXPLORER_MESSAGE_CLASSES[activity.kind] === "provider" &&
      EXPLORER_DISPLAY_MODES[activity.kind] === "hidden" &&
      activity.kind !== "PROVIDER_MESSAGE",
  );
}

/**
 * 一条运行事实在列表里的标题。
 *
 * 为什么要有回退：Provider 常常只报"发生了一件事"而不给话——Codex 的 `contextCompaction`
 * item 没有任何文本。空标题在列表里就是一行空白，等于没说；退回中立类别的标签至少说清了是什么事。
 */
export function runtimeFactTitle(activity: ExplorerActivityItem): string {
  return activity.title.trim() || ACTIVITY_LABELS[activity.kind] || activity.kind;
}

/** 诊断区里那几类**需要立刻浮出来**的（额度、重试、权限被拒、告警）；其余 ④ 只在展开时看。 */
const RUNTIME_ALERT_KINDS: ReadonlySet<ExplorerActivityKind> = new Set([
  "RATE_LIMIT",
  "PROVIDER_RETRY",
  "PERMISSION_DENIED",
  "PROVIDER_WARNING",
]);

/** 这条运行事实要不要浮到用户眼前。与 `packages/domain/src/model/provider-activity.ts` 的 `isRuntimeAlertKind` 同义。 */
export function isRuntimeAlert(activity: ExplorerActivityItem): boolean {
  return RUNTIME_ALERT_KINDS.has(activity.kind) || activity.status === "FAILED";
}
