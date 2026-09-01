/** 审计持久化前的最小脱敏规则；领域消息正文不在此处改写。 */
const SENSITIVE_KEY = /(?:secret|token|cookie|password|passwd|api[_-]?key|authorization|email|phone|address|personal|pii)/i;
const SENSITIVE_ASSIGNMENT = /\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对审计 payload 做递归字段和值脱敏，保留状态、计数和结构信息。 */
export function redactAuditPayload(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

/** 对 Hook/命令输出做不改变普通文本的秘密和邮箱脱敏。 */
export function redactAuditText(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`).replace(EMAIL, "[REDACTED_EMAIL]");
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactAuditText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]));
  return value;
}
