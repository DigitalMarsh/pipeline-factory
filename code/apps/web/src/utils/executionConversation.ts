/**
 * 模块职责：执行会话的**分组与折叠**——把 `projectExecutionJournal`（utils/executionStream.ts）
 * 推导出来的条目按 Plan 任务 / 补充要求那一轮 / 未归属摆成一屏一屏，并回答每个组
 * "哪几条折进上方的过程记录、哪几条留在外面"。
 *
 * 为什么单独成文件：这一簇原先住在 `views/RunDetailView.vue` 的 script 里，与视图的加载、SSE、控制
 * 动作混在一处——改一次分组要在一个 1133 行的文件里从头读到尾。它与 `utils/executionStream.ts`
 * 是**两层不同的事**：那边回答"一条事实怎么变成一条消息"（消息清单、权重、形态），
 * 这边回答"这些消息怎么摆成一屏"。分法与探索侧一致（`utils/explorerTimeline.ts` +
 * `composables/useExplorerTimeline.ts`）。
 *
 * 维护提示：
 * 1. **纯函数，不读任何 ref**：线程状态（决定"这一步还在跑吗"）由参数传入，所以这里可以单测。
 *    响应式那一层在 `composables/useExecutionConversation.ts`。
 * 2. 本文件**不判断"这条消息该不该显示"**——那是权重表 `EXECUTION_MESSAGE_WEIGHTS` 的事，
 *    也不判断"什么算过程"——那是 `foldsIntoProcess` 的事。这里只做分组与按组统计。
 * 3. `continuation` 那一组的判据只有一处：投影收尾给补充轮打上的 `item.continuation`
 *    （见 executionStream.ts 的 `projectExecutionJournal`）。**这里不再判 loop、也不看 taskId**——
 *    判据抄第二份就是"某个组里悄悄多一行"的成因。
 */
import type { ExecutionTask } from "../types";
import { durationBetween, formatDuration } from "./duration";
import { executionMessageWeight, foldsIntoProcess, type ExecutionStreamItem } from "./executionStream";

export type ExecutionConversationGroup = {
  id: string;
  /** `continuation` = 补充要求起的那一轮；它不属于任何计划任务，所以单独成组。 */
  kind: "plan" | "task" | "continuation" | "unattributed" | "pending";
  task?: ExecutionTask;
  tasks?: ExecutionTask[];
  items: ExecutionStreamItem[];
};

/**
 * Run 级活动：没有归属于任何执行步骤的 activity 条目——Run 的创建、生命周期钩子、验证、
 * 门禁、续跑检查点、暂停 / 恢复。它们讲的是整个 Run，不属于任何一步，所以**不留在执行会话里**，
 * 改由顶部 RUN CONTEXT 卡片承载（见 ExecutionHeaderStatus 的「Run 级活动」一节）。
 *
 * 判据只用 kind + taskId：`activity` 且无 taskId。曾经这里按"事件类型是否为 RUN_CREATED /
 * HOOK_* / VERIFICATION"列举，但那样每加一种 Run 级事件都要回来补一次，且同样无归属的
 * `Executor started` / `Execution gate` 会被漏在会话里名不副实。
 */
export function isRunActivity(item: ExecutionStreamItem): boolean {
  // **补充轮不是 Run 级活动**：它的条目同样没有 taskId，但它们属于"你补的那一轮"那一组，
  // 不该被吸到顶部的 RUN CONTEXT 卡片里（那样会话里就少了几行，而卡片上多了一堆过程）。
  return item.kind === "activity" && !item.taskId && !item.continuation;
}

/**
 * 把一条 Run 的全部条目分组成会话。
 *
 * 组的顺序是刻意的：冻结方案在最前，然后按 Plan 任务的顺序（`executionTasks` 的顺序），
 * 补充要求那几轮按轮次，最后才是归因缺口。
 */
export function buildExecutionConversation(messages: ExecutionStreamItem[], tasks: ExecutionTask[]): ExecutionConversationGroup[] {
  const groups: ExecutionConversationGroup[] = [];
  const planMessages = messages.filter((item) => item.kind === "plan");
  if (planMessages.length) groups.push({ id: "plan", kind: "plan", items: planMessages });
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    groups.push({ id: `task-${task.id}`, kind: "task", task, items: messages.filter((item) => item.taskId === task.id) });
  }
  // **补充要求自己一组**：它不属于任何计划任务，也不该折进某个步骤的过程记录里
  // （用户报的正是"补充内容被放进了最后那个 task"）。这一批条目在投影里就统一摘掉了
  // `taskId`、打上了 `continuation`（见 projectExecutionJournal 收尾那一段）——
  // 所以这里不用再判 loop，判据只有一处。
  // **一轮补充一组**。两轮合成一组的话，组头只能写其中一句话，另一轮的正文就没了标题
  // （实测：第二轮那句只能当组里的一行看）。轮次编号在投影里就排好了，见 projectExecutionJournal 收尾。
  const rounds = new Map<number, ExecutionStreamItem[]>();
  for (const item of messages) {
    if (!item.continuation) continue;
    const key = item.continuationRound ?? 0;
    const bucket = rounds.get(key);
    if (bucket) bucket.push(item);
    else rounds.set(key, [item]);
  }
  for (const [index, items] of rounds) groups.push({ id: `continuation-${index}`, kind: "continuation", items });
  // 剩下的才是真正的归因缺口：本该落进某个执行步骤、却没有归属的模型 / 工具条目。
  // 现代 Run 不产生这类条目，它们集中在 2026-09-25 之前的数据里。
  // **`continuation` 要排掉**：那些条目同样没有 taskId，但它们已经在上面的组里了——
  // 不排就是同一条消息渲染两次（实测：补充那 16 条会同时出现在「补充要求」和「未归属」两组）。
  const unattributed = messages.filter(
    (item) =>
      item.kind !== "plan" &&
      item.kind !== "user" &&
      !item.continuation &&
      !isRunActivity(item) &&
      (!item.taskId || !taskIds.has(item.taskId)),
  );
  if (unattributed.length) groups.push({ id: "unattributed", kind: "unattributed", items: unattributed });
  return collapsePendingTaskGroups(groups);
}

/**
 * 把**连续的**空执行步骤折成一行。
 * 5 张各占一张卡、每张只写"尚无结构化进度事件表明此任务已开始"是纯噪音；但"哪几步还没轮到"
 * 这个信息要保留，所以折成一行、把标题列出来，而不是整段丢掉。只在**连续**时合并：
 * 中间夹着有内容的步骤时分开显示，"跳过第 2 步先做第 3 步"这种事实才看得出来。
 */
function collapsePendingTaskGroups(groups: ExecutionConversationGroup[]): ExecutionConversationGroup[] {
  const collapsed: ExecutionConversationGroup[] = [];
  let pending: ExecutionTask[] = [];
  const flush = () => {
    const first = pending[0];
    if (first) collapsed.push({ id: `pending-${first.id}`, kind: "pending", items: [], tasks: pending });
    pending = [];
  };
  for (const group of groups) {
    if (group.kind === "task" && group.task && group.items.length === 0) {
      pending.push(group.task);
      continue;
    }
    flush();
    collapsed.push(group);
  }
  flush();
  return collapsed;
}

/**
 * **这一步现在还在跑吗。** 它在跑的时候一切照常显示——照 OpenClaw：
 * *live response text and the working indicator stay outside the log*。跑完之后过程才折起来，
 * 把视线还给这一步的结论。
 *
 * 判据取任务自己的状态（`IN_PROGRESS`），不是"有没有最近的消息"——后者会把刚起步的一步
 * 当成跑完，把它唯一那两条线索折掉。
 */
export function stepRunning(group: ExecutionConversationGroup, threadState: string): boolean {
  if (group.task) return group.task.status === "IN_PROGRESS";
  // 没有任务归属的组（未归属事件）：Run 还活着就当"进行中"，宁可多显示一行也不藏。
  return threadState === "ACTIVE";
}

/**
 * **折进上方过程记录的那一批**。判据全在 `foldsIntoProcess` 里——视图只负责回答"这一步跑完没有"。
 */
export function foldedItems(group: ExecutionConversationGroup, threadState: string): ExecutionStreamItem[] {
  const stepRunningHere = stepRunning(group, threadState);
  return group.items.filter((item) => foldsIntoProcess(item, { stepRunning: stepRunningHere }));
}

/**
 * 按**权重**渲染（表在 utils/executionStream.ts 的 `EXECUTION_MESSAGE_WEIGHTS`）。
 * 视图不自己判断"这条该不该显示"：权重是产品决定，集中在一张表里，改那里即可。
 * `hidden` 的条目连计数都不进——它们不是内容，只是 Provider 的机制回显与运行事实。
 */
export function visibleItems(group: ExecutionConversationGroup, threadState: string): ExecutionStreamItem[] {
  // 判据是"除折叠与不渲染之外"，不是"属于某几种权重"——写成白名单时，
  // 新增一种权重（比如你自己说的话那条 `answer`）会让那一类消息**从会话里静默消失**。
  const folded = new Set(foldedItems(group, threadState).map((item) => item.id));
  return group.items.filter((item) => executionMessageWeight(item) !== "hidden" && !folded.has(item.id));
}

/**
 * 这一步的用时。**来自任务自己的生命周期事实**（见 `ExecutionTask.startedAt`），
 * 不是从消息时间戳估的——拿不到就返回 null，由模板让那一格**不出现**，
 * 而不是编一个数（OpenClaw 的原话：拿不到时长就写 `Worked`，不估）。
 */
export function stepDuration(group: ExecutionConversationGroup): string | null {
  const task = group.task;
  if (!task?.startedAt || !task.completedAt) return null;
  const ms = durationBetween(task.startedAt, task.completedAt);
  return ms === null ? null : formatDuration(ms);
}

/** 补充要求那一组的标题：直接写你补的那句话（这一组的第一条用户消息）。 */
export function continuationHeading(group: ExecutionConversationGroup): string {
  const prompt = group.items.find((item) => item.kind === "user");
  const text = (prompt?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "这一轮";
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

/** 折起来的那批里，有几条是**认不出来的活动**——这件事本身要说得出口，不能悄悄折掉。 */
export function unclassifiedCount(group: ExecutionConversationGroup, threadState: string): number {
  return foldedItems(group, threadState).filter((item) => item.messageType === "UNCLASSIFIED").length;
}

/**
 * 这一步里**没被折进去的失败**有多少。它要写在折叠标题上——
 * OpenClaw 的原话是 `Worked for 2 minutes, 3 seconds · 2 failed`：
 * 失败**永远可见**，即使这一组是收起的。折起来等于把这轮唯一要你处理的事藏了。
 */
export function failedCount(group: ExecutionConversationGroup, threadState: string): number {
  return visibleItems(group, threadState).filter((item) => item.status === "FAILED").length;
}

/** 一个空步骤那一行写什么——按它**为什么**空分四种，都拿不到才退回兜底。 */
export function taskGroupEmptyNote(task: ExecutionTask): string {
  if (task.status === "UNKNOWN") return "此任务的执行状态和关联会话未记录。";
  if (task.status === "PENDING") return "尚无结构化进度事件表明此任务已开始。";
  if (task.status === "BLOCKED") return task.blockedReason ?? "阻塞原因未记录。";
  return "此任务暂未关联到已记录的执行消息。";
}
