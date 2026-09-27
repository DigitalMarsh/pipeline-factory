/**
 * 模块职责：存储记录的默认值、反序列化与正文规范化——"一条记录在落库前长什么样、
 *   从库里读回来怎么还原"这件事的唯一出处。
 *
 * 为什么从 index.ts 抽出来：这些函数同时被 InMemoryPipelineStore、SqlitePipelineStore 与
 *   index.ts 里的 ExplorerService / ExplorerThreadService 使用。调用方跨越"要被搬走的 store"
 *   与"留在 index.ts 的 service"两侧，若让 store 反向从 index.js 导入就必然引出一条新的值级
 *   回流边。它们是零 index 值依赖的（只吃 unknown/普通对象，类型 import 会被 tsc 擦除），
 *   因此可以整体成为叶子模块。
 *
 * 维护提示：
 *   1) **默认值即迁移策略**。defaultThreadContextSummary 固定 version: 1，parseThreadContextSummary
 *      对 version !== 1 的输入直接回落默认值——这是"旧数据读不出来就重置"的取舍，不是 bug。
 *      改成抛错会让老库在升级后完全打不开。
 *   2) 反序列化函数一律**不抛错**（JSON.parse 包在 try 里，形状不符就返回默认值/空数组）。
 *      库里存的是历史写入的 JSON，任何一次格式演进都会留下读不出来的行；
 *      在这里抛错等于让一行坏数据把整张表读崩。
 *   3) defaultExplorerPlan 的 title/titleStatus 是**占位值**（"Plan N / 待探索" / PLACEHOLDER），
 *      真正的标题由 ModelExplorerTitleGenerator 异步补齐。别把占位值当成合法标题去掉。
 *   4) threadTitleMetadata 的 LEGACY_AUTO_TITLES 匹配是针对**历史数据**的：老版本自动生成的
 *      标题要能与用户手填的标题区分开，否则自动标题会被误判成 MANUAL 而不再更新。
 *      新增自动标题模板时必须同步加进这个集合。
 *   5) stripPlanProtocol / summarizeExplorerMessage 决定**落库的正文与摘要**。协议块必须在
 *      入库前剥离（否则 Plan 协议块会随消息回灌到下一轮 prompt），摘要在 180 字处截断——
 *      两者都改变了持久化内容，改动前先确认前端不依赖旧形态。
 */
import { placeholderExplorerTitle, type ExplorerTitleSource, type ExplorerTitleStatus } from "../explorer/explorer-title.js";
import { REQUIRED_PLAN_AREAS } from "../platform/plan-requirements.js";
import { isRecord, isStringArray } from "../platform/guards.js";
import type {
  ExplorerPlan,
  ExplorerThread,
  ExplorerThreadContextSummary,
  PlanExploration,
  PlanValidationIssue,
  VerificationRun,
} from "../index.js";

/** 新建 ExplorerPlan 时的默认探索状态：没有任何区域完成，也没有候选方案。 */
export function defaultPlanExploration(): PlanExploration {
  return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null };
}

/** 新建 ExplorerPlan 的默认记录；标题是占位值，由标题生成器异步补齐。 */
export function defaultExplorerPlan(thread: Pick<ExplorerThread, "id" | "projectId" | "createdAt">, id: string, ordinal: number, now: string): ExplorerPlan {
  return {
    id,
    explorerThreadId: thread.id,
    projectId: thread.projectId,
    ordinal,
    title: `Plan ${ordinal} / 待探索`,
    titleSource: "AUTO",
    titleStatus: "PLACEHOLDER",
    messageCount: 0,
    latestUserMessageSummary: null,
    exploration: defaultPlanExploration(),
    candidatePlanId: null,
    newPlanRequested: false,
    lastAssessedTurnId: null,
    createdAt: thread.createdAt,
    lastActivityAt: now,
  };
}

/** 线程上下文摘要的默认值；version 固定为 1，是迁移判断依据。 */
export function defaultThreadContextSummary(now: string): ExplorerThreadContextSummary {
  return { version: 1, updatedAt: now, completedPlans: [], openPlanIds: [] };
}

/** 校验从库里读回的 VerificationRun 行；形状不符返回 false 而不是抛错。 */
export function isVerificationRun(value: unknown): value is VerificationRun {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.runId === "string"
    && (value.status === "PASSED" || value.status === "SKIPPED" || value.status === "FAILED" || value.status === "BLOCKED")
    && typeof value.repairAttempts === "number"
    && Number.isInteger(value.repairAttempts)
    && Array.isArray(value.commandResults)
    && typeof value.completedAt === "string";
}

/** 把存成 JSON 字符串的 string[] 还原；解析失败或形状不符都回落 fallback。 */
export function parseStringArray(value: unknown, fallback: string[]): string[] {
  if (typeof value !== "string") return [...fallback];
  try { const parsed: unknown = JSON.parse(value); return isStringArray(parsed) ? parsed : [...fallback]; } catch { return [...fallback]; }
}

/** 把存成 JSON 字符串的上下文摘要还原；version 不是 1 就整体回落默认值。 */
export function parseThreadContextSummary(value: unknown, fallbackTime: string): ExplorerThreadContextSummary {
  if (typeof value !== "string") return defaultThreadContextSummary(fallbackTime);
  try {
    const parsed = JSON.parse(value) as Partial<ExplorerThreadContextSummary>;
    if (parsed.version !== 1 || !Array.isArray(parsed.completedPlans) || !Array.isArray(parsed.openPlanIds)) return defaultThreadContextSummary(fallbackTime);
    return { version: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallbackTime, completedPlans: parsed.completedPlans as ExplorerThreadContextSummary["completedPlans"], openPlanIds: parsed.openPlanIds.filter((id): id is string => typeof id === "string") };
  } catch {
    return defaultThreadContextSummary(fallbackTime);
  }
}

/** 把存成 JSON 字符串的 PlanValidationIssue[] 还原；逐条校验形状，坏行丢弃而不是整体失败。 */
export function parsePlanValidationIssues(value: unknown): PlanValidationIssue[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PlanValidationIssue => isRecord(item)
      && typeof item.path === "string"
      && typeof item.code === "string"
      && typeof item.area === "string"
      && typeof item.message === "string")
      .map((item) => ({ path: item.path, code: item.code as PlanValidationIssue["code"], area: item.area, message: item.message }));
  } catch { return []; }
}

const LEGACY_AUTO_TITLES = new Set(["New Explorer", "Previous exploration", "ExplorerThread"]);

/** 判定标题来源：空标题与历史自动标题都归为 AUTO/PLACEHOLDER，其余视为用户手填。 */
export function threadTitleMetadata(title: string | undefined, createdAt: string): { title: string; titleSource: ExplorerTitleSource; titleStatus: ExplorerTitleStatus } {
  const normalized = title?.trim();
  if (!normalized || LEGACY_AUTO_TITLES.has(normalized)) return { title: placeholderExplorerTitle(createdAt), titleSource: "AUTO", titleStatus: "PLACEHOLDER" };
  return { title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED" };
}

/** 深度遍历任意 JSON 结构，判断是否出现给定 id 集合中的任一字符串。 */
export function containsAnyString(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => containsAnyString(item, ids));
  if (isRecord(value)) return Object.values(value).some((item) => containsAnyString(item, ids));
  return false;
}

/** 剥离消息正文里的 pipeline-factory-plan 协议块；协议块不得落库。 */
export function stripPlanProtocol(content: string): string {
  return content
    .replace(/<pipeline-factory-plan-status>[\s\S]*?<\/pipeline-factory-plan-status>/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*?<\/pipeline-factory-plan>/gi, "")
    .trim();
}

/** 生成落库的消息摘要；压缩空白后在 180 字处截断。 */
export function summarizeExplorerMessage(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}
