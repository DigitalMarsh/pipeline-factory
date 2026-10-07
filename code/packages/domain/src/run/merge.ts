/**
 * 模块职责：MergeRequest 的业务边界——把"验证通过的 Run"变成"人工可确认的合并请求"。
 *
 * 为什么从 index.ts 抽出来：它是"合并"这件事的完整实现（幂等创建、按 Git 事实补齐证据、
 *   人工确认），搬出来后只依赖 plan/status-transition.ts 一个值模块，其余全是类型。这是
 *   领域层里少见的、把"**不替用户改写目标分支**"这条产品约束写进代码的地方，值得单独可见。
 *
 * 维护提示：
 *   1) **本服务从不主动合并**。它只创建 OPEN 的 MergeRequest、以及按 Git 的只读观察把
 *      detectedTargetCommit 记下来。真正的合并由人在 Git 侧完成后再调 confirmMerged。
 *      任何"顺手 merge 一下"的改动都是在推翻产品前提。
 *   2) `git` 是**可选注入**的（options.git）。不注入时行为刻意退化成"信任调用方"：
 *      createRequest 不校验 sourceCommit、confirmMerged 退化成"targetCommit 必须等于
 *      sourceCommit"。测试与无 Git 环境依赖这个降级路径，不要把它改成必填。
 *   3) createRequest 幂等：同一 Run 已有 MergeRequest 时直接返回。合并请求一旦创建，
 *      sourceCommit 就是**被审核过的事实**，绝不能因为后来 Run 变了而改写。
 *   4) reconcileProject / reconcileRun **只读 Git 与写 detectedTargetCommit，不改 Plan 状态**。
 *      Plan 只由 confirmMerged 推进到 MERGED。把 reconcile 做成"看到已合并就顺手标 MERGED"
 *      会让未经人工确认的合并被系统承认。
 *   5) reconcileRun 把一切异常都吞掉并降级成 outcome: "UNAVAILABLE" + reason。这是**有意**的：
 *      Git 不可用不该让整个对账报告失败。但它意味着 reason 字符串是唯一的排障线索——
 *      新增失败分支时务必写清原因，不要复用泛化文案。
 *   6) createOpenRequest 的 targetBranch 缺失时回落 "main"，这是给老数据（Revision 无
 *      baseBranch）的兜底，不是默认值设计。
 */
import { randomUUID } from "node:crypto";
import { updatePlanStatus } from "../plan/status-transition.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { Project } from "../project/project.js";
import type { GitMergeInspector, MergeReconciliationItem, MergeReconciliationReport, MergeRequest, Run, VerificationRun } from "../index.js";

export class MergeService {
  constructor(private readonly store: PipelineStore, private readonly options: { git?: GitMergeInspector } = {}) {}

  /** 为验证通过的 Run 创建幂等 MergeRequest。 */
  createRequest(run: Run, verification: VerificationRun, sourceCommit: string): MergeRequest {
    if (run.status !== "MERGE_READY" || (verification.status !== "PASSED" && verification.status !== "SKIPPED")) throw new Error("MergeRequest requires completed verification evidence");
    if (verification.runId !== run.id) throw new Error("Verification evidence must belong to the same run");
    const existing = this.store.findMergeRequestByRun(run.id);
    // **幂等的判据是"同一个 sourceCommit"**，不是"这个 Run 已有请求"。这个 Run 可能被补充要求
    // 推回去重做过（`MERGE_READY → IN_PROGRESS`），那份旧请求指向的是**更早**的 commit：
    // 原地返回它，而 `confirmMerged` 只校验"旧 sourceCommit 是新 targetCommit 的祖先"，
    // 于是新做的、还没重新验证过的改动会跟着一起被合进去。作废它，让下面照常建新的。
    if (existing && existing.sourceCommit === sourceCommit) return existing;
    if (existing) this.store.updateMergeRequest({ ...existing, status: "SUPERSEDED" });
    const project = this.store.getProject(run.projectId);
    if (project && this.options.git && !this.options.git.commitExists(project.repoRoot, sourceCommit)) {
      throw new Error(`Source commit ${sourceCommit} could not be verified in the project repository`);
    }
    return this.createOpenRequest(run, sourceCommit, null);
  }

  /** 按当前 Project 的 Git 事实补齐外部合并证据，但绝不自动改变 Plan 状态。 */
  reconcileProject(projectId: string): MergeReconciliationReport {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const items = this.store.listRuns()
      .filter((run) => run.projectId === projectId && run.status === "MERGE_READY")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((run) => this.reconcileRun(project, run));
    return { projectId, checkedAt: new Date().toISOString(), items };
  }

  /** 查找 Run 对应的 MergeRequest。 */
  findByRun(runId: string): MergeRequest | undefined { return this.store.findMergeRequestByRun(runId); }
  /** 按 id 读取 MergeRequest。 */
  get(requestId: string): MergeRequest | undefined { return this.store.getMergeRequest(requestId); }
  /** 列出全部 MergeRequest 供人工审核台使用。 */
  list(): MergeRequest[] { return this.store.listMergeRequests(); }

  /** 只有目标提交与已审核源提交一致时才确认合并。 */
  confirmMerged(requestId: string, targetCommit: string): MergeRequest {
    const request = this.store.getMergeRequest(requestId);
    if (!request) throw new Error(`MergeRequest ${requestId} not found`);
    if (request.status === "MERGED") return request;
    if (!this.options.git && targetCommit !== request.sourceCommit) throw new Error("Target commit does not match the reviewed source commit");
    const plan = this.store.getPlan(request.planId);
    const project = plan ? this.store.getProject(plan.projectId) : undefined;
    if (project && this.options.git) {
      if (!this.options.git.commitExists(project.repoRoot, targetCommit)) throw new Error(`Target commit ${targetCommit} could not be verified in the project repository`);
      if (!this.options.git.isAncestor(project.repoRoot, request.sourceCommit, targetCommit)) throw new Error("Source commit is not an ancestor of the target commit");
      if (!this.options.git.branchContains(project.repoRoot, request.targetBranch, targetCommit)) throw new Error("Target branch does not contain the reviewed source commit");
    }
    const merged = { ...request, status: "MERGED" as const, mergedAt: new Date().toISOString() };
    this.store.updateMergeRequest(merged);
    if (plan) updatePlanStatus(this.store, plan, { status: "MERGED", lastEventAt: merged.mergedAt ?? plan.lastEventAt });
    this.store.appendEvent({ type: "merge.confirmed", aggregateId: requestId, payload: { targetCommit, planId: request.planId, revision: plan?.revision ?? null } });
    return merged;
  }

  private reconcileRun(project: Project, run: Run): MergeReconciliationItem {
    const existing = this.store.findMergeRequestByRun(run.id);
    try {
      const targetBranch = existing?.targetBranch ?? this.targetBranch(run);
      if (existing?.status === "MERGED") {
        return { runId: run.id, planId: run.planId, outcome: "ALREADY_MERGED", mergeRequest: existing, sourceCommit: existing.sourceCommit, targetBranch, targetCommit: existing.detectedTargetCommit ?? null, reason: null };
      }
      const verification = this.store.getVerificationRun(run.id);
      if (!verification || (verification.status !== "PASSED" && verification.status !== "SKIPPED")) {
        return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch, targetCommit: null, reason: "A passed or skipped VerificationRun is required" };
      }
      const git = this.options.git;
      if (!git) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch, targetCommit: null, reason: "Git merge inspection is not configured" };

      const sourceCommit = existing?.sourceCommit ?? this.resolveRunSource(git, project, run);
      if (!targetBranch) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch: null, targetCommit: null, reason: "Frozen Plan revision base branch could not be resolved" };
      if (!sourceCommit) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: null, targetBranch, targetCommit: null, reason: "Run worktree and branch HEAD could not be resolved" };
      if (!git.commitExists(project.repoRoot, sourceCommit)) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit: null, reason: `Source commit ${sourceCommit} could not be verified in the project repository` };
      const targetCommit = git.resolveCommit(project.repoRoot, targetBranch);
      if (!targetCommit) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit: null, reason: `Target branch ${targetBranch} could not be resolved` };
      const contained = git.isAncestor(project.repoRoot, sourceCommit, targetCommit) && git.branchContains(project.repoRoot, targetBranch, targetCommit);
      if (!contained) {
        if (existing?.status === "OPEN" && existing.detectedTargetCommit) {
          const cleared = { ...existing, detectedTargetCommit: null };
          this.store.updateMergeRequest(cleared);
          return { runId: run.id, planId: run.planId, outcome: "NOT_MERGED", mergeRequest: cleared, sourceCommit, targetBranch, targetCommit, reason: "Target branch does not currently contain the reviewed source commit" };
        }
        return { runId: run.id, planId: run.planId, outcome: "NOT_MERGED", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit, reason: "Target branch does not currently contain the reviewed source commit" };
      }
      if (existing) {
        const updated = existing.detectedTargetCommit === targetCommit ? existing : { ...existing, detectedTargetCommit: targetCommit };
        if (updated !== existing) {
          this.store.updateMergeRequest(updated);
          this.store.appendEvent({ type: "merge.detected", aggregateId: updated.id, payload: { runId: run.id, planId: run.planId, sourceCommit, targetBranch, targetCommit } });
        }
        return { runId: run.id, planId: run.planId, outcome: "ALREADY_OPEN", mergeRequest: updated, sourceCommit, targetBranch, targetCommit, reason: null };
      }
      const request = this.createOpenRequest(run, sourceCommit, targetCommit);
      this.store.appendEvent({ type: "merge.detected", aggregateId: request.id, payload: { runId: run.id, planId: run.planId, sourceCommit, targetBranch, targetCommit } });
      return { runId: run.id, planId: run.planId, outcome: "DETECTED", mergeRequest: request, sourceCommit, targetBranch, targetCommit, reason: null };
    } catch (error) {
      return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch: existing?.targetBranch ?? null, targetCommit: null, reason: `Git merge inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private createOpenRequest(run: Run, sourceCommit: string, detectedTargetCommit: string | null): MergeRequest {
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const request: MergeRequest = { id: `merge-${randomUUID().slice(0, 12)}`, runId: run.id, planId: run.planId, sourceCommit, targetBranch: revision?.resolvedContract.repository.baseBranch ?? "main", status: "OPEN", humanConfirmationRequired: true, createdAt: new Date().toISOString(), mergedAt: null, ...(detectedTargetCommit ? { detectedTargetCommit } : {}) };
    this.store.saveMergeRequest(request);
    this.store.appendEvent({ type: "merge.request.created", aggregateId: request.id, payload: request });
    return request;
  }

  private targetBranch(run: Run): string | null {
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const branch = revision?.resolvedContract.repository.baseBranch?.trim();
    return branch || null;
  }

  private resolveRunSource(git: GitMergeInspector, project: Project, run: Run): string | null {
    if (run.workspacePath) {
      const workspaceHead = git.resolveCommit(run.workspacePath, "HEAD");
      if (workspaceHead) return workspaceHead;
    }
    return git.resolveCommit(project.repoRoot, run.branch);
  }
}
