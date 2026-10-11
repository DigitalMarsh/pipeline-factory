/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 * 状态文案**不在这里**——它统一来自 `./planStatus`。本文件此前自带一份私有 `statusLabel`，
 * 成员比共用那份少 `DISCARDED` / `STARTING`，导致同一个 `DISCARDED` 在 rail 上显示成
 * `DISCARDED`、在计划卡片上显示成 `Discarded`。新增状态请改 `planStatus.ts`。
 *
 * 此前这里还有一整组"计划卡片的 rail 条目"：`findPlanForActivity`、`planTimelineItems`，
 * 以及只服务于后者的 `PlanTimelineItem` 类型、`generationTime` / `timeLabel` 两个小函数和
 * `getPlanTimelineTarget`。**它们都只剩自己的测试在引用**，已删——连同 `plan-created-…` 那个
 * DOM 前缀（它对应一条早被删掉的 PLAN CREATED 卡片，现在没有任何渲染方）。
 * 留下的是真正在用的：绑定（`planActivityBindings` / `planForActivity`）与锚点
 * （`planAnchorId` / `planAnchorKey`）——见 `composables/useExplorerTimeline.ts` 等调用点。
 */
import type { ExplorerActivityItem, Plan } from "../types";

/** 返回持久化身份；没有 `planId` / `id` 时返回 null，让调用方显式选择 fallback 语义。 */
export function planIdentityOrNull(plan: Plan): string | null {
  return plan.planId ?? plan.id ?? null;
}

/** 使用 Plan 的持久化 ID 作为跨活动、列表和聊天锚点的稳定身份。 */
export function planIdentity(plan: Plan): string {
  return planIdentityOrNull(plan) ?? plan.title;
}

function readyPlanTitle(activity: ExplorerActivityItem): string | null {
  if (activity.kind !== "ASSISTANT_MESSAGE" || activity.details?.planProtocol !== true || activity.details.status !== "READY") return null;
  return typeof activity.details.title === "string" ? activity.details.title : null;
}

function providerItemId(activity: ExplorerActivityItem): string | null {
  return typeof activity.details?.providerItemId === "string" ? activity.details.providerItemId : null;
}

function planActivities(plan: Plan, activities: ExplorerActivityItem[]): ExplorerActivityItem[] {
  if (!plan.sourceTurnId) return [];
  return activities.filter((activity) => activity.turnId === plan.sourceTurnId && readyPlanTitle(activity) === plan.title);
}

/**
 * 每个 Plan 只绑定一条真正输出 READY 协议的 assistant 消息。
 * providerItemId 是首选事实；旧数据降级为同一 sourceTurnId 内最后一条同标题 READY 消息。
 */
export function planActivityBindings(plans: Plan[], activities: ExplorerActivityItem[]): Map<string, Plan> {
  const bindings = new Map<string, Plan>();
  const uniquePlans = new Map<string, Plan>();
  for (const plan of plans) uniquePlans.set(planIdentity(plan), plan);

  for (const plan of uniquePlans.values()) {
    const candidates = planActivities(plan, activities);
    const exact = plan.providerItemId ? candidates.find((activity) => providerItemId(activity) === plan.providerItemId) : undefined;
    const target = exact ?? candidates.at(-1);
    if (target && !bindings.has(target.id)) bindings.set(target.id, plan);
  }
  return bindings;
}

/**
 * 某条 Activity 行上挂着哪张 Plan 卡片（P7-4 从 `ExplorerView.vue` 下沉）。
 * 绑定表由 `planActivityBindings` 产出，这里只做查找。
 */
export function planForActivity(item: Pick<ExplorerActivityItem, "id">, bindings: Map<string, Plan>): Plan | null {
  return bindings.get(item.id) ?? null;
}

/**
 * 聊天流里"计划卡片"的 DOM 锚点。**必须用 Plan 身份而不是消息起始点**：右侧 Plans 面板点一条
 * 计划，要定位到聊天中真正承载该计划的那张卡片，而不是引出它的那段讨论文字。
 */
export function planAnchorId(plan: Plan | null): string {
  return plan ? `plan-generated-${planIdentity(plan)}` : "";
}

/** 时间线导航项的 key。 */
export function planAnchorKey(plan: Plan | null): string {
  return plan ? `plan-${planIdentity(plan)}` : "";
}
