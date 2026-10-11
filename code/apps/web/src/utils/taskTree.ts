/**
 * 模块职责：需求在界面上的显示名。
 *
 * **三层命名（全仓界面统一用这一套，别再各叫各的）：**
 *   1) **需求** = `ExplorerPlan`（一次需求探索，编号显示为"需求N：…"）。`taskDisplayTitle` 里的
 *      "Task" 是这一层的**旧称**，标识符保留以免牵动调用点，但界面上与新增注释一律叫"需求"。
 *   2) **方案** = `Plan` / `PlanRevision`（需求探索出的可审阅、可确认、有版本的执行计划）。
 *   3) **任务** = 已确认并进入调度的方案。
 *   4) **执行步骤** = 方案契约里的 `contract.tasks`（一次 Run 内部按序实现的步骤），
 *      UI 里不叫"任务"——它与第 3 层的"任务"不是一回事，混用会让人找不到东西。
 *
 * 维护提示：**关联事实仍然使用 explorerPlanId**（API 与领域命名不动）；改名只发生在界面文案。
 *
 * 这里此前还有一个 `buildTaskTree`（把需求与当前 Plan 投影成聊天区的树）与 `taskRuntimeLabel`，
 * 两者都只剩自己的测试在引用，已删。
 */
import type { ExplorerPlan } from "../types";

export function taskDisplayTitle(task: ExplorerPlan): string {
  const legacyTitle = task.title.replace(new RegExp(`^(?:Plan|Task) ${task.ordinal}\\s*(?:[/：:]\\s*)?`), "").trim();
  const label = task.titleSource === "MANUAL" ? legacyTitle || task.title : task.latestUserMessageSummary || legacyTitle || "待探索";
  return `需求${task.ordinal}：${label}`;
}
