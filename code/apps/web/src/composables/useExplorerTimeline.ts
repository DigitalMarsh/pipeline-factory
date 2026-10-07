/**
 * 模块职责：把"当前激活需求"的 Turn / Activity / 结构化输入 / Plan 投影成一条渲染用的消息时间线。
 *
 * 维护提示：
 * 1. `visibleActivity` 里那条 `activity` 为空时用 `visibleTurns` 合成兜底活动的分支是**必要的**：
 *    SSE 断线重连期间 `activity` 会是空的，此时若不做兜底，时间线会整条消失。
 *    合成出来的 id 带 `fallback-` 前缀，与后端下发的真实 id 不会碰撞。
 * 2. `activeTaskPlans` 只是 `planBindings` 的中间量，**没有对外暴露**；
 *    要复用它请从 `allPlans` 重新过滤，不要把它变成公共 API。
 * 3. 本文件是 P7 第二级从 `ExplorerView.vue` 抽出的，**投影逻辑逐字未改**，只把原先的
 *    闭包捕获（`turns` / `activity` / `inputRequests` / `allPlans` / `activeExplorerPlan`）
 *    改成显式入参。纯投影函数本身仍在 `utils/explorerTimeline.ts` 与 `utils/planTimeline.ts`。
 */
import { computed, type Ref } from "vue";
import type { ExplorerActivityItem, ExplorerInputRequest, ExplorerPlan, ExplorerTurn, Plan } from "../types";
import { buildExplorerTimeline } from "../utils/explorerTimeline";
import { belongsToExplorerPlan } from "../utils/explorerScope";
import { planActivityBindings as buildPlanActivityBindings } from "../utils/planTimeline";
import { readableAssistantText } from "../utils/planProtocolDisplay";
import { turnContent } from "../utils/turnStatus";

/** 时间线投影依赖的原始数据。全部只读。 */
export type ExplorerTimelineDeps = {
  /** 当前线程的 Turn（含乐观插入的用户消息）。 */
  turns: Ref<ExplorerTurn[]>;
  /** 后端下发的活动流；为空时用 `turns` 兜底合成。 */
  activity: Ref<ExplorerActivityItem[]>;
  inputRequests: Ref<ExplorerInputRequest[]>;
  /** 候选 / 已确认 / 已入队 / 已派发的 Plan 去重合并结果（由视图提供，见 `allPlans`）。 */
  allPlans: Ref<Plan[]>;
  /** 当前激活需求；用于把上面四份数据都过滤到"这一条需求"的范围内。 */
  activeExplorerPlan: Ref<ExplorerPlan | null>;
};

export function useExplorerTimeline(deps: ExplorerTimelineDeps) {
  const belongsToActivePlan = (planId: string | null | undefined): boolean =>
    belongsToExplorerPlan(planId, deps.activeExplorerPlan.value?.id ?? null);

  const visibleTurns = computed(() => deps.turns.value.filter((turn) => belongsToActivePlan(turn.explorerPlanId)));
  const visibleActivity = computed(() =>
    (deps.activity.value.length
      ? deps.activity.value
      : (visibleTurns.value.map((turn) => ({
          id: `fallback-${turn.id}`,
          explorerId: turn.threadId,
          turnId: turn.id,
          sequence: turn.sequence,
          kind: turn.role === "user" ? "USER_MESSAGE" : "ASSISTANT_MESSAGE",
          status:
            turn.status === "FAILED"
              ? "FAILED"
              : turn.status === "RUNNING"
                ? "RUNNING"
                : turn.status === "WAITING_FOR_INPUT" || turn.status === "QUEUED"
                  ? "WAITING"
                  : "COMPLETED",
          title: turn.role === "user" ? "You" : "Plan Explorer",
          summary: turn.role === "assistant" ? readableAssistantText(turnContent(turn)) : turnContent(turn),
          details: turn.error ? { error: turn.error } : null,
          occurredAt: turn.createdAt,
          explorerPlanId: turn.explorerPlanId,
        })) as ExplorerActivityItem[])
    ).filter((item) => belongsToActivePlan(item.explorerPlanId)),
  );
  const visibleInputRequests = computed(() => deps.inputRequests.value.filter((item) => belongsToActivePlan(item.explorerPlanId)));

  const activeTaskPlans = computed<Plan[]>(() => deps.allPlans.value.filter((plan) => belongsToActivePlan(plan.explorerPlanId)));
  const planBindings = computed(() => buildPlanActivityBindings(activeTaskPlans.value, visibleActivity.value));
  const timelineItems = computed(() => buildExplorerTimeline(visibleActivity.value, visibleInputRequests.value));

  return { visibleTurns, visibleActivity, visibleInputRequests, planBindings, timelineItems };
}
