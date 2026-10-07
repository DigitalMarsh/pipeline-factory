/**
 * 模块职责：ExplorerView 消息时间线的滚动位置状态——"是否已滚到底"与"当前激活的是哪一条导航项"。
 *
 * 维护提示：
 * 1. `updateActiveTimeline` **只被 `updateTimelineScrollState` 调用**，所以它没有对外暴露。
 *    它读的是真实 DOM（`scrollTop` + `getBoundingClientRect`），不是响应式数据——
 *    重命名或调整 `data-nav-key` 的取值规则时，必须同步 utils 里的 `activityTarget` / `planAnchorKey`，
 *    否则激活态会静默错位（类型系统看不见 `dataset` 的字符串约定）。
 * 2. `marker` 的 72 是滚动的"判定线"（视口顶部往下 72px 以内的最后一条算激活）。
 *    它必须与样式里的顶部留白一致，改样式时要一起改。
 * 3. 本文件是 P7 第二级从 `ExplorerView.vue` 抽出的，**逻辑逐字未改**。
 */
import { ref, type Ref } from "vue";
import type { ExplorerActivityItem, Plan } from "../types";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";
import { planAnchorKey, planForActivity } from "../utils/planTimeline";
import { isTimelineAtLatest as isTimelineAtLatestPosition, scrollTimelineToLatest } from "../utils/scrollTimeline";

/** 时间线滚动依赖的外部状态。两者都是视图侧的 computed，本文件只读。 */
export type TimelineScrollDeps = {
  /** 已经过滤到当前激活需求的可见活动，用于把 `message-*` 键反查回活动项。 */
  visibleActivity: Ref<ExplorerActivityItem[]>;
  /** 活动 id → 挂在其上的 Plan 卡片，用于推导当前激活的 Plan 锚点。 */
  planBindings: Ref<Map<string, Plan>>;
};

export function useTimelineScroll(timeline: Ref<HTMLElement | null>, deps: TimelineScrollDeps) {
  const showScrollToLatest = ref(false);
  const activeTimelineKey = ref("");
  const activePlanKey = ref("");

  function jumpToTimelineTarget(targetId: string, key: string) {
    const target = document.getElementById(targetId);
    if (!timeline.value || !target) return;
    const timelineRect = timeline.value.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = timeline.value.scrollTop + targetRect.top - timelineRect.top - 20;
    timeline.value.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    activeTimelineKey.value = target.dataset.navKey?.startsWith("message-") ? target.dataset.navKey : key;
    activePlanKey.value = key.startsWith("plan-") ? key : "";
  }

  function updateActiveTimeline() {
    if (!timeline.value) return;
    const nodes = [...timeline.value.querySelectorAll<HTMLElement>("[data-nav-key]")];
    const marker = timeline.value.scrollTop + 72;
    const timelineRect = timeline.value.getBoundingClientRect();
    let current = nodes[0]?.dataset.navKey ?? activeTimelineKey.value;
    for (const node of nodes) {
      const nodeTop = timeline.value.scrollTop + node.getBoundingClientRect().top - timelineRect.top;
      if (nodeTop <= marker && node.dataset.navKey) current = node.dataset.navKey;
      if (nodeTop > marker) break;
    }
    activeTimelineKey.value = current;
    if (current.startsWith("plan-")) {
      activePlanKey.value = current;
      return;
    }
    const activeMessage = current.startsWith("message-")
      ? deps.visibleActivity.value.find((item) => activityTarget(item, 0) === current)
      : null;
    activePlanKey.value = activeMessage ? planAnchorKey(planForActivity(activeMessage, deps.planBindings.value)) : "";
  }

  function updateTimelineScrollState() {
    showScrollToLatest.value = timeline.value ? !isTimelineAtLatestPosition(timeline.value) : false;
    updateActiveTimeline();
  }

  function jumpToLatest() {
    if (!timeline.value) return;
    scrollTimelineToLatest(timeline.value);
    showScrollToLatest.value = false;
  }

  return { showScrollToLatest, activeTimelineKey, activePlanKey, jumpToLatest, jumpToTimelineTarget, updateTimelineScrollState };
}
