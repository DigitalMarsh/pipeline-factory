/**
 * 模块职责：解析模型输出里的 pipeline-factory-plan 协议块，判定 Plan 是否具备可执行的完整契约。
 *
 * 为什么从 index.ts 抽出来：termination-gates.ts 的 PlanCompletenessGate 是 Explorer Loop 的完成
 *   门禁，它过去 `import { assessPlanCompletion } from "./index.js"`，构成 index.ts 的最后两条回流边
 *   之一。本模块的运行时依赖（plan-v2.js、platform/plan-requirements.js、platform/guards.js、
 *   plan/contract.js）全部已在 index.ts 之外，因此搬到这里不会把回流边换个名字继续存在。
 *
 * 维护提示：
 *   1) 协议块是**成对**出现的：`<pipeline-factory-plan-status>` 声明状态，紧随其后的
 *      `<pipeline-factory-plan>` 才是合同正文。planProtocolCandidates 按"status 之后、下一个 status
 *      之前"这个区间去配对 plan 块——改这里的区间边界会让多轮输出里的旧块被误当成新一轮结果。
 *   2) 只认 READY：INCOMPLETE 块即使正文完整也不会通过。遍历用 reverse() 从最后一轮往前找，
 *      取"最新的一个 READY"而不是"第一个"——模型重试时会重复输出，取第一个会让修复永远不生效。
 *   3) DUPLICATE 诊断（同一轮重复输出完全相同的未通过 READY 块）是 prompt 里"不要原样重复"那句话的
 *      执行端。去掉它，模型卡在同一个错误上的循环就没有终止信号。
 *   4) V1 分支（schemaVersion !== 2）只服务历史数据；新 Explorer 只产出 V2。V1 分支的字段清单
 *      必须与 plan/contract.ts 的 validatePlanContract 保持一致，否则会出现"assessPlanCompletion
 *      判 READY、Confirm 时被 validatePlanContract 抛错拒绝"的错配。
 *   5) missing 用的是**面向用户的领域名**（REQUIRED_PLAN_AREAS 的成员），不是字段路径；
 *      diagnostics 才带 path/area/code。UI 与 continuationPrompt 分别消费两者。
 */
import { GeneratedPlanSpecV2ValidationError, parseGeneratedPlanSpecV2, validateGeneratedPlanSpecV2 } from "./plan-v2.js";
import type { GeneratedPlanSpecV2, PlanValidationIssue } from "./plan-v2.js";
import { REQUIRED_PLAN_AREAS } from "../platform/plan-requirements.js";
import { isNonEmptyStringArray, isRecord, isStringArray } from "../platform/guards.js";
import { validatePlanContract } from "./contract.js";
import type { PlanContract, PlanExplorationStatus } from "../index.js";

export type PlanArtifact = { title: string; contract?: PlanContract; generatedSpec?: GeneratedPlanSpecV2 };
export type PlanCompletionAssessment = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  diagnostics: PlanValidationIssue[];
  artifact: PlanArtifact | null;
};

/** 解析模型协议块并检查 Plan 是否具备可执行的完整契约。 */
export function assessPlanCompletion(content: string): PlanCompletionAssessment {
  const candidates = planProtocolCandidates(content);
  if (candidates.length === 0) return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], artifact: null };

  let sawReadyCandidate = false;
  let latestIncomplete: PlanCompletionAssessment | null = null;
  for (const candidate of [...candidates].reverse()) {
    if (candidate.status !== "READY") continue;
    sawReadyCandidate = true;
    const assessment = assessPlanArtifact(candidate.artifactText);
    if (assessment.status === "READY") return assessment;
    latestIncomplete ??= assessment;
  }
  if (latestIncomplete) {
    const latest = [...candidates].reverse().find((candidate) => candidate.status === "READY");
    const repeats = latest ? candidates.filter((candidate) => candidate.status === "READY" && candidate.artifactText === latest.artifactText).length : 0;
    if (repeats > 1) return { ...latestIncomplete, diagnostics: [...latestIncomplete.diagnostics, { path: "$", code: "DUPLICATE", area: "完整执行契约", message: "本轮已重复输出相同的未通过 READY 协议块；请按字段诊断修改后再提交。" }] };
    return latestIncomplete;
  }
  return sawReadyCandidate
    ? { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "READY 协议块不完整。" }], artifact: null }
    : { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], artifact: null };
}

function planProtocolCandidates(content: string): Array<{ status: string; artifactText: string }> {
  const statusMatches = [...content.matchAll(/<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/gi)];
  const planMatches = [...content.matchAll(/<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/gi)];
  return statusMatches.flatMap((statusMatch, index) => {
    const statusEnd = (statusMatch.index ?? 0) + statusMatch[0].length;
    const nextStatusStart = statusMatches[index + 1]?.index ?? content.length;
    const plan = planMatches.find((candidate) => (candidate.index ?? -1) >= statusEnd && (candidate.index ?? content.length) < nextStatusStart);
    const statusText = statusMatch[1];
    return plan && typeof plan[1] === "string" && typeof statusText === "string" ? [{ status: statusText.trim().toUpperCase(), artifactText: plan[1] }] : [];
  });
}

function assessPlanArtifact(artifactText: string): PlanCompletionAssessment {
  let parsed: unknown;
  try { parsed = JSON.parse(artifactText); } catch { return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是严格 JSON，不能使用代码围栏或残缺 JSON。" }], artifact: null }; }
  if (!isRecord(parsed)) return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是 JSON 对象。" }], artifact: null };
  // V2 is intentionally a generated spec: Factory adds project identity, Git
  // baseline and default verification commands only after this boundary.
  if (parsed.schemaVersion === 2) {
    try {
      const generatedSpec = parseGeneratedPlanSpecV2(parsed);
      return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], artifact: { title: generatedSpec.title, generatedSpec } };
    } catch (error) {
      const diagnostics = error instanceof GeneratedPlanSpecV2ValidationError ? error.issues : validateGeneratedPlanSpecV2(parsed);
      const missing = [...new Set(diagnostics.map((item) => item.area))];
      return { status: "INCOMPLETE", missing: missing.length ? missing : ["完整执行契约"], completed: REQUIRED_PLAN_AREAS.filter((area) => !missing.includes(area)), diagnostics, artifact: null };
    }
  }
  const missing: string[] = [];
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) missing.push("方案标题");
  const contract = parsed as Partial<PlanContract>;
  if (typeof contract.goal !== "string" || !contract.goal.trim()) missing.push("目标与用户范围");
  if (!isNonEmptyStringArray(contract.acceptanceCriteria)) missing.push("验收标准与验证命令");
  if (!isStringArray(contract.include) || !isStringArray(contract.exclude)) missing.push("功能范围与排除项");
  if (typeof contract.baseBranch !== "string" || !contract.baseBranch.trim() || typeof contract.baseCommit !== "string" || !contract.baseCommit.trim()) missing.push("基线 Branch 与 Commit");
  if (!Array.isArray(contract.tasks) || contract.tasks.length === 0 || contract.tasks.some((task) => !isRecord(task) || typeof task.id !== "string" || !task.id.trim() || typeof task.title !== "string" || !task.title.trim() || !isStringArray(task.dependencies))) missing.push("实施任务、依赖与冲突");
  if (contract.dependsOnPlanIds !== undefined && !isStringArray(contract.dependsOnPlanIds)) missing.push("实施任务、依赖与冲突");
  if (!isStringArray(contract.conflictKeys)) missing.push("实施任务、依赖与冲突");
  if (typeof contract.executorModelRole !== "string" || !contract.executorModelRole.trim() || typeof contract.toolPolicy !== "string" || !contract.toolPolicy.trim()) missing.push("Executor 模型与 ToolPolicy");
  if (!isNonEmptyStringArray(contract.verificationCommandIds)) missing.push("验收标准与验证命令");
  if (typeof contract.maxRepairAttempts !== "number" || contract.maxRepairAttempts < 0 || !Number.isInteger(contract.maxRepairAttempts)) missing.push("修复次数上限");
  if (contract.mergeStrategy !== "manual" && contract.mergeStrategy !== "fast-forward" && contract.mergeStrategy !== "squash") missing.push("合并策略与人工确认");
  if (contract.requireHumanMerge !== true) missing.push("合并策略与人工确认");
  if (missing.length === 0) {
    try { validatePlanContract(contract as PlanContract); } catch { missing.push("实施任务、依赖与冲突"); }
  }
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) return { status: "INCOMPLETE", missing: uniqueMissing, completed: REQUIRED_PLAN_AREAS.filter((area) => !uniqueMissing.includes(area)), diagnostics: uniqueMissing.map((area) => ({ path: "$", code: "REQUIRED" as const, area, message: "历史 V1 合同缺少必填字段。" })), artifact: null };
  // Flat artifacts are history-only. New Explorer instructions only emit V2.
  return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], artifact: { title, contract: { ...(contract as PlanContract), schemaVersion: 1 } } };
}
