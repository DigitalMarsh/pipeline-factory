/**
 * 模块职责：**展示边界上的脱敏与截断**——把 Provider 给的原始载荷变成"可以放到屏幕上的一段字"。
 *
 * 为什么必须有这一层：工具参数、工具返回、命令输出现在都可以看了（OpenClaw / Hermes 那种
 *   "展开看结果"），而它们里面可能有令牌、邮箱、带凭据的命令行。**落库与投影都保留原样**，
 *   抹掉发生在最后一次搬运——同一份数据还要给排障与审计读，在写侧抹掉就再也拿不回来了。
 *
 * 与 `packages/domain/src/platform/redaction.ts` 是**一对镜像**，不是重复代码：
 *   web 不能运行时依赖领域层（会把整个领域打进浏览器包），而那边的 `redactAuditText` 是同一个
 *   意图在写侧的实现。`sensitiveValue.test.ts` 用同一批样例断言两边结论一致——改一边必须改另一边。
 *
 * 维护提示：
 *   1) 规则只增不改：新增一类敏感值先加在这里**和** `redaction.ts`，两边同时生效才算数。
 *   2) 截断发生在脱敏**之后**：先截断再脱敏，会把"半个令牌 + 半个正文"拼成一段新的、
 *      规则认不出来的东西。
 *   3) 它不是安全边界：真正的秘密不该进 journal。这一层防的是"手滑看了一眼不该看的"，
 *      不是"有人恶意注入"。
 */

/** 一行最多显示多少字。够长到能看清一段输出，短到不会把整屏铺满。 */
export const DISPLAY_TEXT_LIMIT = 2_000;

/** 与 `platform/redaction.ts` 的 `SENSITIVE_ASSIGNMENT` / `BEARER` / `EMAIL` 逐字一致。 */
const SENSITIVE_ASSIGNMENT = /\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** 保住键名、抹掉值——"这里有令牌"这个事实本身是有用的，"令牌是什么"不是。 */
export function redactSensitiveValue(value: string): string {
  return value
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
    .replace(EMAIL, "[REDACTED_EMAIL]");
}

/** 超长就截断，并**如实说明截了多少**——"这里还有下文"和"这就是全部"是两件事。 */
export function truncateForDisplay(value: string, limit = DISPLAY_TEXT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（共 ${value.length} 字，已截断）`;
}

/** 脱敏 + 截断，按这个顺序（见模块头 2）。 */
export function presentableText(value: string, limit = DISPLAY_TEXT_LIMIT): string {
  return truncateForDisplay(redactSensitiveValue(value), limit);
}

/** 结构化值（参数、返回）→ 可展示的一段文本。对象走 JSON，缩进两格以便读。 */
export function presentableValue(value: unknown, limit = DISPLAY_TEXT_LIMIT): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() ? presentableText(value, limit) : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined || json === "{}" || json === "[]" || json === '""') return null;
    return presentableText(json, limit);
  } catch {
    // 序列化不了（循环引用等）就不是可展示的东西——宁可少一格，不要一个 "undefined"。
    return null;
  }
}

/** 一次动作的载荷里可能带的东西。行组件按它决定要不要摆那个「结果」按钮。 */
export type ActivityPayload = {
  arguments?: unknown;
  result?: unknown;
  output?: string | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
};

/**
 * 这一动作有没有**值得展开**的东西。没有就不该出现那个按钮——
 * 一个点开只有"（空）"的展开区，比没有更糟。
 */
export function hasActivityPayload(source: ActivityPayload): boolean {
  if (presentableValue(source.arguments) || presentableValue(source.result) || presentableValue(source.output)) return true;
  return source.exitCode !== undefined || source.durationMs !== undefined;
}
