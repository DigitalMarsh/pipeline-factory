/**
 * 模块职责：Explorer 页面的**会话状态**——当前 Project 目录、当前 Explorer 线程、消息流，
 * 以及隔离项目切换的**请求令牌守卫**（`activeRequestToken` + `ProjectRequestScope`）。
 *
 * 维护提示：
 * 1. **抽取顺序**：方案表把本 composable 排在第二级最后（因为它"是 1907 行的中枢"），
 *    实际必须排在**最前**。判据是实测出来的依赖方向：`refreshPlanProjection` →
 *    `loadActivePlanWorkspace` 会写 `turns` / `activity` / 输入请求，并读本文件的令牌守卫，
 *    所以"需求投影"与"输入请求"两个 composable 都依赖本文件，反过来不成立。
 *    **按"被依赖者先抽"（方案自己的规律），不是按方案表里的列举顺序。**
 * 2. **令牌守卫逐字搬运，没有"顺手理顺"。** 它由两条独立判据合成：
 *    `requestScope.isCurrent(token, projectId)` 管"令牌是否已被更新的请求取代"，
 *    `projectId.value === requestProjectId` 管"路由上的项目是否已经换掉"。
 *    两者都要留——项目切换时路由更新与令牌签发不是同一个时刻，只留一条会漏掉一种竞态。
 * 3. **`explorerEventSequence`（SSE 续传游标）归 `usePlanProjection`**，不属于本文件：
 *    它的写侧在 workspace / activity 响应带的 `lastEventSequence` 与投影复位，读侧暂时还在
 *    视图的 SSE 建连路径；等 `useExplorerSse` 抽出时，读侧以 ref 传入即可，不要再复制游标。
 * 4. `resetSessionState()` **只清"线程级"那三个字段**（`thread` / `turns` / `activity`），
 *    对应视图里 `resetThreadState` 的会话部分；`explorers` / `projectRuns` / `project`
 *    是"项目级"的，由项目切换路径（视图的 `resetProjectState`）清——**两者不要合并**：
 *    切换线程时目录必须留着，合并会让左侧列表在每次切线程时空一下。
 *    视图的 `resetThreadState` 是跨全部 composable 的总复位，先调本函数、再清自己那部分。
 */
import { ref, type Ref } from "vue";
import type { ExplorerActivityItem, ExplorerThread, ExplorerTurn, Project, Run } from "../types";
import { createProjectRequestScope } from "../utils/projectRoutes";

export type ExplorerSessionDeps = {
  /** 当前路由上的 Project id。令牌校验要同时确认"令牌未过期"与"路由项目未切换"。 */
  projectId: Ref<string>;
};

export function useExplorerSession(deps: ExplorerSessionDeps) {
  // 页面状态按 Project 目录、当前 Explorer 线程、消息流分层保存，
  // 避免切换 Project/Thread 时把旧项目的响应式数据留在当前视图。
  const project = ref<Project | null>(null);
  const projects = ref<Project[]>([]);
  const thread = ref<ExplorerThread | null>(null);
  const explorers = ref<ExplorerThread[]>([]);
  const turns = ref<ExplorerTurn[]>([]);
  const activity = ref<ExplorerActivityItem[]>([]);
  const projectRuns = ref<Run[]>([]);

  const requestScope = createProjectRequestScope();
  let activeRequestToken = 0;

  /** 当前有效的请求令牌。异步回调在发起时捕获它，返回后用它判断是否已被更新的请求取代。 */
  function projectScopeToken(): number {
    return activeRequestToken;
  }

  /** 签发新令牌并记为当前令牌。`begin` 本身就会让旧令牌失效。 */
  function beginProjectScope(requestProjectId: string): number {
    activeRequestToken = requestScope.begin(requestProjectId);
    return activeRequestToken;
  }

  /** 作废当前令牌但不签发新的——用于"先清空、稍后由 load() 签发"的路径。 */
  function invalidateProjectScope(): void {
    requestScope.invalidate();
  }

  function isCurrentProjectScope(requestProjectId: string, requestToken = activeRequestToken): boolean {
    return requestScope.isCurrent(requestToken, requestProjectId) && deps.projectId.value === requestProjectId;
  }

  /** 只清线程级字段（thread / turns / activity）；项目级目录与跨 composable 的总复位不归它管。 */
  function resetSessionState(): void {
    thread.value = null;
    turns.value = [];
    activity.value = [];
  }

  return {
    project,
    projects,
    thread,
    explorers,
    turns,
    activity,
    projectRuns,
    projectScopeToken,
    beginProjectScope,
    invalidateProjectScope,
    isCurrentProjectScope,
    resetSessionState,
  };
}
