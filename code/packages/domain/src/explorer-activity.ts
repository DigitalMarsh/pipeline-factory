/**
 * 模块职责：定义 Explorer 活动事件及其面向消息流的投影。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { AgentLoop, AgentLoopStep } from "./agent-loop.js";
import type { ExplorerTurn } from "./index.js";

/** Explorer 时间线中的消息、工具、Plan 和状态事件类型。 */
export type ExplorerActivityKind =
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "REASONING_SUMMARY"
  | "INPUT_REQUIRED"
  | "INPUT_RESOLVED"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TOOL_DENIED"
  | "MCP_ACTIVITY"
  | "CONTEXT_COMPACTED"
  | "GATE_CHECKED"
  | "TURN_STATUS";

/** 前端可直接渲染的 Explorer 活动项，保留来源事实以支持定位。 */
export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING";
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

type PlanActivityDisplay = {
  summary: string;
  details: Record<string, unknown> | null;
};

const STATUS_TAG = /<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/gi;
const PLAN_TAG = /<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/gi;
const STATUS_OPEN_TAG = /<pipeline-factory-plan-status>/i;
const PLAN_OPEN_TAG = /<pipeline-factory-plan>/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countArray(record: Record<string, unknown>, key: string): number {
  return Array.isArray(record[key]) ? record[key].length : 0;
}

function stripPlanProtocol(content: string): string {
  return content
    .replace(/<pipeline-factory-plan-status>[\s\S]*?<\/pipeline-factory-plan-status>/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*?<\/pipeline-factory-plan>/gi, "")
    .replace(/<pipeline-factory-plan-status>[\s\S]*$/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*$/gi, "")
    .trim();
}

function formatPlanActivity(content: string): PlanActivityDisplay {
  const hasProtocol = STATUS_OPEN_TAG.test(content) || PLAN_OPEN_TAG.test(content);
  if (!hasProtocol) return { summary: content, details: null };

  const prose = stripPlanProtocol(content);
  const candidates = planProtocolCandidates(content);
  const displayable = [...candidates].reverse().find((candidate) => candidate.status === "READY" && parsePlanArtifact(candidate.artifactText));
  const latest = candidates.at(-1);
  if (displayable) {
    const parsed = parsePlanArtifact(displayable.artifactText)!;
    return {
      summary: [prose, `完整执行方案已生成：${parsed.title}`].filter(Boolean).join(" "),
      details: {
        planProtocol: true,
        status: "READY",
        title: parsed.title,
        goal: parsed.goal,
        includeCount: countArray(parsed, "include"),
        excludeCount: countArray(parsed, "exclude"),
        taskCount: countArray(parsed, "tasks"),
        acceptanceCount: countArray(parsed, "acceptanceCriteria"),
        verificationCount: countArray(parsed, "verificationCommandIds"),
      },
    };
  }
  if (latest?.status !== "READY" || !latest.artifactText) {
    return { summary: [prose, "正在整理结构化计划…"].filter(Boolean).join(" "), details: { planProtocol: true, status: "GENERATING" } };
  }

  return { summary: [prose, "结构化计划校验失败，请继续完善。"].filter(Boolean).join(" "), details: { planProtocol: true, status: "INVALID" } };
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
    return isRecord(parsed) && typeof parsed.title === "string" && typeof parsed.goal === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** 把 Turn、Loop Step 和 Provider activity 合并为稳定排序的 Explorer 消息流。 */
export function projectExplorerActivity(input: ExplorerActivityInput): ExplorerActivityItem[] {
  const loopByOwner = new Map(input.loops.map((loop) => [loop.ownerId, loop]));
  const result: ActivityWithOrder[] = [];
  let order = 0;
  const append = (item: Omit<ExplorerActivityItem, "id" | "sequence">, stableSequence: number): void => {
    result.push({ ...item, id: `activity-${item.turnId}-${stableSequence}-${result.length}`, sequence: result.length + 1, order: order++ });
  };

  // Turn 是对话主序列，Loop Step 只补充模型推理、工具和门禁活动；最终序号按发生时间重新归一化。
  for (const turn of [...input.turns].sort((a, b) => a.sequence - b.sequence)) {
    if (turn.role === "user") {
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "USER_MESSAGE", status: "COMPLETED", title: "You", summary: turn.content, details: null, occurredAt: turn.createdAt }, turn.sequence);
      continue;
    }

    const loop = loopByOwner.get(turn.id);
    const steps = input.steps.filter((step) => step.loopId === loop?.id).sort((a, b) => a.sequence - b.sequence);
    let assistantText = "";
    let assistantSequence = turn.sequence;
    for (const step of steps) {
      const payload = step.payload;
      if (step.stepType === "MODEL_TEXT_DELTA") {
        const text = typeof payload.text === "string" ? payload.text : "";
        assistantText += text;
        assistantSequence = step.sequence;
        const previous = result.at(-1);
        if (previous?.kind === "ASSISTANT_MESSAGE" && previous.turnId === turn.id) {
          previous.summary += text;
          continue;
        }
        append({ explorerId: turn.threadId, turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: "RUNNING", title: "Plan Explorer", summary: text, details: null, occurredAt: step.occurredAt }, step.sequence);
        continue;
      }
      if (step.stepType === "PROVIDER_ACTIVITY") {
        const providerActivity = activityFromStep(turn, step);
        if (providerActivity) append(providerActivity, step.sequence);
        continue;
      }
      const activity = activityFromStep(turn, step);
      if (activity) append(activity, step.sequence);
    }
    for (const item of result) {
      if (item.turnId !== turn.id || item.kind !== "ASSISTANT_MESSAGE") continue;
      const display = formatPlanActivity(item.summary);
      item.summary = display.summary;
      item.details = display.details;
    }
    if (!assistantText && turn.content.trim()) {
      const display = formatPlanActivity(turn.content);
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "ASSISTANT_MESSAGE", status: turn.status === "FAILED" ? "FAILED" : "COMPLETED", title: "Plan Explorer", summary: display.summary, details: turn.error ? { error: turn.error, ...(display.details ?? {}) } : display.details, occurredAt: turn.createdAt }, assistantSequence);
    }
    if (!steps.length && !turn.content.trim()) {
      append({ explorerId: turn.threadId, turnId: turn.id, kind: "TURN_STATUS", status: turn.status === "WAITING_FOR_INPUT" ? "WAITING" : turn.status === "FAILED" ? "FAILED" : "RUNNING", title: "Plan Explorer", summary: turn.status === "WAITING_FOR_INPUT" ? "Waiting for input" : "Plan Explorer is processing", details: turn.error ? { error: turn.error } : null, occurredAt: turn.createdAt }, turn.sequence);
    }
  }

  return result
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.order - b.order)
    .map(({ order: _order, ...item }, index) => ({ ...item, sequence: index + 1 }));
}

function activityFromStep(turn: ExplorerTurn, step: AgentLoopStep): Omit<ExplorerActivityItem, "id" | "sequence"> | null {
  const payload = step.payload;
  const base = { explorerId: turn.threadId, turnId: turn.id, occurredAt: step.occurredAt };
  if (step.stepType === "PROVIDER_ACTIVITY") {
    const itemType = typeof payload.itemType === "string" ? payload.itemType : "provider-item";
    const phase = payload.phase === "completed" ? "completed" : "started";
    const kind = itemType.toLowerCase().includes("mcp") ? "MCP_ACTIVITY" : itemType.toLowerCase().includes("reason") ? "REASONING_SUMMARY" : phase === "completed" ? "TOOL_COMPLETED" : "TOOL_STARTED";
    return { ...base, kind, status: phase === "completed" ? "COMPLETED" : "RUNNING", title: typeof payload.title === "string" && payload.title.trim() ? payload.title : itemType, summary: typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.slice(0, 240) : phase === "completed" ? "Provider activity completed." : "Provider activity started.", details: { itemId: payload.itemId ?? null, itemType, providerControlled: true } };
  }
  if (step.stepType === "MODEL_STARTED") return { ...base, kind: "REASONING_SUMMARY", status: "RUNNING", title: "Analyzing", summary: `Plan Explorer started step ${String(payload.step ?? step.sequence)}.`, details: null };
  if (step.stepType === "INPUT_REQUIRED") return { ...base, kind: "INPUT_REQUIRED", status: "WAITING", title: "Input required", summary: `${Array.isArray(payload.questions) ? payload.questions.length : 0} structured question(s) are waiting.`, details: { requestId: payload.requestId ?? null, isBlocking: payload.isBlocking ?? true } };
  if (step.stepType === "INPUT_RESOLVED") return { ...base, kind: "INPUT_RESOLVED", status: "COMPLETED", title: "Input resolved", summary: "Your selection was submitted; the same turn is continuing.", details: { requestId: payload.requestId ?? null, answerCount: payload.answerCount ?? 0 } };
  if (step.stepType === "TOOL_REQUESTED") return { ...base, kind: "TOOL_STARTED", status: "RUNNING", title: "Tool running", summary: typeof payload.tool === "string" ? payload.tool : "Provider tool", details: { tool: payload.tool ?? "provider", callId: step.callId } };
  if (step.stepType === "TOOL_COMPLETED") return { ...base, kind: "TOOL_COMPLETED", status: "COMPLETED", title: "Tool completed", summary: "The tool returned a result.", details: { callId: step.callId, reason: payload.reason ?? null } };
  if (step.stepType === "TOOL_DENIED") return { ...base, kind: "TOOL_DENIED", status: "FAILED", title: "Tool denied", summary: typeof payload.reason === "string" ? payload.reason : "The tool request was denied by policy.", details: { callId: step.callId } };
  if (step.stepType === "CONTEXT_COMPACTED") return { ...base, kind: "CONTEXT_COMPACTED", status: "COMPLETED", title: "Context checkpointed", summary: "The loop saved a checkpoint before continuing.", details: { messageCount: payload.messageCount ?? null } };
  if (step.stepType === "GATE_CHECKED") return { ...base, kind: "GATE_CHECKED", status: payload.action === "blocked" ? "FAILED" : "COMPLETED", title: "Gate checked", summary: typeof payload.reason === "string" ? payload.reason : "The termination gate evaluated this step.", details: { action: payload.action ?? null } };
  if (step.stepType === "MODEL_COMPLETED") return { ...base, kind: "TURN_STATUS", status: "COMPLETED", title: "Model step completed", summary: "The model step completed.", details: null };
  return null;
}
