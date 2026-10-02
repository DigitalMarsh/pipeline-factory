/**
 * 模块职责：解析模型输出里的 pipeline-factory-plan 协议块，判定 Plan 是否具备可执行的完整契约。
 *
 * 为什么从 index.ts 抽出来：termination-gates.ts 的 PlanCompletenessGate 是 Explorer Loop 的完成
 *   门禁，它过去 `import { assessPlanCompletion } from "./index.js"`，构成 index.ts 的最后两条回流边
 *   之一。本模块的运行时依赖（plan-spec.js、platform/plan-requirements.js、platform/guards.js、
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
 *   4) **只认当前形状**（`schemaVersion: 2` 的 generated spec）。V1 扁平合同已不再支持，
 *      `plan/contract.ts` 的 V1 校验器随之删除——所谓"老库里的 Plan 还能确认"这条路已经关掉。
 *   5) missing 用的是**面向用户的领域名**（REQUIRED_PLAN_AREAS 的成员），不是字段路径；
 *      diagnostics 才带 path/area/code。UI 与 continuationPrompt 分别消费两者。
 */
import { GeneratedPlanSpecValidationError, parseGeneratedPlanSpec, validateGeneratedPlanSpec } from "./plan-spec.js";
import type { GeneratedPlanSpec, PlanValidationIssue } from "./plan-spec.js";
import { REQUIRED_PLAN_AREAS } from "../platform/plan-requirements.js";
import { isRecord } from "../platform/guards.js";
import type { ResolvedPlanContract } from "./plan-spec.js";
import type { PlanExplorationStatus } from "../index.js";

/**
 * 解析出来的方案产物。
 *
 * Explorer 走 `generatedSpec`；`resolvedContract` 留给**程序化调用方**（测试夹具直接给一份
 * 现成的已解析契约）。V1 扁平合同（`contract`）不再接受——它不是"另一种输入"，而是一份
 * 有损镜像，已经连同类型与存储列一起删掉（见 docs 的 §6 B 类第二步）。
 */
export type PlanArtifact = { title: string; generatedSpec?: GeneratedPlanSpec; resolvedContract?: ResolvedPlanContract };
export type PlanCompletionAssessment = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  diagnostics: PlanValidationIssue[];
  artifact: PlanArtifact | null;
};

/** 解析模型协议块并检查 Plan 是否具备可执行的完整契约。 */
/**
 * 新方案必须具备的"细节"：现状与发现、每一步动哪些文件、风险。
 *
 * 为什么单独列在这里而不是塞进校验器：**校验器必须继续接受历史 spec**（它们会被
 * reviseConfiguration / setVerificationSuites 重新解析），把这三个字段设成必填会让老 Plan 直接不可用。
 * 门禁只跑新产物，所以"必须写清楚"这条要求放在这里是安全的。
 *
 * 直接动机：任务此前只有一个标题，Executor 拿到后得对着标题重新探索一遍；而计划里的
 * `design.technicalConstraints`（含 dependencies）**根本没有进到执行者的提示词**——
 * 库里反复出现的 `package.json remains missing` 就是这么来的。
 */
function missingExplorerDetail(spec: GeneratedPlanSpec): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (!spec.objective.context?.length) issues.push({ path: "objective.context", code: "REQUIRED", area: "目标与用户范围", message: "必须写出现状与调查发现：在仓库里看到了什么、依据是什么。" });
  if (!spec.design.risks?.length) issues.push({ path: "design.risks", code: "REQUIRED", area: "技术方案与关键约束", message: "必须写出风险与回滚。" });
  spec.tasks.forEach((task, index) => {
    if (!task.changes?.length) issues.push({ path: `tasks[${index}].changes`, code: "REQUIRED", area: "实施任务、依赖与冲突", message: `任务 ${task.id} 必须写明要动哪些文件、怎么动。` });
  });
  return issues;
}

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
  // 只认当前形状（`schemaVersion: 2` 的 generated spec）。V1 扁平合同已经不再支持：
  // 那种产物既解析不出可执行契约，也不会被确认——它以"校验失败"的诊断回到 Explorer，
  // 让模型重新产出一份合规的方案。
  try {
    const generatedSpec = parseGeneratedPlanSpec(parsed);
    // **只对新产物强制这些"细节"字段**。校验器那边它们是可选的——库里已有的 spec 会被
    // reviseConfiguration / setVerificationSuites 重新解析，必填会让老 Plan 直接不可用
    // （plan-spec.ts 的"过时键故意不报 FORBIDDEN"是同一条理由）。门禁只跑新产物，所以在这里
    // 提要求是安全的，而且诊断会像其他缺失项一样触发 Explorer 自动续跑补齐。
    const detailIssues = missingExplorerDetail(generatedSpec);
    if (detailIssues.length > 0) {
      const missing = [...new Set(detailIssues.map((item) => item.area))];
      return { status: "INCOMPLETE", missing, completed: REQUIRED_PLAN_AREAS.filter((area) => !missing.includes(area)), diagnostics: detailIssues, artifact: null };
    }
    return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], artifact: { title: generatedSpec.title, generatedSpec } };
  } catch (error) {
    const diagnostics = error instanceof GeneratedPlanSpecValidationError ? error.issues : validateGeneratedPlanSpec(parsed);
    const missing = [...new Set(diagnostics.map((item) => item.area))];
    return { status: "INCOMPLETE", missing: missing.length ? missing : ["完整执行契约"], completed: REQUIRED_PLAN_AREAS.filter((area) => !missing.includes(area)), diagnostics, artifact: null };
  }
}
