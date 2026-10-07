/**
 * 模块职责：把 Provider 的**结构化载荷**（工具参数、工具返回、命令输出、退出码、耗时）
 *   搬过领域边界——它此前一个字段都没进业务层，于是"这条命令到底跑了什么、结果是什么"
 *   在界面上没有原料。
 *
 * 为什么单独一个模块：读它的地方有两处（探索侧的 `explorer/explorer-activity.ts`、
 *   执行侧的 `agent/executor-agent.ts`），而"上限是多少、取不到的键怎么办"必须是同一条规则——
 *   两处各写一份，迟早一处截断一处不截，同一个动作在两个对话框里显示得不一样。
 *
 * 维护提示：
 *   1) **这里只做传输上限，不做脱敏**。脱敏发生在展示边界，用的是
 *      `apps/web/src/utils/sensitiveValue.ts`（与 `platform/redaction.ts` 是一对镜像）。
 *      理由：同一份数据还要给排障与审计读，在这里抹掉就再也拿不回来了。
 *   2) **取不到的键一律不写**：`undefined` 是"Provider 没给"，空串是"Provider 说这里什么都没有"。
 *      两者在界面上该长得不一样（前者不摆那一格，后者摆一个"无输出"）。
 *   3) 超过上限**换成截断后的字符串**，而不是丢弃——宁可显示一段被截断的正文，
 *      也不要一个塞不下的对象把整个活动载荷撑爆。
 */
import { isRecord } from "./guards.js";

/**
 * 结构化载荷的**宽松传输上限**（字符）。展示层还有更紧的一档（2000 字 + 脱敏）——
 * 这一档只保证"一条命令的完整 stdout 不会把响应撑爆"，不是给人读的粒度。
 */
export const PROVIDER_PAYLOAD_LIMIT = 16_000;

/** 超过上限就换成截断后的字符串；序列化不了的值直接不给（宁可少一格，不要一个坏值）。 */
export function boundProviderPayload(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, PROVIDER_PAYLOAD_LIMIT);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && json.length > PROVIDER_PAYLOAD_LIMIT) return `${json.slice(0, PROVIDER_PAYLOAD_LIMIT)}…（已截断）`;
  } catch {
    return undefined;
  }
  return value;
}

/**
 * 从一条 Provider 事件的载荷里挑出结构化字段。
 * 参数与返回用 `boundProviderPayload`（它们可能是对象），输出用字符串截断（它一定是文本）。
 */
export function structuredProviderPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (payload.arguments !== undefined) fields.arguments = boundProviderPayload(payload.arguments);
  if (payload.result !== undefined) fields.result = boundProviderPayload(payload.result);
  if (typeof payload.output === "string" && payload.output) fields.output = payload.output.slice(0, PROVIDER_PAYLOAD_LIMIT);
  if (typeof payload.exitCode === "number") fields.exitCode = payload.exitCode;
  if (typeof payload.durationMs === "number") fields.durationMs = payload.durationMs;
  return fields;
}

/** 这一份结构化载荷里有没有东西可展开。空对象与"没有"是一回事——别为它渲染一个空的展开按钮。 */
export function hasStructuredPayload(fields: Record<string, unknown>): boolean {
  return Object.values(fields).some(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(isRecord(value) && Object.keys(value).length === 0) &&
      !(Array.isArray(value) && value.length === 0),
  );
}
