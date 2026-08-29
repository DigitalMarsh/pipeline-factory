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

function countArray(record: JsonRecord, key: string): number {
  return Array.isArray(record[key]) ? record[key].length : 0;
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
  if (!isRecord(parsed) || typeof parsed.title !== "string" || typeof parsed.goal !== "string") {
    return { kind: "invalid", text: withMessage(prose, "结构化计划校验失败，请继续完善。") };
  }

  return {
    kind: "ready",
    prose,
    title: parsed.title,
    goal: parsed.goal,
    includeCount: countArray(parsed, "include"),
    excludeCount: countArray(parsed, "exclude"),
    taskCount: countArray(parsed, "tasks"),
    acceptanceCount: countArray(parsed, "acceptanceCriteria"),
    verificationCount: countArray(parsed, "verificationCommandIds"),
  };
}
