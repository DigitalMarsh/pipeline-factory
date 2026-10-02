/**
 * 模块职责：把已确认的 Plan Revision **落盘**到受管工程的计划目录——渲染成人读的 Markdown，
 *   目录不存在就建，每版一个文件、互不覆盖。
 *
 * 为什么做这件事：Plan 在此之前只存在于 Factory 的数据库与页面里，落不到盘上也就无法随工程被审阅、
 *   被 diff、被版本化。落盘之后"这次改动的方案是什么"与代码在同一个仓库里，评审和回溯都不必再打开
 *   另一个系统。**只在确认时写**：草稿是过程，冻结过的 Revision 才是要留档的事实。
 *
 * 维护提示：
 *   1) **每版一个文件（`<planId>-v<revision>.md`），不覆盖旧版**。同一 Revision 重复确认会写同一个
 *      路径（确认是幂等的），但不同 Revision 永远落在不同文件上——"V2 覆盖了 V1"会让历史凭空消失。
 *   2) 目录由 `configuredPlanDirectory` 决定（见 plan/plan-directory.ts）；**允许落在仓库之外**，
 *      这是合法配置，不在这里做"必须在仓库内"的限制。目录不存在时创建。
 *   3) 渲染是**纯函数**（renderPlanDocument），落盘是薄薄一层 IO。分开是为了让"文件里写了什么"
 *      可以被测试直接断言，而不必去读临时目录。
 *   4) 写入**先于** Revision 冻结（见 plan/service.ts）：写失败就阻断确认、可重试且无副作用；
 *      反过来先冻结再写，会留下"确认成功了但文件没写成"这种说不清的中间态。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanTaskChange, ResolvedPlanContract } from "./plan-spec.js";

/** 落盘所需的事实；契约只有 `resolvedContract` 一份，没有回退形状。 */
export type PlanDocumentInput = {
  planId: string;
  revision: number;
  title: string;
  resolvedContract: ResolvedPlanContract;
  artifactHash: string;
  confirmedBy: string;
  confirmedAt: string;
};

/** 文件名：`<planId>-v<revision>.md`。planId 是 UI 与 Run 到处引用的主键，用它才可追溯。 */
export function planDocumentFileName(planId: string, revision: number): string {
  return `${planId}-v${revision}.md`;
}

/** 一步实施对某个文件的动作；中文化只在这一处，避免每处渲染各写一遍。 */
const CHANGE_ACTION_LABELS: Record<PlanTaskChange["action"], string> = { create: "新建", modify: "修改", delete: "删除" };

/**
 * 渲染 Markdown。**不写文件**，便于直接断言内容。
 * 空字段不编占位符——"没有"就写"（未声明）"，好过留一行空白让人以为渲染坏了。
 */
export function renderPlanDocument(input: PlanDocumentInput): string {
  const resolved = input.resolvedContract;
  const goal = resolved.objective.goal;
  const acceptance = resolved.objective.acceptanceCriteria;
  const outOfScope = resolved.objective.outOfScope ?? [];
  const audience = resolved.objective.audience ?? [];
  const include = resolved.scope.includePaths;
  const exclude = resolved.scope.excludePaths;
  const tasks = resolved.tasks;
  const verification = resolved.verification.commandIds;
  const design = resolved.design;
  const artifactPath = resolved.artifact.path;
  const artifactMode = resolved.artifact.mode;
  const repository = resolved.repository;
  const merge = resolved.merge;

  const lines: string[] = [];
  lines.push(`# ${input.title}`, "");
  lines.push("> 本文件由 Pipeline Factory 在**确认 Plan 时**写入，是 Revision 的落盘副本，与 Factory 中冻结的契约一致。", "> 手工修改不会影响 Factory 中的契约：要改方案请回到 Explorer 生成新版本。", "");
  lines.push("| 项 | 值 |", "| --- | --- |");
  lines.push(`| Plan | \`${input.planId}\` |`);
  lines.push(`| Revision | ${input.revision} |`);
  lines.push(`| 确认人 | ${input.confirmedBy} |`);
  lines.push(`| 确认时间 | ${input.confirmedAt} |`);
  lines.push(`| 基线 | ${repository.baseBranch} @ ${repository.baseCommit} |`);
  lines.push(`| 契约哈希 | \`${input.artifactHash}\` |`);
  lines.push(`| 产物模式 | ${artifactMode ?? "（未声明）"} |`);
  lines.push(`| 产物路径 | ${artifactPath ? `\`${artifactPath}\`` : "（未声明）"} |`, "");

  lines.push("## 目标", "", goal || "（未声明）", "");
  if (audience.length > 0) lines.push(`面向：${audience.join("、")}`, "");
  // 现状与发现：Explorer 在仓库里看到了什么、依据是什么。此前这些只能塞进目标那段散文里。
  const context = resolved?.objective.context ?? [];
  if (context.length > 0) lines.push("## 现状与发现", "", ...bullets(context), "");

  lines.push("## 验收标准", "", ...bullets(acceptance), "");
  lines.push("## 功能范围", "", "**包含**", "", ...bullets(include), "", "**排除**", "", ...bullets(exclude), "");
  if (outOfScope.length > 0) lines.push("## 明确不做", "", ...bullets(outOfScope), "");

  lines.push("## 实施步骤", "");
  for (const [index, task] of tasks.entries()) {
    const dependencies = task.dependencies.length > 0 ? `（依赖：${task.dependencies.join("、")}）` : "";
    lines.push(`${index + 1}. **${task.title}** ${dependencies}`.trimEnd());
    // 每一步动哪些文件、怎么动——这是"任务标题"与"真正动手"之间的那层，
    // 也是 Executor 的靶子（见 executor-agent.ts 的 executorPlanView）。
    for (const change of task.changes ?? []) {
      lines.push(`   - \`${change.path}\`（${CHANGE_ACTION_LABELS[change.action]}）：${change.detail}`);
    }
  }
  if (tasks.length === 0) lines.push("（未声明）");
  lines.push("");

  if (design) {
    lines.push("## 技术约束", "", ...bullets(design.technicalConstraints), "");
    lines.push("## 数据与安全", "", ...bullets(design.dataSecurity), "");
    lines.push("## 失败处理", "", ...bullets(design.failureHandling), "");
    if (design.risks?.length) lines.push("## 风险与回滚", "", ...bullets(design.risks), "");
  }

  lines.push("## 验证", "", verification.length > 0 ? `项目验证命令：${verification.map((id) => `\`${id}\``).join("、")}` : "（无验证命令，或由项目默认值决定）", "");
  lines.push("## 合并", "", `策略：${merge.strategy}${merge.requireHumanMerge ? "（需要人工确认合并）" : ""}`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 渲染并落盘，返回文件绝对路径。目录不存在时创建（含多级）。
 * 同一 (planId, revision) 重复调用是幂等的：覆盖同一个文件，内容相同。
 *
 * `directory` 是**绝对路径**，由调用方解析（组合根知道配置，见 plan-plan-directory 的说明）；
 * 本函数不再碰配置，只做"渲染 + 写"。
 */
export function writePlanDocument(input: PlanDocumentInput & { directory: string }): string {
  mkdirSync(input.directory, { recursive: true });
  const file = join(input.directory, planDocumentFileName(input.planId, input.revision));
  writeFileSync(file, renderPlanDocument(input), "utf8");
  return file;
}

function bullets(items: readonly string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- （未声明）"];
}
