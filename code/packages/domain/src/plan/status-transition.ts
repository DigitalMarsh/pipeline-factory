/**
 * 模块职责：CandidatePlan 状态变更的唯一统一写入口——先写事实（store.updatePlan），
 *   状态确实变化时再追加一条 plan.status.changed 领域事件。
 *
 * 为什么从 index.ts 抽出来：executor-agent 与 recovery-coordinator 都要改 Plan 状态，于是两者
 *   各自 `import { updatePlanStatus } from "./index.js"`，与 index.ts 对它们的值级导入构成回流边。
 *   本模块只依赖 PipelineStore / CandidatePlan 两个**类型**（import type 被 tsc 整条擦除，
 *   不产生运行时边），因此函数搬到这里、两个调用方改指向本模块之后，两条回流边同时被切断。
 *
 * 维护提示：
 *   1) 本函数只负责 plan.status.changed 这一条通用状态事件；plan.confirmed / plan.enqueued /
 *      plan.dispatched 等领域语义事件仍由各业务服务自己追加，不要合并到这里——
 *      合并会让"哪些状态转换产生了哪些语义事件"这一契约在本文件里丢失。
 *   2) 事件只在 `updated.status !== plan.status` 时追加。改成"每次调用都追加"会让 Plan 时间线里
 *      塞满 fromStatus === toStatus 的噪声事件，且会改变前端的去重与锚点行为。
 *   3) updates 是 Partial<CandidatePlan> 的浅合并，调用方必须显式把要重置的字段写成 null
 *      （如 queuedAt: null、runId: null），否则旧值会被保留下来。
 */
import type { CandidatePlan, PipelineStore } from "../index.js";
import type { PlanStatus } from "./types.js";

/**
 * **Plan 状态的合法转换——这是唯一一份"哪些转换存在"的定义。**
 *
 * 建这张表之前，"哪些转换合法"这件事有四份互不知道的副本：散落在 `plan/service.ts` 与
 * `run/dispatch-coordinator.ts` 的四处 `includes([...])` 白名单；`planLifecycle.ts` 的
 * `normalizedLifecycleStatus`（三块归一化补丁，其实是"表缺边"打的）；`recovery-coordinator.ts` 的
 * `RECONCILIABLE_PLAN_STATUSES` + `planStatusForRun`；以及前端 `explorerRequirementRows.ts` 的
 * `CONFIRMED_PLAN_STATUSES`。而写入点本身（22 处 `updatePlanStatus`）**没有任何合法性检查**——
 * 从 `BLOCKED` 直接跳回 `READY` 也是合法的，只要有人这么写。
 *
 * 表里的每一条边都能指到代码里的写入点：
 *
 * | 边 | 写入点 |
 * |---|---|
 * | `DRAFT → READY` | `plan/service.ts` 的 `confirm` |
 * | `DRAFT → DISCARDED` | `plan/service.ts` 的 `discard`（守卫：只允许从 DRAFT 丢弃） |
 * | `READY → ENQUEUED` | `plan/service.ts` 的 `enqueue` |
 * | `ENQUEUED → DISPATCHED` | `plan/service.ts` 的 `dispatch` |
 * | `DISPATCHED → IN_PROGRESS` | `run/scheduler.ts`（Run 启动） |
 * | `IN_PROGRESS → VERIFYING` | `run/verification.ts` |
 * | `VERIFYING → MERGE_READY / BLOCKED` | `run/verification.ts` 的 `record` |
 * | `MERGE_READY → MERGED` | `run/merge.ts` |
 * | `VERIFYING / MERGE_READY → IN_PROGRESS` | `run/recovery-coordinator.ts` 的对账 |
 * | `BLOCKED → ENQUEUED / IN_PROGRESS / VERIFYING / MERGE_READY` | `run/change-proposal.ts`、对账 |
 * | `NEEDS_PLAN_CHANGE → ENQUEUED` | `run/change-proposal.ts`（改完计划重新入队） |
 */

/** 主路径与恢复边：`DRAFT → READY → ENQUEUED → DISPATCHED → IN_PROGRESS → VERIFYING → MERGE_READY → MERGED`。 */
const PLAN_STATUS_MAIN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  DRAFT: ["READY"],
  READY: ["ENQUEUED"],
  ENQUEUED: ["DISPATCHED"],
  DISPATCHED: ["IN_PROGRESS"],
  IN_PROGRESS: ["VERIFYING"],
  VERIFYING: ["MERGE_READY", "IN_PROGRESS"],
  MERGE_READY: ["MERGED", "IN_PROGRESS"],
  BLOCKED: ["ENQUEUED", "IN_PROGRESS", "VERIFYING", "MERGE_READY"],
  NEEDS_PLAN_CHANGE: ["ENQUEUED"],
  MERGED: [],
  DISCARDED: [],
};

/**
 * 从**任意非终态**都能进入的三个状态：它们不是主路径上的一步，而是"外部把这件事推翻了"——
 * 写它们的地方（调度阻塞、启动修复、确认修订草稿）本来就不知道、也不该知道当前状态。
 * - `BLOCKED`：调度阻塞、执行器阻塞、恢复对账、启动修复；
 * - `READY`：确认修订草稿——改一版再确认，回到"已确认"重来；
 * - `NEEDS_PLAN_CHANGE`：变更提案要求改计划。
 *
 * `MERGED` 也在其中（启动修复会把"没有确认记录却到了后面"的行拉回 `BLOCKED`），
 * 所以**真正不可逆的终态只有 `DISCARDED`**。
 */
const PLAN_STATUS_RESET_TARGETS: readonly PlanStatus[] = ["BLOCKED", "READY", "NEEDS_PLAN_CHANGE"];

/**
 * 能被**丢弃**的状态：还没有真正开始执行、也没有活着的 Run 的那些。
 *
 * `DRAFT`（没确认）、`READY`（确认了但没入队）、`BLOCKED` / `NEEDS_PLAN_CHANGE`（卡住了，人已经
 * 决定不要它）。**排除**的是：`ENQUEUED` / `DISPATCHED`（正排在调度队列里）、`IN_PROGRESS` /
 * `VERIFYING`（有 Run 在跑）、`MERGE_READY`（活干完了、在等人合并——丢它会让一份待合并的成果失去
 * 归属）、`MERGED`（已经合进去了，无可丢弃）。
 *
 * 为什么此前只允许 `DRAFT`：丢弃当初是为"确认之前反悔"设计的。但**一个建错的需求否则是永久的**
 * ——它只能改名，不能收掉，而 `BLOCKED` 恰恰是最需要收掉的那一类（卡住了、又不打算改计划）。
 */
const DISCARDABLE_PLAN_STATUSES: readonly PlanStatus[] = ["DRAFT", "READY", "BLOCKED", "NEEDS_PLAN_CHANGE"];

/** 这个状态能不能被丢弃；`PlanService.discard` 与 `canTransitionPlanStatus` 共用它。 */
export function canDiscardPlanStatus(from: PlanStatus): boolean {
  return DISCARDABLE_PLAN_STATUSES.includes(from);
}

/** 这一步转换合法吗。（`from === to` 不算转换，调用方自己跳过。） */
export function canTransitionPlanStatus(from: PlanStatus, to: PlanStatus): boolean {
  if (from === "DISCARDED") return false;
  if (to === "DISCARDED") return canDiscardPlanStatus(from);
  if (PLAN_STATUS_RESET_TARGETS.includes(to)) return true;
  return PLAN_STATUS_MAIN_TRANSITIONS[from].includes(to);
}

/** 统一记录 Plan 状态变更；领域语义事件仍由各业务服务分别保留。 */
export function updatePlanStatus(
  store: PipelineStore,
  plan: CandidatePlan,
  updates: Partial<CandidatePlan>,
  reason?: string | null,
): CandidatePlan {
  const nextStatus = updates.status ?? plan.status;
  // **先判后写**：非法转换当场抛错。写完再检查就晚了——`store.updatePlan` 已经落库，
  // 抛错只会留下一个停在不合法状态上的 Plan，比不抛更糟。
  if (nextStatus !== plan.status && !canTransitionPlanStatus(plan.status, nextStatus)) {
    throw new Error(`Illegal plan status transition: ${plan.status} → ${nextStatus} (plan ${plan.id})`);
  }
  const updated = store.updatePlan({ ...plan, ...updates });
  if (updated.status !== plan.status) {
    store.appendEvent({
      type: "plan.status.changed",
      aggregateId: plan.id,
      payload: {
        planId: plan.id,
        fromStatus: plan.status,
        toStatus: updated.status,
        revision: updated.revision,
        runId: updated.runId,
        reason: reason ?? updated.attentionReason ?? null,
      },
    });
  }
  return updated;
}
