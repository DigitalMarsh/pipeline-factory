/**
 * 模块职责：把 ExecutionThread journal 投影成按 Plan 任务组织的执行会话。
 *
 * 维护提示：**边界是"脱敏 + 截断"，不是"不许显示"**。工具参数、命令输出与工具返回都可以展示，
 *   但一律先过 `utils/sensitiveValue.ts`（脱敏 + 2000 字截断）**在展示边界**——落库与投影都保留原样，
 *   因为同一份数据还要给排障与审计读。曾经这里写的是"不得输出工具参数、成功结果或模型私有思维链"，
 *   结果是 OpenClaw / Hermes 那种"展开看结果"做不出来。**模型的私有思维链（`thinking` 的原文）
 *   仍然不展示**——展示的是 Provider 自己给的推理摘要。
 */
import type { ExecutionJournalPayload, ModelMessagePhase, PlanTask } from "../types";
import { SHARED_MESSAGE_CLASSES, type MessageClass, type SharedMessageType } from "./conversationTypes";

export type ExecutionJournalEntry = {
  sequence: number;
  type: string;
  occurredAt: string;
  payload: ExecutionJournalPayload;
};

export type ExecutionPlanSnapshot = {
  planId: string;
  revision: number;
  occurredAt: string;
  goal: string;
  acceptanceCriteria: string[];
  includePaths: string[];
  excludePaths: string[];
  tasks: PlanTask[];
  verificationCommandIds: string[];
};

export type ExecutionStreamItem = {
  id: string;
  kind: "plan" | "model" | "user" | "divider" | "reasoning" | "activity" | "tool";
  role: "assistant" | "user" | "system";
  title: string;
  content: string;
  detail: string;
  status: "RUNNING" | "COMPLETED" | "WAITING" | "FAILED" | "INFO" | "UNKNOWN";
  occurredAt: string;
  sequence: number;
  taskId?: string | undefined;
  modelStep?: number | undefined;
  loopId?: string | undefined;
  providerThreadId?: string | undefined;
  providerTurnId?: string | undefined;
  providerItemId?: string | undefined;
  callId?: string | undefined;
  source?: "provider" | "factory" | "unknown" | undefined;
  serverName?: string | undefined;
  unrecordedFields?: string[] | undefined;
  repetitionCount?: number;
  /** Provider 活动的中立类别与成败（见下方 ACTIVITY_KIND_LABELS 的说明）；非 Provider 活动条目为空。 */
  activityKind?: ProviderActivityKind | undefined;
  outcome?: ProviderActivityOutcome | undefined;
  /**
   * 这一段正文是**过程叙述**还是**最终回答**（Codex 的 `agentMessage.phase`）。
   * 只有 Codex 给，Claude 不给 → 留空，`executionMessageWeight` 按"结论"处理，不把判不准的正文折起来。
   */
  phase?: ModelMessagePhase | undefined;
  /**
   * 这一动作的**结构化载荷**：工具参数、返回、命令输出、退出码、耗时。
   * 展示前一律过 `utils/sensitiveValue.ts`（脱敏 + 截断）——**落库与传输都保留原样**，
   * 因为同一份数据还要给排障与审计读。
   */
  arguments?: unknown;
  result?: unknown;
  output?: string | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  /** 这条消息属于哪一类（见 EXECUTION_MESSAGE_WEIGHTS）。权重只由它决定。 */
  messageType: ExecutionMessageType;
  /**
   * 这一条属于**补充要求起的那一轮**（`USER_GUIDANCE` → 新起的一轮 Loop）。
   *
   * 它**不属于任何计划任务**：分组时单独成组、折进自己的壳里，而不是挂在某个步骤下面。
   * `taskId` 对这一类条目一律为空——那是它与普通条目的唯一区别。
   */
  continuation?: boolean | undefined;
  /**
   * 那一轮是第几轮补充（从 1 数）。**一轮一组**：两轮补充合成一组的话，组头只能写其中一句话，
   * 另一轮的正文就没了标题（实测：第二轮那句只能当组里的一行看）。
   */
  continuationRound?: number | undefined;
  /** 这句补充要求是怎么投的。只有 `QUEUE` 算"起了一轮"，`STEER` 是插进正在跑的那一轮里的。 */
  guidanceDelivery?: "STEER" | "QUEUE" | undefined;
  plan?: ExecutionPlanSnapshot;
};

/**
 * 执行会话里的消息类型。**这张联合类型就是"消息清单"**——每一种在聊天框里怎么呈现，
 * 由下面 `EXECUTION_DISPLAY_MODES` 一张表决定；要调整呈现方式，改表即可，不用翻模板。
 *
 * **与探索线程共用其中大部分名字**（见 `conversationTypes.ts`）：同一个概念在两条对话线上
 * 必须同一个名字，否则"两边到底一不一致"只能靠人肉对照。只有执行侧才有的那几种在下面单独标注。
 *
 * 为什么把它显式化：此前呈现方式是散在投影与模板里的——有的按 `kind` 分支、有的按 `outcome` 猜、
 * 有的靠标题字符串相等（`title === "Executor report"`）。于是"这类消息要不要显示、显示成什么样"
 * 没有一个地方能一眼看全，改一处就会漏另一处。
 */
export type ExecutionMessageType =
  /** 冻结方案的摘要（每个 Run 一条）——**只有执行侧有**：探索侧的是还没确认的候选方案 */
  | "PLAN"
  /** Executor 的结构化完成报告（完成了哪几步、改了哪些文件）——**只有执行侧有**：执行报告协议 */
  | "MODEL_REPORT"
  /** 任务开始 / 完成 / 阻塞 ——**只有执行侧有**：Plan 任务这一层 */
  | "TASK_LIFECYCLE"
  /** Run 级事件：创建、生命周期钩子、验证（当前承载在顶部 RUN CONTEXT 卡片）——**只有执行侧有** */
  | "RUN_ACTIVITY"
  /** 阻塞、取消、需要恢复 —— 异常，必须显眼。**只有执行侧有**：Run 才有恢复流程 */
  | "RECOVERY"
  | SharedMessageType;

/**
 * 上面这张清单里**与探索线程共用的**那些。`type-parity.test.ts` 断言它逐字等于
 * `SharedMessageType`——两边任何一个漏了共用项，编译期就红（见 conversationTypes.ts）。
 */
export type ExecutionSharedMessageType = Extract<ExecutionMessageType, SharedMessageType>;

/**
 * **权重：这一类消息在会话里占多少地方。** 它与"形态"（`kind`）是两个轴：
 * `kind` 说"这一行长什么样"（模板按它选组件），权重说"它凭什么留在视线里"。
 *
 * 三个取值照 OpenClaw 那条线切：
 * - `answer`：**你说的、模型对你说的、以及需要你决策的**。常驻，不折。
 * - `process`：**模型对外做的过程**（动作、推理、判定、轮次、机制记录）。
 *   所属执行步骤**跑完之后**折进它上方那一行；跑的过程中照常逐条显示——
 *   照 OpenClaw：*live response text and the working indicator stay outside the log*。
 * - `hidden`：不渲染，也不进任何计数。Provider 的回显与会话机制、以及全部 ④「跑模型的程序报的」。
 *
 * 判据是"它对看懂这次执行有没有独立贡献"。同一次事实的第二行、每一轮的机制记录、
 * 以及内容在别处已经有的回声，都不该各占一行。
 */
export type ExecutionMessageWeight = "answer" | "process" | "hidden";

/** ④「跑模型的程序报的」运行事实的权重一律是 `hidden`：归宿是 Run 头诊断区，不是会话正文。 */
export const EXECUTION_MESSAGE_WEIGHTS: Record<ExecutionMessageType, ExecutionMessageWeight> = {
  PLAN: "answer",
  ASSISTANT_MESSAGE: "answer",
  MODEL_REPORT: "answer",
  USER_MESSAGE: "answer",
  RUN_ACTIVITY: "answer",
  RECOVERY: "answer",
  COMMAND: "process",
  FILE_CHANGE: "process",
  TOOL_CALL: "process",
  MCP_CALL: "process",
  SUBAGENT: "process",
  WEB_SEARCH: "process",
  IMAGE_GENERATION: "process",
  TASK_LIFECYCLE: "process",
  REASONING: "process",
  GATE: "process",
  TURN_STATUS: "process",
  CONTEXT: "process",
  UNCLASSIFIED: "process",
  PROVIDER_MESSAGE: "hidden",
  SESSION: "hidden",
  PROVIDER_COMPACTION: "hidden",
  PERMISSION_DENIED: "hidden",
  RATE_LIMIT: "hidden",
  PROVIDER_RETRY: "hidden",
  BACKGROUND_TASK: "hidden",
  HOOK: "hidden",
  PROVIDER_WARNING: "hidden",
};

/**
 * 执行侧的大类表：共用项直接取 `SHARED_MESSAGE_CLASSES`（**分类的唯一定义处**），
 * 这里只补执行侧独有的五项。冻结方案、Plan 任务、Run 级事件、恢复都是 Factory 自己的账；
 * 执行报告是模型说的（协议解析后的一种正文形态）。
 */
export const EXECUTION_MESSAGE_CLASSES: Record<ExecutionMessageType, MessageClass> = {
  ...SHARED_MESSAGE_CLASSES,
  PLAN: "factory",
  MODEL_REPORT: "model",
  TASK_LIFECYCLE: "factory",
  RUN_ACTIVITY: "factory",
  RECOVERY: "factory",
};

/**
 * 这条条目是不是 ④「跑模型的程序报的」运行事实 —— Run 头那节读它。
 *
 * 判据来自两张表：大类是 `provider`，且权重是 `hidden`（即它**没在会话里露过面**）。
 * `PROVIDER_MESSAGE` 排除在外：那是"Provider 把你那句话回显一次"，诊断价值为零。
 */
export function isRuntimeFactItem(item: ExecutionStreamItem): boolean {
  return (
    EXECUTION_MESSAGE_CLASSES[item.messageType] === "provider" &&
    EXECUTION_MESSAGE_WEIGHTS[item.messageType] === "hidden" &&
    item.messageType !== "PROVIDER_MESSAGE"
  );
}

/**
 * **这一条到底是"结论"还是"过程"。**
 *
 * 表给的是按消息类型的默认值，这里只对它做**一处细化**：`ASSISTANT_MESSAGE` 按 Codex 给的
 * `phase` 分档——`commentary`（中途的叙述）是过程，`final_answer`（这一轮真正的回答）是结论。
 * 这正是 OpenClaw「Worked for …」那条折叠线的判据。
 *
 * **拿不到 `phase` 一律按结论处理**：Provider 不保证给（Codex schema 原话是 callers must treat
 * `None` as "phase unknown"），把判不准的正文折起来，等于把可能重要的内容藏了。
 */
export function executionMessageWeight(item: ExecutionStreamItem): ExecutionMessageWeight {
  const weight = EXECUTION_MESSAGE_WEIGHTS[item.messageType];
  if (weight === "hidden") return "hidden";
  if (item.messageType === "ASSISTANT_MESSAGE" && item.phase === "commentary") return "process";
  return weight;
}

/**
 * 执行会话里条目的**形态**——模板按它选行组件。六种的 DOM 各不相同：
 * - `plan`：冻结方案卡（可展开）
 * - `model`：`ASSISTANT_MESSAGE` 与 `MODEL_REPORT` 共用（都是 markdown 正文，只差标题）
 * - `user`：你自己说的话（`›` + 纯文本）
 * - `divider`：会话边界（上下文在这里换了），与探索侧同形——它是**边界不是事件**，
 *   所以不折进过程记录：折进去，"这一轮的上下文从这儿重新开始"就看不见了
 * - `reasoning`：可折叠的推理卡，与探索侧同形——推理是背景音，不该占正文的地方
 * - `activity` / `tool`：其余全部——正文只有一句 `detail`，其中 `tool` 还能展开看结果
 *
 * **按形态分文件，不按消息类型分**：28 个消息类型映射到这 7 种形态，
 * 其中 `tool` 一条就承担命令 / 文件变更 / 工具调用 / MCP / 子代理 / 搜索 / 生图七类。
 */
export const EXECUTION_ROW_KINDS = ["plan", "model", "user", "divider", "reasoning", "activity", "tool"] as const;

/**
 * 编译期护栏：这张清单必须正好是 `ExecutionStreamItem["kind"]` 的全部取值。
 * 新增一种形态却没登记时，下面这行编译不过——模板里那个"未识别的消息形态"兜底也就不会被跑到。
 */
const _kindCoverage: Record<Exclude<ExecutionStreamItem["kind"], (typeof EXECUTION_ROW_KINDS)[number]>, true> = {};
void _kindCoverage;

/** 形态由消息类型决定，**只有一处**（`ProjectProviderActivity` 也会覆盖它，见那里的说明）。 */
const KIND_BY_MESSAGE_TYPE: Record<ExecutionMessageType, ExecutionStreamItem["kind"]> = {
  PLAN: "plan",
  ASSISTANT_MESSAGE: "model",
  MODEL_REPORT: "model",
  USER_MESSAGE: "user",
  CONTEXT: "divider",
  COMMAND: "tool",
  FILE_CHANGE: "tool",
  TOOL_CALL: "tool",
  MCP_CALL: "tool",
  SUBAGENT: "tool",
  WEB_SEARCH: "tool",
  IMAGE_GENERATION: "tool",
  TASK_LIFECYCLE: "activity",
  REASONING: "reasoning",
  GATE: "activity",
  TURN_STATUS: "activity",
  UNCLASSIFIED: "activity",
  PROVIDER_MESSAGE: "activity",
  SESSION: "activity",
  PROVIDER_COMPACTION: "activity",
  PERMISSION_DENIED: "activity",
  RATE_LIMIT: "activity",
  PROVIDER_RETRY: "activity",
  BACKGROUND_TASK: "activity",
  HOOK: "activity",
  PROVIDER_WARNING: "activity",
  RUN_ACTIVITY: "activity",
  RECOVERY: "activity",
};

/** 这类消息的默认形态。投影用它，模板的兜底不变。 */
export function executionRowKind(messageType: ExecutionMessageType): ExecutionStreamItem["kind"] {
  return KIND_BY_MESSAGE_TYPE[messageType];
}

/**
 * 执行会话里条目状态的中文文案。**这套状态机只有这一张表**——行组件与视图都从这儿取，
 * 两处各写一份就会出现"失败 / 阻塞"与"失败"指同一个状态。
 * （颜色另有一处：`utils/statusTag.ts` 的 `statusTagType`；文案常要当纯文本用，颜色只给 `el-tag`。）
 */
export function executionMessageStatusLabel(status: ExecutionStreamItem["status"]): string {
  return ({ RUNNING: "进行中", COMPLETED: "已完成", WAITING: "等待中", FAILED: "失败 / 阻塞", INFO: "信息", UNKNOWN: "状态未知" } as const)[
    status
  ];
}

/**
 * 这条消息是否只是"机制记录"——它不构成内容，因此不改变"报告是否重复"的判断
 * （见 flushModel 里合并重复完成报告的那段）。
 * 此前这里比的是**标题字符串**（`["Task progress", "Execution activity", "任务完成"].includes(title)`），
 * 改一个文案就会静默失效。
 */
function isMechanismOnly(item: ExecutionStreamItem): boolean {
  return (
    item.messageType === "TURN_STATUS" ||
    item.messageType === "TASK_LIFECYCLE" ||
    item.messageType === "GATE" ||
    item.messageType === "CONTEXT" ||
    item.messageType === "UNCLASSIFIED"
  );
}

/**
 * **这一条要不要折进上方的过程记录。**
 *
 * 四条判据，缺一不可：
 *   1) **不是分隔行**（见下）；
 *   2) 权重是 `process`（结论、隐藏项不折）；
 *   3) 它**不在**当前正在跑的那一步里——OpenClaw 的原话是 live 内容留在日志外面；
 *   4) 它**不是失败**——`Worked for 2 分 3 秒 · 2 个失败` 这一行的意思是"失败数在标题上，
 *      失败的条目本身也还在外面"。把失败折起来，等于把这轮唯一要你处理的事藏了。
 *
 * 第 3 条由调用方（`useExecutionConversation` 的分组）传进来：视图知道"这一步跑完没有"，
 * 投影层不知道，也不该知道。
 *
 * **第 1 条（`divider` 永远不折）是这里唯一的"形态"判据**，因为折叠这件事只有形态说了不算：
 * 续跑检查点在权重表里是 `process`（它确实是过程的一部分，不是结论），可它同时是**边界**——
 * 折进「N 条过程记录」里，"这一轮从这儿换了一轮"就再也看不见了。此前只在形态（`kind`）上把它
 * 改成了分隔线，于是**看上去是边界、行为上仍被折**（见 docs/消息类型及事件状态机流程图.md §7）。
 */
export function foldsIntoProcess(item: ExecutionStreamItem, options: { stepRunning: boolean }): boolean {
  if (item.kind === "divider") return false;
  if (executionMessageWeight(item) !== "process") return false;
  if (options.stepRunning) return false;
  return item.status !== "FAILED";
}

type PendingModelText = {
  text: string;
  firstSequence: number;
  lastSequence: number;
  occurredAt: string;
  taskId?: string;
  modelStep?: number;
  loopId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  /** 过程叙述还是最终回答。**也是分段依据**——两种重量不能粘成一条（见 executionMessageWeight）。 */
  phase?: ModelMessagePhase;
};

/** 将 ExecutionThread journal 映射成按 Plan 任务归组的模型、Provider 和用户消息。 */
export function projectExecutionJournal(
  journal: ExecutionJournalEntry[],
  threadState: string = "ACTIVE",
  plan?: ExecutionPlanSnapshot,
): ExecutionStreamItem[] {
  const orderedJournal = [...journal].sort((a, b) => a.sequence - b.sequence);
  const { taskByLoopStep, continuationLoops } = projectTaskAssociations(orderedJournal);
  const items: ExecutionStreamItem[] = plan ? [planMessage(plan)] : [];
  const toolItems = new Map<string, ExecutionStreamItem>();
  const providerItems = new Map<string, ExecutionStreamItem>();
  const modelTurnItems = new Map<string, ExecutionStreamItem>();
  const seenCompletedTasks = new Set<string>();
  let currentModelStep: number | undefined;
  let currentLoopId: string | undefined;
  let pendingModel: PendingModelText | null = null;

  const flushModel = () => {
    if (!pendingModel?.text) {
      pendingModel = null;
      return;
    }
    const display = humanizeModelOutput(pendingModel.text);
    // 正文被清空（例如整条输出只有一段任务标记）时**不产生卡片**：只剩标题和时间的空卡片是纯噪音。
    if (!display || !display.body.trim()) {
      pendingModel = null;
      return;
    }
    if (display) {
      let previousIndex = -1;
      if (display.report) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          if (items[index]?.messageType === "MODEL_REPORT") {
            previousIndex = index;
            break;
          }
        }
      }
      const previous = previousIndex >= 0 ? items[previousIndex] : undefined;
      const onlyProgressBetween = previousIndex >= 0 && items.slice(previousIndex + 1).every(isMechanismOnly);
      /**
       * **合并只在同一轮 Loop 内做。** 这段合并是为了把"模型反复重报同一份进度"折成一条，
       * 那说的是**同一轮**里的重复。补充要求会为同一个 Run 起新的一轮，而新一轮的第一份报告
       * 数字往往与上一轮完全相同（任务没变、文件也还没改）——于是它会被并进**上一轮**那一行：
       * 内容被覆盖、`sequence`/`occurredAt` 被改写成新的，看起来就是"那一行又在执行了"。
       * 两轮是两段不同的工作，必须各占一行。
       */
      const sameLoop = !pendingModel.loopId || !previous?.loopId || pendingModel.loopId === previous.loopId;
      if (previous && sameLoop && onlyProgressBetween && sameReportProgress(previous.content, display.body)) {
        previous.content = display.body;
        previous.sequence = pendingModel.lastSequence;
        previous.occurredAt = pendingModel.occurredAt;
        previous.repetitionCount = (previous.repetitionCount ?? 1) + 1;
        pendingModel = null;
        return;
      }
      const missing: string[] = [];
      if (pendingModel.modelStep === undefined) missing.push("模型轮次未记录");
      if (!pendingModel.providerThreadId && !pendingModel.providerTurnId) missing.push("Provider 会话标识未记录");
      items.push({
        id: `execution-model-${pendingModel.firstSequence}`,
        kind: "model",
        role: "assistant",
        title: display.title,
        content: display.body,
        messageType: display.report ? "MODEL_REPORT" : "ASSISTANT_MESSAGE",
        detail: missing.join(" · "),
        status: "COMPLETED",
        occurredAt: pendingModel.occurredAt,
        sequence: pendingModel.lastSequence,
        ...(pendingModel.phase ? { phase: pendingModel.phase } : {}),
        ...(pendingModel.taskId ? { taskId: pendingModel.taskId } : {}),
        ...(pendingModel.modelStep === undefined ? {} : { modelStep: pendingModel.modelStep }),
        ...(pendingModel.loopId ? { loopId: pendingModel.loopId } : {}),
        ...(pendingModel.providerThreadId ? { providerThreadId: pendingModel.providerThreadId } : {}),
        ...(pendingModel.providerTurnId ? { providerTurnId: pendingModel.providerTurnId } : {}),
        ...(pendingModel.providerItemId ? { providerItemId: pendingModel.providerItemId } : {}),
        ...(missing.length ? { unrecordedFields: missing } : {}),
      });
    }
    pendingModel = null;
  };

  for (const entry of orderedJournal) {
    const payload = entry.payload;
    const step = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
    const loopId = stringValue(payload.loopId) ?? currentLoopId;
    /**
     * **补充轮不归任何任务**：它既不是某个步骤做的工作，也不该被折进某个步骤的分组里。
     * 连它自己带了 `taskId` 也不认——那是写侧按"当时活跃的任务"盖的戳（用户报的正是
     * 「补充内容被放进了最后那个 task 里」）。
     */
    const continuation = loopId !== undefined && continuationLoops.has(loopId);
    const taskId = continuation
      ? undefined
      : (stringValue(payload.taskId) ?? (step === undefined ? undefined : taskByLoopStep.get(loopId ? `${loopId}#${step}` : `#${step}`)));

    if (entry.type === "MODEL_OUTPUT") {
      const text = stringValue(payload.text) ?? "";
      const providerItemId = stringValue(payload.providerItemId);
      const providerThreadId = stringValue(payload.providerThreadId);
      const providerTurnId = stringValue(payload.providerTurnId);
      // `phase` 变了就换一条：过程叙述与最终回答是两种重量（前者折进过程记录，后者常驻），
      // 粘成一条会让整段都变成其中一种。与写侧 `bufferModelOutput` 的分段键逐字一致。
      const phase = payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined;
      const sameModelStream =
        pendingModel && pendingModel.modelStep === step && pendingModel.providerItemId === providerItemId && pendingModel.phase === phase;
      if (!sameModelStream) flushModel();
      if (!pendingModel) {
        pendingModel = {
          text,
          firstSequence: entry.sequence,
          lastSequence: entry.sequence,
          occurredAt: entry.occurredAt,
          ...(taskId ? { taskId } : {}),
          ...(step === undefined ? {} : { modelStep: step }),
          ...(loopId ? { loopId } : {}),
          ...(providerThreadId ? { providerThreadId } : {}),
          ...(providerTurnId ? { providerTurnId } : {}),
          ...(providerItemId ? { providerItemId } : {}),
          ...(phase ? { phase } : {}),
        };
      } else {
        pendingModel.text += text;
        pendingModel.lastSequence = entry.sequence;
        if (!pendingModel.taskId && taskId) pendingModel.taskId = taskId;
        if (!pendingModel.providerThreadId && providerThreadId) pendingModel.providerThreadId = providerThreadId;
        if (!pendingModel.providerTurnId && providerTurnId) pendingModel.providerTurnId = providerTurnId;
      }
      continue;
    }

    flushModel();
    if (entry.type === "TASK_PROGRESS" && payload.event === "agent.step.started") {
      currentModelStep = numberValue(payload.modelStep) ?? numberValue(payload.step);
      currentLoopId = stringValue(payload.loopId) ?? currentLoopId;
    }

    if (entry.type === "TOOL_CALL") {
      const item = projectToolCall(entry, taskId, step, loopId);
      const key = item.callId ? `call:${item.callId}` : `missing:${entry.sequence}`;
      const providerKey = item.callId ? `provider:${item.callId}` : "";
      const previous = toolItems.get(key) ?? (providerKey ? providerItems.get(providerKey) : undefined);
      if (previous) {
        const providerDecorated = Boolean(previous.providerItemId);
        if (!providerDecorated) {
          previous.title = item.title;
          previous.detail = item.detail;
          previous.source = item.source;
        } else if (item.status !== "RUNNING") {
          previous.detail = item.detail;
        }
        if (item.status !== "RUNNING" || previous.status === "RUNNING") previous.status = item.status;
        previous.taskId = previous.taskId ?? item.taskId;
        previous.modelStep = previous.modelStep ?? item.modelStep;
        previous.loopId = previous.loopId ?? item.loopId;
        previous.providerThreadId = previous.providerThreadId ?? item.providerThreadId;
        previous.providerTurnId = previous.providerTurnId ?? item.providerTurnId;
        previous.callId = previous.callId ?? item.callId;
        previous.unrecordedFields = providerDecorated ? previous.unrecordedFields : item.unrecordedFields;
        toolItems.set(key, previous);
        if (providerKey) providerItems.set(providerKey, previous);
      } else {
        toolItems.set(key, item);
        items.push(item);
      }
      continue;
    }

    if (entry.type === "PROVIDER_ACTIVITY") {
      const item = projectProviderActivity(entry, taskId, step, loopId);
      const identity = item.providerItemId ?? stringValue(payload.itemId);
      const key = identity ? `provider:${identity}` : `missing:${entry.sequence}`;
      const callKey = item.callId ? `call:${item.callId}` : "";
      const previous = providerItems.get(key) ?? (callKey ? toolItems.get(callKey) : undefined);
      if (previous) {
        const previousWasTool = previous.kind === "tool" && Boolean(previous.callId);
        if (!previousWasTool) {
          previous.title = item.title;
          previous.detail = item.detail;
        } else {
          previous.title = item.title;
          if (item.status !== "RUNNING" || previous.status === "RUNNING") previous.status = item.status;
          if (item.status !== "RUNNING") previous.detail = item.detail;
        }
        if (!previousWasTool) previous.status = item.status;
        previous.taskId = previous.taskId ?? item.taskId;
        previous.serverName = item.serverName ?? previous.serverName;
        previous.modelStep = previous.modelStep ?? item.modelStep;
        previous.loopId = previous.loopId ?? item.loopId;
        previous.providerThreadId = previous.providerThreadId ?? item.providerThreadId;
        previous.providerTurnId = previous.providerTurnId ?? item.providerTurnId;
        previous.providerItemId = previous.providerItemId ?? item.providerItemId;
        previous.callId = previous.callId ?? item.callId;
        previous.source = "provider";
        previous.unrecordedFields = previousWasTool ? previous.unrecordedFields : item.unrecordedFields;
        // **结构化载荷跟着"后到的那一条"走**：命令的 `output` / `exitCode` / `durationMs` 只有
        // **结束**事件才有，而条目是 `started` 先建出来的——不搬过来，命令行就永远没有「显示结果」，
        // 明明 journal 里躺着完整的 stdout。（实测：一次真实 Run 里两行命令都没有那个按钮，
        // 而同一轮的 `fileChange` 有——因为它的 `changes` 在 started 那条上就已经带了。）
        previous.arguments = item.arguments ?? previous.arguments;
        previous.result = item.result ?? previous.result;
        previous.output = item.output ?? previous.output;
        previous.exitCode = item.exitCode ?? previous.exitCode;
        previous.durationMs = item.durationMs ?? previous.durationMs;
        providerItems.set(key, previous);
        if (callKey) toolItems.set(callKey, previous);
      } else {
        providerItems.set(key, item);
        if (callKey) toolItems.set(callKey, item);
        items.push(item);
      }
      continue;
    }

    if (entry.type === "TASK_PROGRESS") {
      const event = stringValue(payload.event) ?? "";
      // `continuation` 是"这一轮由补充要求起"的标记：写侧的账，不该在会话里占一行
      // （此前它掉进兜底，显示成「未识别 · 执行活动」）。这一轮的条目由 `continuationLoops` 认。
      if (payload.action === "continuation") continue;
      if (event === "agent.step.started" || event === "agent.model.completed") {
        const modelStep = numberValue(payload.modelStep) ?? numberValue(payload.step);
        if (modelStep !== undefined) currentModelStep = modelStep;
        currentLoopId = stringValue(payload.loopId) ?? currentLoopId;
        const key = `${currentLoopId ?? "loop-not-recorded"}:${modelStep ?? `sequence-${entry.sequence}`}`;
        const existing = modelTurnItems.get(key);
        const completed = event === "agent.model.completed";
        if (existing) {
          existing.status = completed ? "COMPLETED" : "RUNNING";
          existing.detail = completed ? "模型轮次已结束" : "模型正在处理此轮任务";
          existing.providerThreadId = stringValue(payload.providerThreadId) ?? existing.providerThreadId;
          existing.providerTurnId = stringValue(payload.providerTurnId) ?? existing.providerTurnId;
        } else {
          const unrecorded = modelStep === undefined ? ["模型轮次未记录"] : [];
          const item = activity(
            entry,
            modelStep === undefined ? "模型轮次" : `模型轮次 · #${modelStep}`,
            completed ? "模型轮次已结束" : "模型正在处理此轮任务",
            completed ? "COMPLETED" : "RUNNING",
            {
              messageType: "TURN_STATUS",
              ...(taskId ? { taskId } : {}),
              ...(modelStep === undefined ? {} : { modelStep }),
              ...(currentLoopId ? { loopId: currentLoopId } : {}),
              ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}),
              ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}),
              ...(unrecorded.length ? { unrecordedFields: unrecorded } : {}),
            },
          );
          modelTurnItems.set(key, item);
          items.push(item);
        }
        continue;
      }
      if (payload.action === "task-status") {
        const completedIds = stringArray(payload.completedTaskIds);
        const newlyCompleted = completedIds.filter((id) => !seenCompletedTasks.has(id));
        for (const id of completedIds) seenCompletedTasks.add(id);
        for (const item of projectTaskStatus(entry, plan, newlyCompleted)) items.push(item);
        continue;
      }
      if (payload.action === "task-lifecycle") {
        const lifecycleTaskId = stringValue(payload.taskId);
        const lifecycleState = payload.state;
        if (lifecycleTaskId && (lifecycleState === "IN_PROGRESS" || lifecycleState === "DONE" || lifecycleState === "BLOCKED")) {
          if (lifecycleState === "DONE") seenCompletedTasks.add(lifecycleTaskId);
          const title = lifecycleState === "IN_PROGRESS" ? "任务开始" : lifecycleState === "DONE" ? "任务完成" : "任务阻塞";
          const detail =
            lifecycleState === "BLOCKED" ? (stringValue(payload.reason) ?? "阻塞原因未记录。") : taskTitle(plan, lifecycleTaskId);
          items.push(
            activity(
              entry,
              title,
              detail,
              lifecycleState === "IN_PROGRESS" ? "RUNNING" : lifecycleState === "DONE" ? "COMPLETED" : "FAILED",
              {
                messageType: "TASK_LIFECYCLE",
                taskId: lifecycleTaskId,
                ...(step === undefined ? {} : { modelStep: step }),
                ...(loopId ? { loopId } : {}),
                ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}),
                ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}),
              },
            ),
          );
        }
        continue;
      }
    }

    const projected = projectExecutionActivity(entry, taskId, step, loopId);
    if (projected) items.push(projected);
  }

  flushModel();
  if (threadState !== "ACTIVE") {
    for (const item of modelTurnItems.values()) {
      if (item.status === "RUNNING") {
        item.status = threadState === "PAUSED" ? "WAITING" : "UNKNOWN";
        item.detail = threadState === "PAUSED" ? "等待执行线程恢复。" : "模型轮次结束状态未记录。";
      }
    }
    for (const item of toolItems.values()) {
      if (item.status === "RUNNING") {
        item.status = "UNKNOWN";
        item.detail = item.callId ? "未记录调用的结束状态。" : "调用标识和结束状态未记录。";
      }
    }
    for (const item of providerItems.values()) {
      if (item.status === "RUNNING") {
        item.status = "UNKNOWN";
        item.detail = item.providerItemId ? "Provider 未记录此活动的结束状态。" : "Provider 活动标识和结束状态未记录。";
      }
    }
  }
  if (threadState === "ACTIVE") {
    const activeStep = currentModelStep;
    const activeLoopId = currentLoopId;
    for (const item of items) {
      /**
       * **`loopId` 也要比。** `modelStep` 是**每个 Loop 各自从 1 数**的，而补充要求会为同一个 Run
       * 起新的一轮——那一轮又从第 1 步开始。只比步号，第一轮那些 `modelStep === 1` 的条目会在
       * 补充要求发出后被**重新标成「进行中」**：实测报障就是它（投一条补充要求之后，上一轮已经
       * 做完的执行说明与执行报告全变成了进行中）。
       *
       * `currentLoopId` 为 undefined 时这条判据退化成原来的行为（老数据没有 loopId），
       * 所以历史记录不受影响。
       */
      if (item.kind === "model" && item.modelStep === activeStep && item.loopId === activeLoopId) item.status = "RUNNING";
    }
  }
  /**
   * **补充轮次的条目一律不带任务归属**，并按轮次编号——界面据此一轮一组。
   *
   * 放在收尾统一做，而不是把标志传给十几个构造点：漏一处就会有一条挂在任务下面，而那种
   * "少一条"的表现是某个已完成的分组里悄悄多了一行——没人会发现。
   *
   * 编号必须**按顺序**数：那句「你补充了要求」的日志**不带 loopId**（它写在那一轮开始之前），
   * 所以它取"下一个轮次号"，轮内的条目取自己那一轮的号。只有 `delivery: "QUEUE"` 那句算
   * "起了一轮"——`STEER` 是插进**正在跑的那一轮**里的，它属于那个步骤的现场，不该被搬出来。
   */
  let round = 0;
  const roundByLoop = new Map<string, number>();
  for (const item of items) {
    /**
     * **这句先于 loopId 规则处理。** 它的日志不带 `loopId`，而投影会顺手把它归给"上一个 Loop"
     * ——那正是它要离开的那一轮。于是就出现了"第二句补充要求落进第一轮"（实测）。这里既给它
     * 按顺序编轮次，也把那个继承来的 loopId 摘掉：它不属于上一轮。
     */
    if (item.messageType === "USER_MESSAGE" && item.guidanceDelivery === "QUEUE") {
      item.continuation = true;
      item.continuationRound = round + 1;
      delete item.taskId;
      delete item.loopId;
      continue;
    }
    if (item.loopId && continuationLoops.has(item.loopId)) {
      let index = roundByLoop.get(item.loopId);
      if (index === undefined) {
        index = round += 1;
        roundByLoop.set(item.loopId, index);
      }
      item.continuation = true;
      item.continuationRound = index;
      delete item.taskId;
    }
  }
  return items;
}

/**
 * 一条 journal 事实该归到哪个计划任务，以及**哪些 Loop 是补充要求起的那一轮**。
 *
 * 键必须是 **`loopId#modelStep` 两段**，不能只用 `modelStep`：modelStep 是**每个 Loop 各自从 1 数**
 * 的，而这张表是整条 journal 一起建的——补充那一轮的第 1 步会撞上第一轮的第 1 步，于是整轮 23 条
 * （连你那句「你补充了要求」）被算进某个已完成任务的组里。实测就是这么错的。
 *
 * 补充轮次从日志本身认：`action: "continuation"` 那条**不带 loopId**，它写在下一轮开始之前，
 * 所以"标记之后第一个新出现的 loopId"就是它。
 */
function projectTaskAssociations(journal: ExecutionJournalEntry[]): {
  taskByLoopStep: Map<string, string>;
  continuationLoops: Set<string>;
} {
  const byStep = new Map<string, string>();
  const continuationLoops = new Set<string>();
  const completed = new Set<string>();
  const structuredSteps = new Set<number>();
  for (const entry of journal) {
    if (entry.type === "TASK_PROGRESS" && (entry.payload.action === "task-status" || entry.payload.action === "task-lifecycle")) {
      const step = numberValue(entry.payload.modelStep);
      if (step !== undefined) structuredSteps.add(step);
    }
  }
  let currentModelStep: number | undefined;
  let currentLoopId: string | undefined;
  let modelText = "";
  let pendingContinuation = false;
  const seenLoops = new Set<string>();
  for (const entry of journal) {
    const entryLoopId = stringValue(entry.payload.loopId);
    if (entryLoopId && !seenLoops.has(entryLoopId)) {
      seenLoops.add(entryLoopId);
      if (pendingContinuation) {
        continuationLoops.add(entryLoopId);
        pendingContinuation = false;
      }
    }
    if (entry.type === "MODEL_OUTPUT") {
      modelText += stringValue(entry.payload.text) ?? "";
      const outputStep = numberValue(entry.payload.modelStep);
      if (outputStep !== undefined) currentModelStep = outputStep;
      if (entryLoopId) currentLoopId = entryLoopId;
      continue;
    }
    if (entry.type !== "TASK_PROGRESS") continue;
    const payload = entry.payload;
    if (payload.action === "continuation") {
      pendingContinuation = true;
      continue;
    }
    const loopId = entryLoopId ?? currentLoopId;
    const key = (step: number) => (loopId ? `${loopId}#${step}` : `#${step}`);
    if (payload.event === "agent.step.started")
      currentModelStep = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
    if (payload.action === "task-status") {
      const completedIds = stringArray(payload.completedTaskIds);
      const newlyCompleted = completedIds.filter((id) => !completed.has(id));
      const taskId =
        stringValue(payload.blockedTaskId) ??
        stringValue(payload.activeTaskId) ??
        (newlyCompleted.length === 1 ? newlyCompleted[0] : undefined);
      const modelStep = numberValue(payload.modelStep);
      if (taskId && modelStep !== undefined) byStep.set(key(modelStep), taskId);
      for (const id of completedIds) completed.add(id);
      continue;
    }
    if (payload.action === "task-lifecycle") {
      const taskId = stringValue(payload.taskId);
      const modelStep = numberValue(payload.modelStep);
      if (taskId && modelStep !== undefined) byStep.set(key(modelStep), taskId);
      if (taskId && payload.state === "DONE") completed.add(taskId);
      continue;
    }
    if (payload.event === "agent.model.completed") {
      const modelStep = numberValue(payload.modelStep) ?? numberValue(payload.step) ?? currentModelStep;
      if (modelStep !== undefined && !structuredSteps.has(modelStep)) {
        const report = parseStructuredTaskReport(modelText);
        if (report) {
          const newlyCompleted = report.completedTaskIds.filter((id) => !completed.has(id));
          const taskId = report.blockedTaskId ?? report.activeTaskId ?? (newlyCompleted.length === 1 ? newlyCompleted[0] : undefined);
          if (taskId) byStep.set(key(modelStep), taskId);
          for (const id of report.completedTaskIds) completed.add(id);
        }
      }
      modelText = "";
    }
  }
  return { taskByLoopStep: byStep, continuationLoops };
}

function parseStructuredTaskReport(content: string): { completedTaskIds: string[]; activeTaskId?: string; blockedTaskId?: string } | null {
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  if (start < 0) return null;
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return null;
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as Record<string, unknown>;
    if (!Array.isArray(report.completedTaskIds) || !report.completedTaskIds.every((id) => typeof id === "string")) return null;
    return {
      completedTaskIds: report.completedTaskIds as string[],
      ...(typeof report.activeTaskId === "string" ? { activeTaskId: report.activeTaskId } : {}),
      ...(typeof report.blockedTaskId === "string" ? { blockedTaskId: report.blockedTaskId } : {}),
    };
  } catch {
    return null;
  }
}

function planMessage(plan: ExecutionPlanSnapshot): ExecutionStreamItem {
  return {
    id: `execution-plan-${plan.planId}-${plan.revision}`,
    kind: "plan",
    role: "assistant",
    title: "已收到方案",
    content: plan.goal,
    messageType: "PLAN",
    detail: "",
    status: "COMPLETED",
    occurredAt: plan.occurredAt,
    sequence: 0,
    plan,
  };
}

function projectTaskStatus(
  entry: ExecutionJournalEntry,
  plan: ExecutionPlanSnapshot | undefined,
  newlyCompleted: string[],
): ExecutionStreamItem[] {
  const payload = entry.payload;
  const blockedTaskId = stringValue(payload.blockedTaskId);
  const activeTaskId = stringValue(payload.activeTaskId);
  const modelStep = numberValue(payload.modelStep);
  const loopId = stringValue(payload.loopId);
  const providerThreadId = stringValue(payload.providerThreadId);
  const providerTurnId = stringValue(payload.providerTurnId);
  const result: ExecutionStreamItem[] = [];
  const metadata = {
    messageType: "TASK_LIFECYCLE" as const,
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(providerTurnId ? { providerTurnId } : {}),
  };
  for (const completedTaskId of newlyCompleted) {
    if (completedTaskId === blockedTaskId || completedTaskId === activeTaskId) continue;
    const item = activity(entry, "任务完成", taskTitle(plan, completedTaskId), "COMPLETED", { taskId: completedTaskId, ...metadata });
    item.id = `${item.id}-${completedTaskId}`;
    result.push(item);
  }
  const taskId = blockedTaskId ?? activeTaskId;
  if (taskId) {
    const blocked = taskId === blockedTaskId;
    const detail = blocked ? (stringValue(payload.blockedReason) ?? "阻塞原因未记录。") : taskTitle(plan, taskId);
    result.push(activity(entry, blocked ? "任务阻塞" : "任务执行中", detail, blocked ? "FAILED" : "RUNNING", { taskId, ...metadata }));
  }
  return result;
}

function projectToolCall(
  entry: ExecutionJournalEntry,
  taskId: string | undefined,
  modelStep: number | undefined,
  loopId: string | undefined,
): ExecutionStreamItem {
  const payload = entry.payload;
  const callId = stringValue(payload.callId);
  const tool = stringValue(payload.tool);
  const source = payload.source === "provider" || payload.source === "factory" ? payload.source : "unknown";
  const action = stringValue(payload.action) ?? "requested";
  const status =
    action === "completed"
      ? "COMPLETED"
      : action === "failed" || action === "denied" || action === "needs-reconciliation"
        ? "FAILED"
        : action === "status-unknown"
          ? "UNKNOWN"
          : callId
            ? "RUNNING"
            : "UNKNOWN";
  const sourceLabel = source === "provider" ? "Provider" : source === "factory" ? "Factory" : "来源未记录";
  // 中文标签，与 Provider 活动的中立词表一致（此前是 "Provider tool call" 这类英文分类名）。
  const title = /mcp/i.test(tool ?? "") ? "MCP 调用" : "工具调用";
  const detailParts = [tool ?? "工具名称未记录", sourceLabel];
  const reason = stringValue(payload.reason);
  if (reason) detailParts.push(reason);
  else if (!callId) detailParts.push("调用标识未记录");
  else if (status === "UNKNOWN") detailParts.push("结束状态未记录");
  return {
    id: callId ? `execution-tool-${callId}` : `execution-tool-missing-${entry.sequence}`,
    kind: "tool",
    role: "system",
    title,
    content: "",
    detail: detailParts.join(" · "),
    messageType: "TOOL_CALL",
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(callId ? { callId } : {}),
    source,
    ...(!callId || !tool || source === "unknown"
      ? {
          unrecordedFields: [
            !callId ? "调用标识未记录" : "",
            !tool ? "工具名称未记录" : "",
            source === "unknown" ? "调用来源未记录" : "",
          ].filter(Boolean),
        }
      : {}),
  };
}

/**
 * Provider 活动的中立词表。**这是 packages/domain/src/model/provider-activity.ts 的一份镜像**——
 * web 不能运行时依赖领域层（会把整个领域打进浏览器包），而 journal 载荷里的字段是无类型的字符串。
 * 两边必须一致：`executionStream.parity.test.ts` 用同一批样例断言镜像与领域实现给出相同结论，
 * 改这里就要同步改那边，测试会拦住漂移。
 */
export type ProviderActivityKind =
  // ② 内容流
  | "reasoning"
  | "message"
  // ③ 动作
  | "command"
  | "file-change"
  | "tool"
  | "mcp"
  | "search"
  | "media"
  | "subagent"
  // ④ 运行事实（不进会话正文）
  | "session"
  | "compaction"
  | "hook"
  | "task"
  | "rate-limit"
  | "retry"
  | "permission"
  | "warning"
  | "review"
  | "other";
export type ProviderActivityOutcome = "running" | "succeeded" | "failed" | "unknown" | "not-applicable";

const ACTIVITY_KINDS: readonly ProviderActivityKind[] = [
  "reasoning",
  "message",
  "command",
  "file-change",
  "tool",
  "mcp",
  "search",
  "media",
  "subagent",
  "session",
  "compaction",
  "hook",
  "task",
  "rate-limit",
  "retry",
  "permission",
  "warning",
  "review",
  "other",
];
const ACTIVITY_OUTCOMES: readonly ProviderActivityOutcome[] = ["running", "succeeded", "failed", "unknown", "not-applicable"];

/**
 * 类别 → 展示词。**中立标签表只有这一处**：以前是拿 `itemType` 正则现猜（`/command/` → "Command"，
 * 其余一律 "Provider activity"），于是同一个动作换个 agent 就换个名字，而 "Provider activity"
 * 这种标签等于没说。
 */
const ACTIVITY_KIND_LABELS: Record<ProviderActivityKind, string> = {
  reasoning: "推理",
  message: "消息",
  command: "命令",
  "file-change": "文件变更",
  tool: "工具调用",
  mcp: "MCP 调用",
  search: "联网搜索",
  media: "生成图片",
  subagent: "子代理",
  // ④ 那几类只出现在 Run 头的诊断区，用它们自己的话说。
  session: "会话",
  compaction: "上下文已压缩",
  hook: "钩子",
  task: "后台子任务",
  "rate-limit": "配额",
  retry: "自动重试",
  permission: "权限被拒",
  warning: "Provider 警告",
  review: "评审模式",
  other: "活动",
};

/**
 * 验证结果的文案。`SKIPPED` 是"没跑"、`BLOCKED` 是"没跑成"，都不是失败——别合并成一个词。
 */
const VERIFICATION_STATUS_LABELS: Record<string, string> = {
  PASSED: "验证通过",
  FAILED: "验证未通过",
  BLOCKED: "验证被阻塞",
  SKIPPED: "验证已跳过",
};

/** 门禁判定的动作词。**只有 `blocked` 有信息量**，其余是"可以继续跑"。 */
function gateActionLabel(action: unknown): string {
  const value = typeof action === "string" ? action : "";
  if (value === "blocked") return "判定拦截";
  if (value === "complete") return "判定完成";
  if (value === "continue") return "判定继续";
  return value || "未记录";
}

function isActivityKind(value: unknown): value is ProviderActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * Provider 活动的中立类别 → 消息类型。`other` 归到"未识别"，**不伪装成已知类别**——
 * 认不出来就说认不出来，比塞进"命令"里更诚实。
 */
const ACTIVITY_MESSAGE_TYPES: Record<ProviderActivityKind, ExecutionMessageType> = {
  command: "COMMAND",
  "file-change": "FILE_CHANGE",
  tool: "TOOL_CALL",
  // MCP 调用有自己的名字（不再并进 `tool`）：探索线程那边同样单列一类，
  // 两条会话里"这是 MCP 服务端的调用"都看得见。
  mcp: "MCP_CALL",
  search: "WEB_SEARCH",
  media: "IMAGE_GENERATION",
  subagent: "SUBAGENT",
  reasoning: "REASONING",
  message: "PROVIDER_MESSAGE",
  // ④：一律 `hidden`（见 EXECUTION_MESSAGE_WEIGHTS），归宿是 Run 头的「Provider 运行事实」。
  session: "SESSION",
  compaction: "PROVIDER_COMPACTION",
  hook: "HOOK",
  task: "BACKGROUND_TASK",
  "rate-limit": "RATE_LIMIT",
  retry: "PROVIDER_RETRY",
  permission: "PERMISSION_DENIED",
  warning: "PROVIDER_WARNING",
  // Codex 的评审模式没有独立的展示位：它与"Provider 说了句话"是同一件事，归到未识别那一档。
  review: "UNCLASSIFIED",
  other: "UNCLASSIFIED",
};

/**
 * ④「跑模型的程序报的」的中立类别。与领域侧 `isRuntimeKind()` 同义——**两边各自成表是因为
 * web 不能运行时依赖领域层**（见本段开头的说明），不是可以随便分叉的两份。parity 测试会拦。
 */
export const RUNTIME_ACTIVITY_KINDS: ReadonlySet<ProviderActivityKind> = new Set([
  "session",
  "compaction",
  "hook",
  "task",
  "rate-limit",
  "retry",
  "permission",
  "warning",
  "review",
]);

/** 该类别是不是 ④。语义见 `RUNTIME_ACTIVITY_KINDS`。 */
export function isRuntimeActivityKind(kind: ProviderActivityKind): boolean {
  return RUNTIME_ACTIVITY_KINDS.has(kind);
}

/**
 * ④ 里**需要浮到用户眼前**的那几类（配额、重试、权限被拒、告警、评审）。
 * 与 `packages/domain/src/model/provider-activity.ts` 的 `isRuntimeAlertKind` 同义。
 */
const RUNTIME_ALERT_KINDS: ReadonlySet<ProviderActivityKind> = new Set(["rate-limit", "retry", "permission", "warning", "review"]);

/**
 * 这条运行事实要不要**浮出来**（而不是安静地待在诊断区里）。
 *
 * 两条判据：类别本身就是要你动手的，或者它**失败了**（钩子挂了、后台子任务失败了）。
 * 只按类别判，会把"钩子执行失败"藏进展开区；只按失败判，会把"配额用尽"这种
 * 明明成功返回、却要你立刻知道的事漏掉。
 */
export function isRuntimeAlertItem(item: ExecutionStreamItem): boolean {
  if (!item.activityKind || !isRuntimeActivityKind(item.activityKind)) return false;
  return RUNTIME_ALERT_KINDS.has(item.activityKind) || item.status === "FAILED";
}

function isActivityOutcome(value: unknown): value is ProviderActivityOutcome {
  return typeof value === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}

/**
 * 老 journal 事件的类别兜底（本次改动之前写入的条目没有 activityKind）。
 * **只按 Codex 的词表判**：带 Claude 字段的事件都在本次改动之后写入，不会走到这里。
 * 表与顺序必须与 `codexActivityKind` 逐字一致——`tool` 排在 `mcp` / `subagent` / `search` 之后，
 * 否则 `mcpToolCall` 会被"tool"抢走；parity 测试会拦下任何分叉。
 */
export function legacyActivityKind(itemType: string): ProviderActivityKind {
  const value = itemType.trim().toLowerCase();
  const table: Array<[ProviderActivityKind, readonly string[]]> = [
    ["mcp", ["mcp"]],
    ["subagent", ["collab", "subagent"]],
    ["search", ["websearch", "web_search"]],
    ["media", ["imagegeneration", "image_generation"]],
    ["command", ["command", "exec"]],
    ["file-change", ["file", "patch"]],
    ["reasoning", ["reason"]],
    ["message", ["message", "plan"]],
    ["hook", ["hook"]],
    ["compaction", ["compact"]],
    ["task", ["task"]],
    ["rate-limit", ["ratelimit", "rate_limit"]],
    ["retry", ["retry"]],
    ["permission", ["permission", "approval"]],
    ["warning", ["warning", "deprecation", "notice"]],
    ["review", ["review"]],
    ["session", ["session"]],
    ["tool", ["tool", "imageview"]],
  ];
  for (const [kind, needles] of table) {
    if (needles.some((needle) => value.includes(needle))) return kind;
  }
  return "other";
}

/**
 * 老 journal 事件的成败兜底。**与领域实现同一张词表**，包括两条关键修正：
 * Codex 的 `completed` 就是成功——曾经成功白名单只有 success|succeeded，于是成功的调用
 * 全被显示成"状态未知"；以及 `declined` 就是失败——那是 Codex 明确拒绝掉一条命令的说法，
 * 落到"按阶段回落"会被显示成状态未知，而"被拒"与"没记录到"是两句完全不同的话。
 *
 * 没有成败概念的类别返回 not-applicable（UI 不再给它们挂状态标签）——**表与领域的
 * `OUTCOME_FREE_KINDS` 逐字一致**，parity 测试会拦下漂移。
 */
export function legacyActivityOutcome(input: {
  kind: ProviderActivityKind;
  phase: "started" | "completed";
  status?: string | undefined;
  reason?: string | undefined;
}): ProviderActivityOutcome {
  if (OUTCOME_FREE_ACTIVITY_KINDS.has(input.kind)) return "not-applicable";
  const status = input.status?.trim().toLowerCase();
  if (
    input.reason ||
    status === "failed" ||
    status === "error" ||
    status === "denied" ||
    status === "declined" ||
    status === "cancelled" ||
    status === "canceled"
  )
    return "failed";
  if (status === "success" || status === "succeeded" || status === "completed" || status === "complete") return "succeeded";
  return input.phase === "started" ? "running" : "unknown";
}

/** 没有成败概念的类别；与领域侧 `OUTCOME_FREE_KINDS` 逐字一致。 */
const OUTCOME_FREE_ACTIVITY_KINDS: ReadonlySet<ProviderActivityKind> = new Set([
  "reasoning",
  "message",
  "session",
  "compaction",
  "rate-limit",
  "retry",
  "warning",
  "review",
]);

function readActivityKind(value: unknown, itemType: string | undefined): ProviderActivityKind {
  return isActivityKind(value) ? value : legacyActivityKind(itemType ?? "");
}

function readActivityOutcome(
  value: unknown,
  fallback: { kind: ProviderActivityKind; phase: "started" | "completed"; status?: string | undefined; reason?: string | undefined },
): ProviderActivityOutcome {
  return isActivityOutcome(value) ? value : legacyActivityOutcome(fallback);
}

/** 中立成败 → 条目的展示状态。`not-applicable` 落到 INFO，模板据此**不渲染状态标签**。 */
function outcomeToItemStatus(outcome: ProviderActivityOutcome): ExecutionStreamItem["status"] {
  if (outcome === "not-applicable") return "INFO";
  if (outcome === "running") return "RUNNING";
  if (outcome === "succeeded") return "COMPLETED";
  if (outcome === "failed") return "FAILED";
  return "UNKNOWN";
}

function activityOutcomeDetail(outcome: ProviderActivityOutcome): string {
  // 中文、说人话。此前是 "Provider reported success" / "Provider activity started" ——
  // 那是 Provider 的机械话，读起来像日志，不像"它刚才做了什么"。
  if (outcome === "running") return "执行中";
  if (outcome === "succeeded") return "执行成功";
  if (outcome === "failed") return "执行失败";
  // 没有成败概念的活动不编一句状态文案——它本来就没有状态可报。
  if (outcome === "not-applicable") return "";
  return "结束状态未记录";
}

/** 标题里放不下整条命令，截断到可读长度；完整内容仍可在那条活动上展开。 */
function truncateSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const single = summary.replaceAll(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length > 80 ? `${single.slice(0, 79)}…` : single;
}

/**
 * 把 Provider 的英文诊断翻成人话。**只在显示层做**：journal 里保留原文（那是审计事实），
 * 认不出来的形状原样返回——宁可显示英文，也不要猜错意思。
 */
function localizeProviderReason(reason: string): string {
  const exitCode = /exited with code (\d+)/i.exec(reason);
  if (exitCode?.[1]) return `命令退出码 ${exitCode[1]}`;
  return reason;
}

/**
 * 从 journal 载荷里搬出**结构化字段**（工具参数、返回、命令输出、退出码、耗时）。
 * **取不到的键不写**——`undefined` 是"Provider 没给"，空串是"Provider 说这里什么都没有"，
 * 两者在界面上该长得不一样（前者不摆那一格）。
 *
 * 这里**不做脱敏也不做截断**：那是展示边界的事（`utils/sensitiveValue.ts`）。
 * 在投影里抹掉，"展开看结果"就永远看不到东西，而排障恰恰要的是全量。
 */
function structuredFields(payload: ExecutionJournalPayload): Partial<ExecutionStreamItem> {
  const fields: Partial<ExecutionStreamItem> = {};
  if (payload.phase === "commentary" || payload.phase === "final_answer") fields.phase = payload.phase;
  if (payload.arguments !== undefined) fields.arguments = payload.arguments;
  if (payload.result !== undefined) fields.result = payload.result;
  if (typeof payload.output === "string") fields.output = payload.output;
  if (typeof payload.exitCode === "number") fields.exitCode = payload.exitCode;
  if (typeof payload.durationMs === "number") fields.durationMs = payload.durationMs;
  return fields;
}

function projectProviderActivity(
  entry: ExecutionJournalEntry,
  taskId: string | undefined,
  modelStep: number | undefined,
  loopId: string | undefined,
): ExecutionStreamItem {
  const payload = entry.payload;
  const itemType = stringValue(payload.itemType);
  const providerItemId = stringValue(payload.providerItemId) ?? stringValue(payload.itemId);
  const serverName = stringValue(payload.serverName);
  const toolName = stringValue(payload.toolName);
  const reason = stringValue(payload.reason);
  const phase = payload.phase === "completed" ? "completed" : "started";
  const providerStatus = stringValue(payload.providerStatus)?.toLowerCase();
  // 中立词表由 gateway 翻译后写进 journal。**消费方不再拿 itemType / providerStatus 判断语义**：
  // 那两个是 Provider 的原生词（Codex 用 completed 表示成功、Claude 用 succeeded），照它们判断
  // 正是"343 条状态未知、0 条成功"的成因。
  const activityKind = readActivityKind(payload.activityKind, itemType);
  const outcome = readActivityOutcome(payload.outcome, { kind: activityKind, phase, status: providerStatus, reason });
  // `tool` / `mcp` 之外的 ③ 类（子代理、联网搜索、生成图片）同样是"一次调用"：它们和工具一样
  // 有身份键、会被按身份合并，所以一起进 `callId` 的账。
  const toolLike =
    activityKind === "tool" ||
    activityKind === "mcp" ||
    activityKind === "subagent" ||
    activityKind === "search" ||
    activityKind === "media";
  const messageType = ACTIVITY_MESSAGE_TYPES[activityKind];
  const status = outcomeToItemStatus(outcome);
  const category = ACTIVITY_KIND_LABELS[activityKind];
  // 推理是**背景音**，不是"一次调用的名字"：它的正文归 `content`（可折叠的推理卡读它），
  // 标题只留标签。此前它整段被塞进 title 并被截断，展开也看不到全文。
  const isReasoning = activityKind === "reasoning";
  const name = isReasoning
    ? undefined
    : toolName
      ? `${serverName ? `${serverName}/` : ""}${toolName}`
      : (serverName ?? truncateSummary(stringValue(payload.summary)));
  const detail = reason ? localizeProviderReason(reason) : activityOutcomeDetail(outcome);
  const missing: string[] = [];
  if (!providerItemId) missing.push("Provider 调用标识未记录");
  if (!itemType) missing.push("Provider 活动类型未记录");
  // 只有"本该有成败却拿不到"才值得标注；`not-applicable`（推理流 / 消息 / 会话）不该被标。
  if (outcome === "unknown") missing.push("调用结束状态未记录");
  return {
    id: providerItemId ? `execution-provider-${providerItemId}` : `execution-provider-missing-${entry.sequence}`,
    role: "system",
    title: name ? `${category} · ${name}` : category,
    content: isReasoning ? (stringValue(payload.summary) ?? "") : "",
    detail,
    messageType,
    kind: executionRowKind(messageType),
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    activityKind,
    outcome,
    // **这一动作到底做了什么**：参数、返回、命令输出、退出码、耗时。展示前过脱敏与截断
    // （`utils/sensitiveValue.ts`）；这里只做"有没有值"的搬运。
    ...structuredFields(payload),
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(toolLike && providerItemId ? { callId: providerItemId, source: "provider" as const } : {}),
    ...(serverName ? { serverName } : {}),
    ...(stringValue(payload.providerThreadId) ? { providerThreadId: stringValue(payload.providerThreadId) } : {}),
    ...(stringValue(payload.providerTurnId) ? { providerTurnId: stringValue(payload.providerTurnId) } : {}),
    ...(missing.length ? { unrecordedFields: missing } : {}),
  };
}

function projectExecutionActivity(
  entry: ExecutionJournalEntry,
  taskId?: string,
  modelStep?: number,
  loopId?: string,
): ExecutionStreamItem | null {
  const payload = entry.payload;
  const association = {
    ...(taskId ? { taskId } : {}),
    ...(modelStep === undefined ? {} : { modelStep }),
    ...(loopId ? { loopId } : {}),
  };
  if (entry.type === "USER_GUIDANCE") {
    const delivery = payload.delivery === "STEER" || payload.delivery === "QUEUE" ? payload.delivery : undefined;
    return {
      id: `execution-guidance-${entry.sequence}`,
      kind: "user",
      role: "user",
      title: "你补充了要求",
      content: stringValue(payload.content) ?? "",
      detail: "",
      status: "COMPLETED",
      occurredAt: entry.occurredAt,
      sequence: entry.sequence,
      messageType: "USER_MESSAGE",
      ...(delivery ? { guidanceDelivery: delivery } : {}),
      ...association,
    };
  }
  if (entry.type === "RUN_CREATED")
    return activity(
      entry,
      "Run 已创建",
      `Plan ${stringValue(payload.planId) ?? "未记录"} · Revision ${stringValue(payload.revision) ?? "—"}`,
      "INFO",
      association,
    );
  if (entry.type === "HOOK_SKIPPED")
    return activity(entry, "已跳过生命周期钩子", stringValue(payload.hook) ?? "钩子名未记录", "INFO", association);
  if (entry.type === "HOOK_COMPLETED")
    return activity(entry, "生命周期钩子已完成", stringValue(payload.hook) ?? "生命周期钩子", "COMPLETED", association);
  if (entry.type === "HOOK_FAILED")
    return activity(
      entry,
      "生命周期钩子失败",
      stringValue(payload.stderr) ?? stringValue(payload.hook) ?? "钩子失败原因未记录",
      "FAILED",
      association,
    );
  if (entry.type === "VERIFICATION") {
    const status = stringValue(payload.status);
    const reason = stringValue(payload.reason);
    return activity(
      entry,
      "验证",
      reason ?? VERIFICATION_STATUS_LABELS[status ?? ""] ?? "未记录",
      status === "PASSED" ? "COMPLETED" : status === "SKIPPED" ? "INFO" : "FAILED",
      association,
    );
  }
  if (entry.type === "RECOVERY")
    return activity(entry, "需要恢复", stringValue(payload.reason) ?? stringValue(payload.error) ?? "阻塞原因未记录", "FAILED", {
      ...association,
      messageType: "RECOVERY",
    });
  if (entry.type === "TASK_PROGRESS") {
    const state = stringValue(payload.state);
    // 阻塞与取消是**异常**：无论呈现方式怎么调，它们都要显眼。
    if (state === "BLOCKED")
      return activity(entry, "Run 已阻塞", stringValue(payload.reason) ?? "阻塞原因未记录", "FAILED", {
        ...association,
        messageType: "RECOVERY",
      });
    if (state === "CANCELLED")
      return activity(entry, "Run 已取消", stringValue(payload.reason) ?? "已取消", "FAILED", { ...association, messageType: "RECOVERY" });
    if (payload.action === "task-status") return null;
    const event = stringValue(payload.event) ?? "";
    if (event === "continue") return null;
    // 续跑检查点。**新旧两个名字都认**：老 Run 的 journal 里存的还是旧名
    // （`agent.context.compacted`，库里几十条），而那个名字是错的——它从没压缩过任何东西，
    // 只是"这一轮跑完、Factory 让接着做下一项"之前打的 checkpoint。
    if (event === "agent.loop.checkpointed" || event === "agent.context.compacted")
      return activity(entry, "续跑检查点", "已保存检查点，继续下一轮", "INFO", { ...association, messageType: "CONTEXT" });
    if (event === "agent.gate.checked")
      return activity(
        entry,
        "执行门禁",
        `${gateActionLabel(payload.action)}${stringValue(payload.reason) ? ` · ${stringValue(payload.reason)}` : ""}`,
        payload.action === "blocked" ? "FAILED" : "INFO",
        { ...association, messageType: "GATE" },
      );
    if (event === "agent.loop.created" || payload.action === "executor_loop_created")
      return activity(entry, "Executor 已启动", stringValue(payload.loopId) ?? "", "RUNNING", {
        ...association,
        messageType: "TURN_STATUS",
      });
    if (payload.action === "legacy_plan_revision")
      return activity(entry, "旧版 Plan 修订", stringValue(payload.reason) ?? "使用旧版运行时配置", "INFO", {
        ...association,
        messageType: "CONTEXT",
      });
    if (payload.action === "paused") return activity(entry, "执行已暂停", "等待恢复", "WAITING", { ...association, messageType: "GATE" });
    if (payload.action === "resumed") return activity(entry, "执行已恢复", "", "RUNNING", { ...association, messageType: "GATE" });
    if (["agent.model.completed", "agent.step.started"].includes(event)) return null;
    return activity(entry, "执行活动", event || stringValue(payload.reason) || stringValue(payload.action) || "活动详情未记录", "INFO", {
      ...association,
      messageType: "UNCLASSIFIED",
    });
  }
  if (["MODEL_OUTPUT", "PROVIDER_ACTIVITY", "TOOL_CALL"].includes(entry.type)) return null;
  return activity(entry, entry.type.replaceAll("_", " "), "未记录可展示的执行摘要。", "UNKNOWN", {
    ...association,
    messageType: "UNCLASSIFIED",
    unrecordedFields: ["执行摘要未记录"],
  });
}

function activity(
  entry: ExecutionJournalEntry,
  title: string,
  detail: string,
  status: ExecutionStreamItem["status"],
  metadata: Partial<ExecutionStreamItem> = {},
): ExecutionStreamItem {
  // 默认按 Run 级活动处理（创建、钩子、验证）；其余类别由调用点通过 metadata 覆盖。
  // **形态跟着消息类型走**：`CONTEXT` 是分隔线、其余是活动行——形态只有一个来源（`KIND_BY_MESSAGE_TYPE`），
  // 调用点不必、也不该自己重复一遍。
  const messageType = metadata.messageType ?? "RUN_ACTIVITY";
  return {
    id: `execution-activity-${entry.sequence}`,
    role: "system",
    title,
    content: "",
    detail,
    status,
    occurredAt: entry.occurredAt,
    sequence: entry.sequence,
    ...metadata,
    kind: metadata.kind ?? executionRowKind(messageType),
    messageType,
  };
}

function taskTitle(plan: ExecutionPlanSnapshot | undefined, taskId: string): string {
  const task = plan?.tasks.find((candidate) => candidate.id === taskId);
  return task?.title ?? taskId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 完成报告末尾那行"完成了几个任务、改了几个文件"。**它是被解析的**：
 * `sameReportProgress` 靠匹配这行的两个数字判断"这次报告与上次是不是同一个进度"，
 * 从而把重复报告合并成一条。改这里的措辞就要同步改那里的正则，否则合并会静默失效。
 */
function reportProgressSummary(completedTasks: number, changedPaths: number): string {
  return `已完成 ${completedTasks} 个任务 · 改动 ${changedPaths} 个文件`;
}

const REPORT_PROGRESS_PATTERN = /已完成 (\d+) 个任务 · 改动 (\d+) 个文件$/;

function sameReportProgress(previous: string, next: string): boolean {
  const progress = (value: string) => value.match(REPORT_PROGRESS_PATTERN)?.slice(1).join(":") ?? null;
  return progress(previous) !== null && progress(previous) === progress(next);
}

/**
 * 把模型输出拆成标题与正文。
 * `report` 是**判别标志**而不是靠标题字符串判断（此前调用方写的是 `display.title === "Executor report"`，
 * 改一个标题文案就会静默失效）。
 */
function humanizeModelOutput(content: string): { title: string; body: string; report: boolean } | null {
  content = stripTaskProgressMarkers(content);
  const startMarker = "<pipeline-factory-execution-report>";
  const endMarker = "</pipeline-factory-execution-report>";
  const start = content.lastIndexOf(startMarker);
  // 普通正文。标题写「执行说明」而不是角色名「Executor」——角色名不告诉读者任何内容，
  // 而这张卡片里放的正是"Executor 在做什么、发现了什么"。
  if (start < 0) return { title: "执行说明", body: content, report: false };
  const jsonStart = start + startMarker.length;
  const end = content.indexOf(endMarker, jsonStart);
  if (end < 0) return { title: "执行报告", body: content.slice(0, start).trim() || "执行报告仍在生成中。", report: true };
  try {
    const report = JSON.parse(content.slice(jsonStart, end).trim()) as {
      completedTaskIds?: unknown;
      changedPaths?: unknown;
      report?: unknown;
    };
    const completed = Array.isArray(report.completedTaskIds)
      ? report.completedTaskIds.filter((id): id is string => typeof id === "string")
      : [];
    const changedPaths = Array.isArray(report.changedPaths)
      ? report.changedPaths.filter((path): path is string => typeof path === "string")
      : [];
    const summary = typeof report.report === "string" ? report.report : "执行报告已记录。";
    return { title: "执行报告", body: `${summary}\n\n${reportProgressSummary(completed.length, changedPaths.length)}`, report: true };
  } catch {
    return { title: "执行报告", body: content.slice(0, start).trim() || "执行报告无法解析。", report: true };
  }
}

function stripTaskProgressMarkers(content: string): string {
  const startMarker = "<pipeline-factory-task-progress>";
  const endMarker = "</pipeline-factory-task-progress>";
  let visible = content.replace(/<pipeline-factory-task-progress>[\s\S]*?<\/pipeline-factory-task-progress>/g, "");
  const incompleteStart = visible.lastIndexOf(startMarker);
  if (incompleteStart >= 0 && visible.indexOf(endMarker, incompleteStart) < 0) visible = visible.slice(0, incompleteStart);
  for (let length = Math.min(startMarker.length - 1, visible.length); length > 0; length -= 1) {
    if (visible.endsWith(startMarker.slice(0, length))) {
      visible = visible.slice(0, -length);
      break;
    }
  }
  // **开头是残留的标记尾巴**：标记跨了两条事件——上一条的尾巴被上面的规则削掉，剩下的一半就落在
  // 这一条的开头（实见：正文第一行直接铺着 `-progress>{"taskId":"task-1","state":"started"}`）。
  // 上面三条规则只管"结尾"，管不到这种情况。
  // 判据：开头到第一个 `<` 为止的这一截，**以标记的某一段后缀打头**。正常正文几乎不可能命中。
  const firstTagIndex = visible.indexOf("<");
  const head = visible.slice(0, firstTagIndex === -1 ? visible.length : firstTagIndex);
  const fragmentLength = markerFragmentLength(head);
  if (fragmentLength > 0) {
    const afterFragment = head.slice(fragmentLength);
    const rest = visible.slice(head.length);
    // 尾巴后面跟的是标记自带的载荷（JSON，或什么都不剩）→ 连同可能的闭合标记一起去掉；
    // 跟的是正文（实测：`factory-task-progress>` 后直接接"开始执行 task-1…"）→ 只削掉那段尾巴。
    // 两种都得处理：只认"尾巴+JSON"会漏掉后者，而后者正是正文里最扎眼的一行。
    const payloadLike = afterFragment.trim() === "" || afterFragment.trim().startsWith("{");
    if (payloadLike) visible = rest.startsWith(endMarker) ? rest.slice(endMarker.length) : rest;
    else visible = `${afterFragment}${rest}`;
  }
  return visible;
}

/** `head` 开头有多少个字符是任务标记的一段后缀；没有则返回 0。 */
function markerFragmentLength(head: string): number {
  const marker = "<pipeline-factory-task-progress>";
  for (let length = Math.min(head.length, marker.length - 1); length > 0; length -= 1) {
    if (marker.endsWith(head.slice(0, length))) return length;
  }
  return 0;
}
