/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 * 补充：`readableAssistantText` 是从 `ExplorerView.vue` 下沉来的（P7-4）。
 * 它内部那句 `display.kind === "plain" ? display.text : display.text` 的两个分支
 * 是**同一个值**，看着像笔误。**不要"顺手修好"**——本批下沉的判据是行为零变化，
 * 清理等价代码属于后续可选收尾。要合并请单独提交并说明为什么两个分支曾不同。
 */
export type PlanProtocolDisplay =
  | { kind: "plain"; text: string }
  | { kind: "generating"; text: string }
  | {
      kind: "ready";
      prose: string;
      title: string;
      goal: string;
      includeCount: number;
      excludeCount: number;
      taskCount: number;
      acceptanceCount: number;
      verificationCount: number;
    }
  | { kind: "invalid"; text: string };

type JsonRecord = Record<string, unknown>;

const STATUS_TAG = /<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/i;
const PLAN_TAG = /<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/i;
const STATUS_OPEN_TAG = /<pipeline-factory-plan-status>/i;
const PLAN_OPEN_TAG = /<pipeline-factory-plan>/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** 数组长度；键不存在或不是数组时返回 undefined（调用方据此回落到另一种形状）。 */
function countAt(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

/** 界面要从一份 Plan 契约里取的摘要字段。 */
type PlanSummary = { title: string; goal: string; includeCount: number; excludeCount: number; taskCount: number; acceptanceCount: number; verificationCount: number };

/**
 * 从 Plan 契约里取摘要，**同时认两种形状**：
 * - **当前形状**：`objective.goal` / `scope.includePaths` / `scope.excludePaths` /
 *   `objective.acceptanceCriteria` / `verification.commandIds`；
 * - **V1（历史消息）**：顶层 `goal` / `include` / `exclude` / `acceptanceCriteria` / `verificationCommandIds`。
 *
 * 两种都要认，缺一不可：换成当前形状之前落库的助手文本仍是 V1 形状，只认当前形状会让那些线程的卡片
 * 变成"校验失败"。反过来**只认 V1 就是这里修掉的缺陷**——每一份方案都被判为非法、显示
 * "结构化计划校验失败，请继续完善。"，而同一屏下方紧跟着 "PLAN CREATED" 卡片，页面自相矛盾，
 * 用户会以为模型没做对。判据必须跟着**当前**契约走，历史形状只作兼容。
 *
 * 认不出来返回 null（缺少 title 或 goal，或根本不是对象）。
 */
function summarizePlan(parsed: JsonRecord): PlanSummary | null {
  const objective = isRecord(parsed.objective) ? parsed.objective : undefined;
  const scope = isRecord(parsed.scope) ? parsed.scope : undefined;
  const verification = isRecord(parsed.verification) ? parsed.verification : undefined;

  const title = stringAt(parsed, "title");
  const goal = stringAt(objective, "goal") ?? stringAt(parsed, "goal");
  // 用 undefined 判空（而不是真值判断）：空字符串在旧实现里算合法，这里不改那条语义。
  if (title === undefined || goal === undefined) return null;

  return {
    title,
    goal,
    includeCount: countAt(scope, "includePaths") ?? countAt(parsed, "include") ?? 0,
    excludeCount: countAt(scope, "excludePaths") ?? countAt(parsed, "exclude") ?? 0,
    acceptanceCount: countAt(objective, "acceptanceCriteria") ?? countAt(parsed, "acceptanceCriteria") ?? 0,
    verificationCount: countAt(verification, "commandIds") ?? countAt(parsed, "verificationCommandIds") ?? 0,
    taskCount: countAt(parsed, "tasks") ?? 0,
  };
}

function visibleProse(content: string): string {
  return content
    .replace(/<pipeline-factory-plan-status>[\s\S]*?<\/pipeline-factory-plan-status>/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*?<\/pipeline-factory-plan>/gi, "")
    .replace(/<pipeline-factory-plan-status>[\s\S]*$/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*$/gi, "")
    .trim();
}

function withMessage(prose: string, message: string): string {
  return [prose, message].filter(Boolean).join(" ");
}

/** 解析消息中的 Plan protocol，仅把完整合法协议渲染为可执行方案摘要。 */
export function parsePlanProtocolDisplay(content: string): PlanProtocolDisplay {
  const hasProtocol = STATUS_OPEN_TAG.test(content) || PLAN_OPEN_TAG.test(content);
  if (!hasProtocol) return { kind: "plain", text: content };

  const prose = visibleProse(content);
  const status = content.match(STATUS_TAG)?.[1]?.trim().toUpperCase();
  const artifactText = content.match(PLAN_TAG)?.[1];
  if (status !== "READY" || !artifactText) return { kind: "generating", text: withMessage(prose, "正在整理结构化计划…") };

  let parsed: unknown;
  try {
    parsed = JSON.parse(artifactText);
  } catch {
    return { kind: "invalid", text: withMessage(prose, "结构化计划校验失败，请继续完善。") };
  }
  const summary = isRecord(parsed) ? summarizePlan(parsed) : null;
  if (!summary) return { kind: "invalid", text: withMessage(prose, "结构化计划校验失败，请继续完善。") };

  return { kind: "ready", prose, ...summary };
}

/**
 * 助手消息在界面上的可读文本。
 * `ready` 时把方案标题接在正文后面，其余形态回退到展示对象自己的 `text`
 * （`generating` / `invalid` 已经把提示语拼进了 `text`，`plain` 就是原文）。
 */
export function readableAssistantText(content: string): string {
  const display = parsePlanProtocolDisplay(content);
  if (display.kind === "ready") return [display.prose, `完整执行方案已生成：${display.title}`].filter(Boolean).join(" ");
  return display.kind === "plain" ? display.text : display.text;
}
