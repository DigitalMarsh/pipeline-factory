/**
 * 模块职责：**左侧栏那两个实体状态**（Project / ExplorerThread）的展示文案。
 *
 * 为什么单独一个模块：Project 的文案此前有三个各自手写的副本
 * （`views/ProjectCatalogView.vue`、`components/ThreadRail.vue`，以及此后退役的一个项目管理弹窗），
 * 三份都是 `status === "ACTIVE" ? "Active" : "Archived"`；ExplorerThread 那份还多一档
 * （非 ACTIVE 非 ARCHIVED 的线程一律显示 `Completed`——`WAITING_FOR_INPUT` 与 `COMPRESSED`
 * 都被读成"已完成"，那是一句错话，本轮拆开了）。
 *
 * 现在的调用方有两个：`views/ProjectCatalogView.vue`（Project）与
 * `components/ThreadRail.vue`（Project + ExplorerThread），两边都从这里取文案。
 *
 * 与 `utils/statusTag.ts` 的分工：那份管**颜色**（`projectStatusTagType` /
 * `explorerThreadStatusTagType`），这份管**文案**——同一个状态一个词，改一处就两处都对。
 */
import type { ExplorerThread, Project } from "../types";

export function projectStatusLabel(status: Project["status"]): string {
  return status === "ACTIVE" ? "启用中" : "已归档";
}

/**
 * ExplorerThread 的四个状态各说各的，**不要把它们压成"还在用 / 已归档"两档**：
 * 等待输入与已压缩都是真实且需要被看见的状态，颜色可以相同，文案不能相同。
 */
export function explorerThreadStateLabel(state: ExplorerThread["state"]): string {
  if (state === "ARCHIVED") return "已归档";
  if (state === "WAITING_FOR_INPUT") return "等待输入";
  if (state === "COMPRESSED") return "已压缩";
  return "启用中";
}
