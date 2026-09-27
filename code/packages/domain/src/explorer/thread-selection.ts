/**
 * 模块职责：ExplorerThread 级的两件小事——"项目当前指向哪个 Explorer"（指针）与
 *   "还没起好标题时显示什么"（占位标题）。
 *
 * 为什么单独成模块：这两个函数被 PlanService、ExplorerService、ExplorerThreadService 三个
 *   Service 共用。它们必须比这三个 Service 先落到 index.ts 之外，否则任何一个 Service 搬走时
 *   反向从 index.js 取值，就会引出一条新的值级回流边（P2 刚清零，批 B 已两次踩到同一形状）。
 *   它们是零 index 值依赖的：只吃 PipelineStore 与 ExplorerThread，两者都是类型。
 *
 * 维护提示：
 *   1) selectCurrentExplorer 写的是 **project 上的指针**，不是 thread 上的字段；它只在
 *      `currentExplorerThreadId` 真的变化时才写，避免每次注册线程都追加一条无意义事件。
 *      去掉这个判断会让 project.explorer.selected 事件在下游的去重逻辑里失去意义。
 *   2) 该函数是"线程被选中"这件事的唯一出处。ExplorerService 的 select / 删除后回退、
 *      PlanService 的 registerThread 都走它——绕过它直接改 project 会让 UI 的当前线程
 *      与实际指针不一致。
 *   3) projectPlaceholderExplorerTitle 读的是 project.shortName，**不是 thread 自己的字段**。
 *      这就是它必须接收 store 的原因；若哪天标题生成器改成纯函数，这里也要一并去掉 store 参数，
 *      不要保留一个用不到的入参。
 */
import { placeholderExplorerTitle } from "./explorer-title.js";
import type { ExplorerThread } from "../index.js";
import type { PipelineStore } from "../store/pipeline-store.js";

/** 把 project 的当前 Explorer 指针指向给定线程；指针未变化时不写库、不追加事件。 */
export function selectCurrentExplorer(store: PipelineStore, thread: ExplorerThread): void {
  const project = store.getProject(thread.projectId);
  if (project && project.currentExplorerThreadId !== thread.id) {
    store.updateProject({ ...project, currentExplorerThreadId: thread.id, updatedAt: store.now() });
    store.appendEvent({ type: "project.explorer.selected", aggregateId: project.id, payload: { projectId: project.id, explorerId: thread.id } });
  }
}

/** 线程的占位标题：由创建时间与项目简称合成，供标题生成器异步替换。 */
export function projectPlaceholderExplorerTitle(store: PipelineStore, thread: ExplorerThread): string {
  return placeholderExplorerTitle(thread.createdAt, store.getProject(thread.projectId)?.shortName);
}
