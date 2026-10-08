/**
 * 模块职责：把执行会话的**分组与折叠**接到视图的响应式状态上——`groups`、Run 级活动、Provider 运行
 * 事实三份推导，以及"按当前线程状态"绑好的折叠判据。
 *
 * 为什么单独抽出来：纯逻辑在 `utils/executionConversation.ts`（可单测、不读 ref），
 * 这一层只做"读哪个 ref、把线程状态传进去"。分法与探索侧一致
 * （`utils/explorerTimeline.ts` 的纯函数 + `composables/useExplorerTimeline.ts` 的绑定）。
 *
 * 维护提示：
 * 1. **判据只传一次**：模板里调用的是本文件绑好的版本（`foldedItems(group)`），
 *    线程状态在这里统一取——散成 `foldedItems(group, thread?.state ?? "")` 是同一个事实抄十几处。
 * 2. `runActivityItems` 与 `runtimeFactItems` 不算"分组"，但它们与分组读的是同一份条目、
 *    又都是"哪几条留在会话里"这件事，所以放在一起：改权重或改判据时只碰一个文件。
 */
import { computed, type Ref } from "vue";
import type { ExecutionTask, ExecutionThread } from "../types";
import { isRuntimeFactItem, type ExecutionStreamItem } from "../utils/executionStream";
import {
  buildExecutionConversation,
  continuationHeading,
  failedCount,
  foldedItems,
  isRunActivity,
  stepDuration,
  taskGroupEmptyNote,
  unclassifiedCount,
  visibleItems,
  type ExecutionConversationGroup,
} from "../utils/executionConversation";

export type ExecutionConversationDeps = {
  thread: Ref<ExecutionThread | null>;
  /** 当前 Run 的全部条目（`projectExecutionJournal` 的产物）。 */
  messages: Ref<ExecutionStreamItem[]>;
  /** Plan 任务的顺序就是分组的顺序，所以传投影后的任务而不是 journal。 */
  tasks: Ref<ExecutionTask[]>;
};

export function useExecutionConversation(deps: ExecutionConversationDeps) {
  function threadState(): string {
    return deps.thread.value?.state ?? "";
  }

  const groups = computed<ExecutionConversationGroup[]>(() => buildExecutionConversation(deps.messages.value, deps.tasks.value));
  const runActivityItems = computed<ExecutionStreamItem[]>(() => deps.messages.value.filter(isRunActivity));
  /**
   * ④「跑模型的程序报的」运行事实：压缩边界、重试、配额、钩子、后台子任务、权限被拒、告警。
   * 它们**不进会话正文**（权重表里一律 `hidden`），由顶部「运行上下文」卡承载——
   * 常态收在展开区里，需要你动手的那几条浮到卡片上（见 `ExecutionHeaderStatus` 的 `runtimeAlert`）。
   */
  const runtimeFactItems = computed<ExecutionStreamItem[]>(() => deps.messages.value.filter(isRuntimeFactItem));

  return {
    groups,
    runActivityItems,
    runtimeFactItems,
    foldedItems: (group: ExecutionConversationGroup) => foldedItems(group, threadState()),
    visibleItems: (group: ExecutionConversationGroup) => visibleItems(group, threadState()),
    failedCount: (group: ExecutionConversationGroup) => failedCount(group, threadState()),
    unclassifiedCount: (group: ExecutionConversationGroup) => unclassifiedCount(group, threadState()),
    stepDuration,
    continuationHeading,
    taskGroupEmptyNote,
  };
}
