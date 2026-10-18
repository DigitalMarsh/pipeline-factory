/**
 * 模块职责：确定性验证与受控修复——Run 进入 MERGE_READY 之前唯一能改变其状态的环节。
 *
 * 为什么从 index.ts 抽出来：它是"验证"这个业务边界的全部实现（循环、修复预算、状态迁移、
 *   事件与日志的写入时机），与它同处一个文件的是七八个毫不相干的类。搬出来后依赖只有
 *   plan/status-transition.ts 一个值模块。
 *
 * 维护提示：
 *   1) **状态迁移与持久化的顺序是语义的一部分**：先改 `run.status` 再 saveRun，再更新 Plan、
 *      最后追加事件。颠倒顺序会让 UI 在某一瞬间看到 Run 已 MERGE_READY 而事件尚未落库。
 *   2) `store` 是**可选**的（构造函数里的 `?`）：不传 store 时本类退化成纯计算器，只返回
 *      VerificationRun 而不落库。这是为了让验证循环能被单测直接驱动。不要把它改成必填。
 *   3) Plan 只在 `plan.runId === run.id` 时才被推进——这是"Plan 的当前 Run"与"历史 Run"的
 *      分界。去掉这个判断会让重跑旧 Run 把已经 MERGE_READY 的 Plan 打回 VERIFYING/BLOCKED。
 *   4) **修复预算来自 Revision 的 contract.maxRepairAttempts，不是常量**。它有两处判断
 *      （repair 不存在时、repairAttempts 用尽时），改动预算语义要同时改两处；
 *      另外 `repair` 返回 false 但预算仍有剩余时循环会继续，这是有意为之（修复器可能只是
 *      这一轮没能改动代码）。
 *   5) 四个 return 分支各自构造 VerificationRun，status 的取值决定了 Plan 后续状态
 *      （PASSED/SKIPPED → MERGE_READY，其余 → BLOCKED）。新增状态时必须同步 record() 里的映射。
 *   6) **成功收尾（PASSED / SKIPPED）之前先把工作区提交到分支上**（`options.commitWorkspace`）。
 *      这一步不落成，`MERGE_READY` 就是一句空话：分支上一个提交都没有，人照界面的提示点
 *      「确认合并」，合并过去什么都没有（实测踩过）。所以提交**失败要 BLOCK**，理由原样带进
 *      Plan 的 `attentionReason`——最常见的原因是仓库没配 git 身份。
 *      `commitWorkspace` 缺省时整步跳过（测试与无 Git 环境）。
 */
import { randomUUID } from "node:crypto";
import { updatePlanStatus } from "../plan/status-transition.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { CommandResult, PlanRevision, RepairExecutor, Run, VerificationCommandExecutor, VerificationRun } from "../index.js";

/**
 * 成功收尾前的"把工作区提交到分支"端口。返回值不关心（Scheduler 给的是提交号）；
 * 抛错即视为提交失败，调用方会据此把 Run 打成 `BLOCKED`。
 */
export type WorkspaceCommitHook = (run: Run, revision: PlanRevision) => Promise<unknown>;

export type VerificationServiceOptions = {
  /** 缺省就没有"Run 跑完自动提交"这一步，见模块头维护提示 6。 */
  commitWorkspace?: WorkspaceCommitHook | undefined;
};

/** 脱离模型会话执行确定性验证，并按 Revision 的 repair limit 控制修复重试。 */
export class VerificationService {
  constructor(
    private readonly store?: PipelineStore,
    private readonly options: VerificationServiceOptions = {},
  ) {}

  /**
   * 成功收尾前把工作区提交到分支上；**失败返回原因**（调用方据此 BLOCK）。
   * 没有配这个端口就整步跳过。
   */
  private async commitWorkspace(run: Run, revision: PlanRevision): Promise<string | null> {
    if (!this.options.commitWorkspace) return null;
    try {
      await this.options.commitWorkspace(run, revision);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** 提交失败时统一走这条：Run 打成 BLOCKED，理由是那句原话。 */
  private blockOnCommitFailure(
    run: Run,
    reason: string,
    repairAttempts: number,
    commandResults: Array<{ commandId: string; result: CommandResult }>,
  ): VerificationRun {
    run.status = "BLOCKED";
    const verification: VerificationRun = {
      id: `verification-${randomUUID().slice(0, 12)}`,
      runId: run.id,
      status: "BLOCKED",
      repairAttempts,
      commandResults: [...commandResults],
      completedAt: this.store?.now() ?? new Date().toISOString(),
    };
    this.record(run, verification, `工作区提交失败：${reason}`);
    return verification;
  }

  /** 执行验证命令，失败时最多按 Plan contract 重试 repair。 */
  async verify(run: Run, revision: PlanRevision, execute: VerificationCommandExecutor, repair?: RepairExecutor): Promise<VerificationRun> {
    if (run.status !== "IN_PROGRESS" && run.status !== "READY_FOR_VERIFY")
      throw new Error(`Run ${run.id} cannot be verified from ${run.status}`);
    run.status = "VERIFYING";
    this.store?.saveRun(run);
    const verifyingPlan = this.store?.getPlan(run.planId);
    if (this.store && verifyingPlan && verifyingPlan.runId === run.id) {
      updatePlanStatus(this.store, verifyingPlan, { status: "VERIFYING", lastEventAt: this.store.now() });
    }
    const commandIds = revision.resolvedContract.verification.commandIds;
    if (revision.resolvedContract.verification.mode === "NONE" || commandIds.length === 0) {
      // 「没有验证命令」也是成功收尾：照样要先把工作区提交上去（见维护提示 6）。
      const commitFailure = await this.commitWorkspace(run, revision);
      if (commitFailure) return this.blockOnCommitFailure(run, commitFailure, 0, []);
      run.status = "MERGE_READY";
      const verification: VerificationRun = {
        id: `verification-${randomUUID().slice(0, 12)}`,
        runId: run.id,
        status: "SKIPPED",
        reason: "NO_PROJECT_VERIFICATION_COMMANDS",
        repairAttempts: 0,
        commandResults: [],
        completedAt: this.store?.now() ?? new Date().toISOString(),
      };
      this.record(run, verification);
      return verification;
    }
    const commandResults: Array<{ commandId: string; result: CommandResult }> = [];
    let repairAttempts = 0;
    for (;;) {
      commandResults.length = 0;
      let failed = false;
      for (const commandId of commandIds) {
        const result = await execute(commandId, run);
        commandResults.push({ commandId, result });
        if (result.exitCode !== 0) {
          failed = true;
          break;
        }
      }
      if (!failed) {
        const commitFailure = await this.commitWorkspace(run, revision);
        if (commitFailure) return this.blockOnCommitFailure(run, commitFailure, repairAttempts, commandResults);
        run.status = "MERGE_READY";
        const verification = {
          id: `verification-${randomUUID().slice(0, 12)}`,
          runId: run.id,
          status: "PASSED" as const,
          repairAttempts,
          commandResults: [...commandResults],
          completedAt: this.store?.now() ?? new Date().toISOString(),
        };
        this.record(run, verification);
        return verification;
      }
      if (!repair || repairAttempts >= revision.resolvedContract.execution.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = {
          id: `verification-${randomUUID().slice(0, 12)}`,
          runId: run.id,
          status: repairAttempts >= revision.resolvedContract.execution.maxRepairAttempts ? ("BLOCKED" as const) : ("FAILED" as const),
          repairAttempts,
          commandResults: [...commandResults],
          completedAt: this.store?.now() ?? new Date().toISOString(),
        };
        this.record(run, verification);
        return verification;
      }
      repairAttempts += 1;
      const repaired = await repair(run, repairAttempts);
      if (!repaired && repairAttempts >= revision.resolvedContract.execution.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = {
          id: `verification-${randomUUID().slice(0, 12)}`,
          runId: run.id,
          status: "BLOCKED" as const,
          repairAttempts,
          commandResults: [...commandResults],
          completedAt: this.store?.now() ?? new Date().toISOString(),
        };
        this.record(run, verification);
        return verification;
      }
    }
  }

  private record(run: Run, verification: VerificationRun, attentionReason = "Verification failed"): void {
    if (!this.store) return;
    this.store.saveVerificationRun(verification);
    this.store.saveRun(run);
    const plan = this.store.getPlan(run.planId);
    if (plan && plan.runId === run.id) {
      const succeeded = verification.status === "PASSED" || verification.status === "SKIPPED";
      updatePlanStatus(
        this.store,
        plan,
        {
          status: succeeded ? "MERGE_READY" : "BLOCKED",
          attentionReason: succeeded ? null : attentionReason,
          lastEventAt: verification.completedAt,
        },
        succeeded ? null : attentionReason,
      );
    }
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (thread) {
      this.store.appendExecutionJournal({
        executionThreadId: thread.id,
        runId: thread.runId,
        type: "VERIFICATION",
        occurredAt: verification.completedAt,
        payload: verification,
      });
    }
    this.store.appendEvent({
      type: "verification.completed",
      aggregateId: run.id,
      payload: { ...verification, planId: run.planId, revision: run.planRevision },
    });
  }
}
