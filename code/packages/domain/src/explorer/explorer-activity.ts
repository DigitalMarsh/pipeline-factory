/**
 * 模块职责：定义 Explorer 活动事件及其面向消息流的投影。
 *
 * 维护提示：
 *   1) **两套类型名其实是同一套。** 本文件的 `ExplorerActivityKind` 与执行侧的
 *      `ExecutionMessageType` 共用一份词表（`apps/web/src/utils/conversationTypes.ts`）：
 *      同一个概念两边同一个名字。新增一种活动时先回答"它是不是两边共用的"，
 *      共用就进 `SHARED_MESSAGE_TYPES`，只属于探索侧就只加在这里（如结构化输入那几种）。
 *   2) **一次工具调用只产出一条。** `TOOL_REQUESTED → TOOL_COMPLETED` 是一次调用的生命周期，
 *      不是两条消息：投影按身份键（Loop 步骤的 `callId` / Provider 活动的 `itemId`）把它们合成一条，
 *      后到的事件覆盖状态与正文——与执行侧 `projectExecutionJournal` 的合并规则是同一条。
 *      此前探索侧是两行，同一个工具会在时间线上占两行。
 *   3) **结构化输入不在这里成行**：`INPUT_REQUIRED` / `INPUT_RESOLVED` 两个步骤由 Loop 写下，
      但投影层**不把它们变成活动条目**——`agent-loop` 写下 `INPUT_REQUIRED` 的同一次调用里就 emit 了
      `agent.input.required`，`thread-service` 收到后立刻落一条 `input_requests` 行；也就是说
      只要这条步骤存在，同一需求里必然有那张结构化输入卡，而卡上提问、回答、状态俱全。
      两行各自只有一句"有 N 个问题在等" / "你的选择已提交"，属于被整张卡取代的东西。
（`model/provider-activity.ts` 的 `codexActivityKind` /
 *      `claudeActivityKind` / `activityOutcome`），不要退回 `itemType.includes(...)` 那种现猜：
 *      `userMessage`（Provider 把你那句话回显一次）与 `plan`（整篇规划文档）都曾被猜成工具行。
 *   4) **回合结束后仍没有结束事件的调用标成 `UNKNOWN`**，不要一直显示"进行中"。
 *      执行侧早有同一条规则（`projectExecutionJournal` 里 threadState !== ACTIVE 的那一段）。
 */
import type { AgentLoop, AgentLoopStep } from "../agent/agent-loop.js";
import type { ExplorerTurn } from "../index.js";
import { isRecord } from "../platform/guards.js";
import { structuredProviderPayload } from "../platform/provider-payload.js";
import { stripPlanProtocol } from "../plan/completion.js";
import {
  activityOutcome,
  claudeActivityKind,
  codexActivityKind,
  isProviderActivityKind,
  isProviderActivityOutcome,
  type ProviderActivityKind,
  type ProviderActivityOutcome,
} from "../model/provider-activity.js";

/**
 * Explorer 时间线中的消息、工具、Plan 和状态事件类型。与执行侧共用其中大部分（见模块头 1）。
 *
 * 顺序按**五类**排（见 `docs/Provider消息格式与消息大类调研.md`）：
 * ① 你说的 → ② 模型说的 → ③ 模型做的 → ④ Provider 说的 → ⑤ Factory 说的。
 * ④ 那一组**不进会话正文**（呈现表里是 `hidden`），它们的归宿是头部状态卡的
 * 「Provider 运行事实」一节——`explorerRuntimeFacts()` 挑的就是这几个。
 */
export type ExplorerActivityKind =
  // ①
  | "USER_MESSAGE"
  // ②
  | "ASSISTANT_MESSAGE"
  | "REASONING"
  // ③
  | "COMMAND"
  | "FILE_CHANGE"
  | "TOOL_CALL"
  | "MCP_CALL"
  | "SUBAGENT"
  | "WEB_SEARCH"
  | "IMAGE_GENERATION"
  // ④
  | "PROVIDER_COMPACTION"
  | "PERMISSION_DENIED"
  | "RATE_LIMIT"
  | "PROVIDER_RETRY"
  | "BACKGROUND_TASK"
  | "HOOK"
  | "PROVIDER_WARNING"
  | "UNCLASSIFIED"
  | "PROVIDER_MESSAGE"
  | "SESSION"
  // ⑤
  | "CONTEXT"
  | "GATE"
  | "TURN_STATUS";

/** 前端可直接渲染的 Explorer 活动项，保留来源事实以支持定位。 */
export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  explorerPlanId?: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING" | "UNKNOWN";
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
};

/** 将数据库 Turn、Loop Step 和 Provider activity 投影为时间线的输入。 */
export type ExplorerActivityInput = {
  turns: readonly ExplorerTurn[];
  loops: readonly AgentLoop[];
  steps: readonly AgentLoopStep[];
};

type ActivityWithOrder = ExplorerActivityItem & { order: number };

/** 一次工具调用的条目形态；`id` / `sequence` / `order` 由 `append` / 合并逻辑补。 */
type ToolActivity = Omit<ExplorerActivityItem, "id" | "sequence">;

/** 每条活动都有的来源字段。`activityFromStep` 先摊它，再补 `kind` / `status` / `title` / `summary`。 */
type ActivitySource = Pick<ExplorerActivityItem, "explorerId" | "turnId" | "occurredAt"> & { explorerPlanId?: string };

type PlanActivityDisplay = {
  summary: string;
  details: Record<string, unknown> | null;
};

const STATUS_TAG = /<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/gi;
const PLAN_TAG = /<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/gi;
const STATUS_OPEN_TAG = /<pipeline-factory-plan-status>/i;
const PLAN_OPEN_TAG = /<pipeline-factory-plan>/i;

/**
 * 中立类别 → 探索侧的条目类型。**一张表说清"Provider 报的这件事在时间线上是哪一类"**，
 * 不再逐个 `itemType.includes(...)` 现猜（那正是 userMessage / plan 被渲染成工具行的成因）。
 *
 * 它必须是**穷尽**的 `Record<ProviderActivityKind, …>`：中立词表加一类而这里没跟上，
 * 编译先红——这正是"新增一类 Provider 活动会静默显示成未识别"的堵口。
 */
const KIND_BY_ACTIVITY: Record<ProviderActivityKind, ExplorerActivityKind> = {
  // ② 内容流
  reasoning: "REASONING",
  message: "PROVIDER_MESSAGE",
  // ③ 动作
  command: "COMMAND",
  "file-change": "FILE_CHANGE",
  tool: "TOOL_CALL",
  mcp: "MCP_CALL",
  subagent: "SUBAGENT",
  search: "WEB_SEARCH",
  media: "IMAGE_GENERATION",
  // ④ 运行事实（不进会话正文）
  compaction: "PROVIDER_COMPACTION",
  permission: "PERMISSION_DENIED",
  "rate-limit": "RATE_LIMIT",
  retry: "PROVIDER_RETRY",
  task: "BACKGROUND_TASK",
  hook: "HOOK",
  warning: "PROVIDER_WARNING",
  session: "SESSION",
  review: "PROVIDER_MESSAGE",
  other: "UNCLASSIFIED",
};

/**
 * ④「Provider 说的」运行事实在探索侧的条目类型。头部状态卡按这一组挑数据，
 * **不各自列白名单**——中立词表里 `isRuntimeKind()` 是那条判据的唯一定义处。
 */
export const EXPLORER_RUNTIME_KINDS: ReadonlySet<ExplorerActivityKind> = new Set([
  "PROVIDER_COMPACTION", "PERMISSION_DENIED", "RATE_LIMIT", "PROVIDER_RETRY",
  "BACKGROUND_TASK", "HOOK", "PROVIDER_WARNING", "SESSION",
]);

/** 工具类条目：它们按身份键合成一条，且正文/名字的摆法相同。 */
const TOOL_KINDS: ReadonlySet<ExplorerActivityKind> = new Set(["COMMAND", "FILE_CHANGE", "TOOL_CALL", "MCP_CALL", "SUBAGENT", "WEB_SEARCH", "IMAGE_GENERATION"]);

/**
 * 需要按身份键合并的类别 = 任何**有身份**的条目：工具类，加上推理、Provider 回声与未识别项，
 * 以及 ④ 里那些**有开始也有结束**的运行事实（钩子、子任务）。
 * 判据是身份本身，不是类别清单——`itemId` / `callId` 就是"这是同一个活动"的定义，
 * 条目的类别只决定它长什么样（见模块头 2）。
 */
const MERGED_KINDS: ReadonlySet<ExplorerActivityKind> = new Set([...TOOL_KINDS, "REASONING", "PROVIDER_MESSAGE", "SESSION", "UNCLASSIFIED", "HOOK", "BACKGROUND_TASK"]);

function countArray(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.length : undefined;
}

function stringAt(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 这一动作的**结构化载荷**：工具参数、工具返回、命令输出、退出码、耗时。
 * 它们此前一个都没进业务层，于是"这条命令到底跑了什么、结果是什么"在界面上没有原料。
 * 上限与取值规则在 `platform/provider-payload.ts`——执行侧读同一份数据，
 * 两处各写一份规则，同一个动作就会在两个对话框里显示得不一样。
 */
function structuredDetails(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredProviderPayload(payload);
}

/** 非空字符串才算有值：空串在呈现层表示"没有可说的"，不能当名字。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatPlanActivity(content: string, providerItemId: string | null = null): PlanActivityDisplay {
  const withProviderItem = (details: Record<string, unknown> | null): Record<string, unknown> | null => providerItemId ? { ...(details ?? {}), providerItemId } : details;
  const hasProtocol = STATUS_OPEN_TAG.test(content) || PLAN_OPEN_TAG.test(content);
  if (!hasProtocol) return { summary: content, details: withProviderItem(null) };

  const prose = stripPlanProtocol(content);
  const candidates = planProtocolCandidates(content);
  const displayable = [...candidates].reverse().find((candidate) => candidate.status === "READY" && parsePlanArtifact(candidate.artifactText));
  const latest = candidates.at(-1);
  if (displayable) {
    const parsed = parsePlanArtifact(displayable.artifactText)!;
    return {
      summary: [prose, `完整执行方案已生成：${parsed.title}`].filter(Boolean).join(" "),
      details: withProviderItem({ planProtocol: true, status: "READY", ...parsed }),
    };
  }
  if (latest?.status !== "READY" || !latest.artifactText) {
    return { summary: [prose, "正在整理结构化计划…"].filter(Boolean).join(" "), details: withProviderItem({ planProtocol: true, status: "GENERATING" }) };
  }

  return { summary: [prose, "结构化计划校验失败，请继续完善。"].filter(Boolean).join(" "), details: withProviderItem({ planProtocol: true, status: "INVALID" }) };
}

function planProtocolCandidates(content: string): Array<{ status: string; artifactText: string }> {
  const statusMatches = [...content.matchAll(STATUS_TAG)];
  const planMatches = [...content.matchAll(PLAN_TAG)];
  return statusMatches.flatMap((statusMatch, index) => {
    const statusEnd = (statusMatch.index ?? 0) + statusMatch[0].length;
    const nextStatusStart = statusMatches[index + 1]?.index ?? content.length;
    const plan = planMatches.find((candidate) => (candidate.index ?? -1) >= statusEnd && (candidate.index ?? content.length) < nextStatusStart);
    return plan?.[1] && typeof statusMatch[1] === "string" ? [{ status: statusMatch[1].trim().toUpperCase(), artifactText: plan[1] }] : [];
  });
}

function parsePlanArtifact(artifactText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(artifactText);
    return isRecord(parsed) ? summarizePlanArtifact(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * 从 Plan 契约里取界面要的摘要。**只认当前形状**：`objective.goal` / `scope.includePaths` /
 * `scope.excludePaths` / `objective.acceptanceCriteria` / `verification.commandIds`。
 *
 * 曾经还要认 V1 的扁平形状（顶层 `goal` / `include` / …）。V1 已经不再支持——两条路都删了，
 * 剩下的判定与 `assessPlanArtifact` 一致：认不出来就报"校验失败"，让模型重出一份。
 *
 * **这份实现与 `apps/web/src/utils/planProtocolDisplay.ts` 是一对镜像**，不是重复代码：
 * web 不能运行时依赖领域层（会把整个领域打进浏览器包），所以它必须自己解析一遍**流式**消息
 * （活动摘要要等回合结束才落库）。两边的判定必须一致，
 * `apps/web/src/utils/planProtocolDisplay.parity.test.ts` 用同一批夹具断言它们结论相同；
 * 改这里就要同步改那边，否则测试会红。
 */
function summarizePlanArtifact(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const objective = isRecord(parsed.objective) ? parsed.objective : undefined;
  const scope = isRecord(parsed.scope) ? parsed.scope : undefined;
  const verification = isRecord(parsed.verification) ? parsed.verification : undefined;

  const title = stringAt(parsed, "title");
  const goal = stringAt(objective, "goal");
  // 用 undefined 判空（而不是真值判断）：空字符串在旧实现里算合法，这里不改那条语义。
  if (title === undefined || goal === undefined) return null;

  return {
    title,
    goal,
    includeCount: countArray(scope ?? {}, "includePaths") ?? 0,
    excludeCount: countArray(scope ?? {}, "excludePaths") ?? 0,
    acceptanceCount: countArray(objective ?? {}, "acceptanceCriteria") ?? 0,
    verificationCount: countArray(verification ?? {}, "commandIds") ?? 0,
    taskCount: countArray(parsed, "tasks") ?? 0,
  };
}

/** 把 Turn、Loop Step 和 Provider activity 合并为稳定排序的 Explorer 消息流。 */
export function projectExplorerActivity(input: ExplorerActivityInput): ExplorerActivityItem[] {
  const loopByOwner = new Map(input.loops.map((loop) => [loop.ownerId, loop]));
  const result: ActivityWithOrder[] = [];
  let order = 0;
  const append = (item: Omit<ExplorerActivityItem, "id" | "sequence">, stableSequence: number): ActivityWithOrder => {
    const appended: ActivityWithOrder = { ...item, id: `activity-${item.turnId}-${stableSequence}-${result.length}`, sequence: result.length + 1, order: order++ };
    result.push(appended);
    return appended;
  };

  // Turn 是对话主序列，Loop Step 只补充模型推理、工具和门禁活动；最终序号按发生时间重新归一化。
  for (const turn of [...input.turns].sort((a, b) => a.sequence - b.sequence)) {
    if (turn.role === "user") {
      append({ explorerId: turn.threadId, ...(turn.explorerPlanId ? { explorerPlanId: turn.explorerPlanId } : {}), turnId: turn.id, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: turn.content, details: null, occurredAt: turn.createdAt }, turn.sequence);
      continue;
    }

    const loop = loopByOwner.get(turn.id);
    const steps = input.steps.filter((step) => step.loopId === loop?.id).sort((a, b) => a.sequence - b.sequence);
    // 本回合已经产出的工具类条目，按身份键索引：一次调用的开始与结束落到同一条上（见模块头 2）。
    const toolItems = new Map<string, ActivityWithOrder>();
    /**
     * 当前还开着的助手气泡。**边界是"中间夹了任何别的步骤"，不是"上一条产出的是什么"**——
     * 写成后者时，"不产出条目的步骤"（被丢掉的门禁与非 0 级回声）会变成看不见的接缝，
     * 两段本该分开的正文会被粘成一条，与写侧封段的边界不再一致（见 §7.1 的等价性要求）。
     */
    let openAssistant: ActivityWithOrder | null = null;
    let assistantText = "";
    let assistantSequence = turn.sequence;
    for (const step of steps) {
      const payload = step.payload;
      if (step.stepType === "MODEL_TEXT_DELTA") {
        const text = typeof payload.text === "string" ? payload.text : "";
        const providerItemId = typeof payload.providerItemId === "string" ? payload.providerItemId : null;
        assistantText += text;
        assistantSequence = step.sequence;
        if (openAssistant) {
          openAssistant.summary += text;
          if (providerItemId) openAssistant.details = { ...(openAssistant.details ?? {}), providerItemId };
          continue;
        }
        openAssistant = append({ explorerId: turn.threadId, ...(turn.explorerPlanId ? { explorerPlanId: turn.explorerPlanId } : {}), turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: assistantActivityStatus(turn.status), title: "Plan Explorer", summary: text, details: providerItemId ? { providerItemId } : null, occurredAt: step.occurredAt }, step.sequence);
        continue;
      }
      openAssistant = null;
      const activity = activityFromStep(turn, step);
      if (!activity) continue;
      const identity = MERGED_KINDS.has(activity.kind) ? toolIdentity(activity) : null;
      const previous = identity ? toolItems.get(identity) : undefined;
      if (previous) {
        mergeToolActivity(previous, activity);
        continue;
      }
      const appended = append(activity, step.sequence);
      if (identity) toolItems.set(identity, appended);
    }
    if (!turnIsRunning(turn.status)) closeDanglingCalls(toolItems.values());
    for (const item of result) {
      if (item.turnId !== turn.id || item.kind !== "ASSISTANT_MESSAGE") continue;
      const providerItemId = typeof item.details?.providerItemId === "string" ? item.details.providerItemId : null;
      const display = formatPlanActivity(item.summary, providerItemId);
      item.summary = display.summary;
      item.details = display.details;
    }
    if (!assistantText && turn.content.trim()) {
      const display = formatPlanActivity(turn.content);
      append({ explorerId: turn.threadId, ...(turn.explorerPlanId ? { explorerPlanId: turn.explorerPlanId } : {}), turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : "COMPLETED", title: "Plan Explorer", summary: display.summary, details: turn.error ? { error: turn.error, ...(display.details ?? {}) } : display.details, occurredAt: turn.createdAt }, assistantSequence);
    }
    if (!steps.length && !turn.content.trim()) {
      append({ explorerId: turn.threadId, ...(turn.explorerPlanId ? { explorerPlanId: turn.explorerPlanId } : {}), turnId: turn.id, kind: "TURN_STATUS", status: turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED" ? "WAITING" : turn.status === "FAILED" ? "FAILED" : "RUNNING", title: "Plan Explorer", summary: turn.status === "WAITING_FOR_INPUT" ? "等待输入" : turn.status === "QUEUED" ? "已排队，等待 worker 接手" : "Plan Explorer 正在处理", details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt }, turn.sequence);
    }
  }

  return result
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.order - b.order)
    .map(({ order: _order, ...item }, index) => ({ ...item, sequence: index + 1 }));
}

/** 这次调用的身份：Loop 步骤给 `callId`，Provider 活动给 `itemId`。没有身份就合并不了（各自成行）。 */
function toolIdentity(activity: ToolActivity): string | null {
  return nonEmptyString(activity.details?.callId) ?? nonEmptyString(activity.details?.itemId) ?? null;
}

/**
 * 把一次调用的结束事件并进它开始的那条。
 * 名字只有开始那一条才有（结束事件里没有工具名），所以**先到的名字留住**；
 * 正文相反——被拒/失败的原因在结束那一条上，**后到的正文覆盖**。
 * 状态按执行侧同一条规则：结束态覆盖运行态，运行态不覆盖结束态。
 */
function mergeToolActivity(previous: ToolActivity, next: ToolActivity): void {
  if (!previous.title && next.title) previous.title = next.title;
  if (next.summary) previous.summary = next.summary;
  previous.details = { ...(previous.details ?? {}), ...(next.details ?? {}) };
  if (next.status !== "RUNNING" || previous.status === "RUNNING") previous.status = next.status;
}

/** 回合是否还在跑。不在了就说明"没等到结束事件"这件事已经定型，该如实标注（见模块头 4）。 */
function turnIsRunning(status: ExplorerTurn["status"]): boolean {
  return status === "RUNNING" || status === "QUEUED" || status === "WAITING_FOR_INPUT" || status === "PAUSED" || status === undefined;
}

/** 收尾时把仍在"进行中"的条目如实收掉——不是失败，是"没记录到它是怎么结束的"。 */
function closeDanglingCalls(items: Iterable<ActivityWithOrder>): void {
  for (const item of items) {
    if (item.status !== "RUNNING") continue;
    // 推理流没有成败概念：它随回合结束而结束，标成"状态未知"是把它不存在的成败编出来。
    if (item.kind === "REASONING") {
      item.status = "COMPLETED";
      continue;
    }
    item.status = "UNKNOWN";
    // 补的是"这条为什么是状态未知"，所以它落在 reason 上（呈现层的正文），不是 summary
    // ——summary 在呈现层是"没别的可说了就把我当名字用"的位置。
    item.details = { ...(item.details ?? {}), reason: nonEmptyString(item.details?.reason) ?? "未记录调用的结束状态。" };
  }
}

function assistantActivityStatus(status: ExplorerTurn["status"]): ExplorerActivityItem["status"] {
  if (status === "FAILED") return "FAILED";
  if (status === "WAITING_FOR_INPUT" || status === "QUEUED") return "WAITING";
  if (status === "COMPLETED" || status === "CANCELLED") return "COMPLETED";
  return "RUNNING";
}

/** 中立成败 → 条目状态。没有成败概念的类别（推理流）按阶段回落，不编一个成败出来。 */
function statusFromOutcome(outcome: ProviderActivityOutcome, phase: "started" | "completed"): ExplorerActivityItem["status"] {
  if (outcome === "not-applicable") return phase === "completed" ? "COMPLETED" : "RUNNING";
  if (outcome === "running") return "RUNNING";
  if (outcome === "succeeded") return "COMPLETED";
  if (outcome === "failed") return "FAILED";
  return "UNKNOWN";
}

/**
 * 这条 Provider 活动该显示成什么状态。
 *
 * 中立词表落地**之前**写入的行只有 `phase` 一个信号（那批行占多数）。对它们按 phase 作答——
 * Provider 说了"结束了"就记"已完成"，不要替它编一句"状态未知"出来；替它编出来的疑问，
 * Provider 从来没表达过。带 `outcome`（或带 `status` / `error` 这两条成败证据）之后一律按中立成败判，
 * 与执行侧 `projectExecutionJournal` 同一条规则。
 */
function providerStatusFor(payload: Record<string, unknown>, kind: ProviderActivityKind, phase: "started" | "completed"): ExplorerActivityItem["status"] {
  const status = nonEmptyString(payload.providerStatus);
  const error = nonEmptyString(payload.error);
  if (isProviderActivityOutcome(payload.outcome)) return statusFromOutcome(payload.outcome, phase);
  if (status || error) return statusFromOutcome(activityOutcome({ kind, phase, status, error }), phase);
  return phase === "completed" ? "COMPLETED" : "RUNNING";
}

/** 老行没有 `activityKind`：按 Provider 原生词表兜底，与执行侧 `legacyActivityKind` 同一套词表。 */
function readActivityKind(value: unknown, itemType: string, toolName: string | undefined): ProviderActivityKind {
  if (isProviderActivityKind(value)) return value;
  // 两个 Provider 的兜底规则不同：Codex 只看 itemType，Claude 还要看工具名（Bash → command）。
  return toolName ? claudeActivityKind(itemType, toolName) : codexActivityKind(itemType);
}

function activityFromStep(turn: ExplorerTurn, step: AgentLoopStep): Omit<ExplorerActivityItem, "id" | "sequence"> | null {
  const payload = step.payload;
  const base: ActivitySource = { explorerId: turn.threadId, ...(turn.explorerPlanId ? { explorerPlanId: turn.explorerPlanId } : {}), turnId: turn.id, occurredAt: step.occurredAt };
  if (step.stepType === "PROVIDER_ACTIVITY") {
    const itemType = nonEmptyString(payload.itemType) ?? "provider-item";
    const phase = payload.phase === "completed" ? "completed" : "started";
    const toolName = nonEmptyString(payload.toolName);
    const activityKind = readActivityKind(payload.activityKind, itemType, toolName);
    const status = providerStatusFor(payload, activityKind, phase);
    const reason = nonEmptyString(payload.error);
    // 名字只有一个来源：Provider 给的 title，其次工具名（带 Server 前缀），其次空串——
    // 空的时候由呈现层把 summary 顶上（命令原文、文件路径都是"在跑什么"）。
    const serverName = nonEmptyString(payload.serverName);
    const title = nonEmptyString(payload.title) ?? (toolName ? `${serverName ? `${serverName}/` : ""}${toolName}` : serverName ?? "");
    // Provider 没给摘要就**交空串**，不要补 "Provider activity started." 这类句子：那两句话把
    // 「有没有摘要」这个可判定的事实，变成了一句要靠字符串识别才能认出的文案，而它本身什么都没说。
    //
    // **推理正文的上限比别的大**：命令原文、文件路径这类摘要本来就短（240 够），而一段推理
    // 动辄一两千字——240 只够看个开头，而"我要看它到底想了什么"恰恰是推理行的全部用途。
    // 2000 与展示边界那一档同值（`apps/web/src/utils/sensitiveValue.ts`）。
    const summary = (nonEmptyString(payload.summary) ?? "").slice(0, activityKind === "reasoning" ? 2_000 : 240);
    const itemId = nonEmptyString(payload.itemId) ?? nonEmptyString(payload.providerItemId);
    return { ...base, kind: KIND_BY_ACTIVITY[activityKind], status, title, summary, details: { itemId: itemId ?? null, itemType, providerControlled: true, ...structuredDetails(payload), ...(toolName ? { toolName } : {}), ...(serverName ? { serverName } : {}), ...(reason ? { reason } : {}) } };
  }
  // 轮次开始只是一条"这一轮跑起来了"的标记，正文留空——呈现层会退回行首标签（"推理"），
  // 比摆一句 `Plan Explorer started step 3.` 更少噪音，也不必为它想一句中文。
  if (step.stepType === "MODEL_STARTED") return { ...base, kind: "REASONING", status: "RUNNING", title: "", summary: "", details: { step: payload.step ?? step.sequence } };
  if (step.stepType === "TOOL_REQUESTED") return toolStep(base, "RUNNING", nonEmptyString(payload.tool), step.callId, null);
  // 一次调用的四种结束：正常完成、被策略拒绝、执行失败、需要人工对账。
  // 后两种此前**连一行都没有**（这里没有分支，静默掉了）——"工具失败了"在时间线上看不见。
  if (step.stepType === "TOOL_COMPLETED") return toolStep(base, "COMPLETED", null, step.callId, nonEmptyString(payload.reason));
  if (step.stepType === "TOOL_FAILED" || step.stepType === "TOOL_NEEDS_RECONCILIATION" || step.stepType === "TOOL_DENIED") return toolStep(base, "FAILED", null, step.callId, nonEmptyString(payload.reason));
  if (step.stepType === "CONTEXT_COMPACTED") return { ...base, kind: "CONTEXT", status: "COMPLETED", title: "Context checkpointed", summary: "The loop saved a checkpoint before continuing.", details: { messageCount: payload.messageCount ?? null } };
  // 门禁只在**拦截**时成行：实测本机库 90 条判定里 complete 51 / continue 39 / blocked 0——
  // 每轮都写一行"一切正常"是刷屏，而"这一轮为什么停下"已经由回合状态本身说清了。
  if (step.stepType === "GATE_CHECKED") return payload.action === "blocked"
    ? { ...base, kind: "GATE", status: "FAILED", title: "Gate checked", summary: nonEmptyString(payload.reason) ?? "The termination gate blocked this step.", details: { action: payload.action ?? null } }
    : null;
  // 同轮次开始：状态标签已经说了"已完成"，不再补一句 `The model step completed.` 的机械话。
  if (step.stepType === "MODEL_COMPLETED") return { ...base, kind: "TURN_STATUS", status: "COMPLETED", title: "", summary: "", details: { step: payload.step ?? step.sequence } };
  return null;
}

/**
 * 一次调用的开始或结束。名字与原因各归一处：**名字（工具名）只有开始那一条有**，
 * **原因只有结束那一条有**——合并时前者留住、后者覆盖（见 mergeToolActivity）。
 * 两者都放 `details` 而不是 `summary`：`summary` 在呈现层是"没别的可说了就把我当名字用"的位置，
 * 把一句失败原因放进去，一次没有开始记录的调用就会被读成叫这个名字。
 */
function toolStep(base: ActivitySource, status: ExplorerActivityItem["status"], tool: string | null | undefined, callId: string | null, reason: string | null | undefined): Omit<ExplorerActivityItem, "id" | "sequence"> {
  return {
    ...base,
    kind: "TOOL_CALL",
    status,
    title: tool ?? "",
    summary: "",
    details: { ...(callId ? { callId } : {}), ...(tool ? { tool } : {}), ...(reason ? { reason } : {}) },
  };
}
