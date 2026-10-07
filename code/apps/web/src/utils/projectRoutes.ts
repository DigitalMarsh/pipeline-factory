/**
 * Returns a usable Project identifier for project-scoped routes.
 * During the first render the Project is not loaded yet; returning null keeps
 * RouterLink from creating an invalid `/projects//...` destination.
 */
export function normalizeProjectId(projectId: string | null | undefined): string | null {
  const normalized = projectId?.trim();
  return normalized || null;
}

/**
 * Project 工作区里的"模块"。**没有 `settings`**：项目设置现在是 Explorer 里的对话框
 * （见 `views/ExplorerView.vue` 的 `openProjectSettingsDialog`），不再是一个可停留的页面，
 * 所以它不该参与"切项目时保持同类模块"的判断。旧的 `/settings` 地址由 router 重定向成
 * `explorer?settings=1`。
 */
export type ProjectWorkspaceModule = "explore" | "execute";

/** 根据当前地址识别 Project 工作区，供顶部切换器保持同类模块。 */
export function projectModuleForPath(path: string): ProjectWorkspaceModule | null {
  const segment = path.split("?")[0]?.split("#")[0]?.split("/")[3];
  if (segment === "explorer") return "explore";
  if (segment === "plans" || segment === "runs") return "execute";
  return null;
}

/** 生成项目切换后的稳定工作区地址；Run 统一回到目标项目 Execute。 */
export function projectPathForModule(module: ProjectWorkspaceModule, projectId: string): string {
  const encodedProjectId = encodeURIComponent(projectId);
  const suffix = module === "explore" ? "explorer" : "plans";
  return `/projects/${encodedProjectId}/${suffix}`;
}

export type ProjectRequestScope = {
  begin(projectId: string): number;
  invalidate(): void;
  isCurrent(token: number, projectId: string): boolean;
};

/** 用单调递增 token 隔离项目切换前发出的请求和事件回调。 */
export function createProjectRequestScope(): ProjectRequestScope {
  let token = 0;
  let activeProjectId: string | null = null;
  return {
    begin(projectId: string): number {
      token += 1;
      activeProjectId = projectId;
      return token;
    },
    invalidate(): void {
      token += 1;
      activeProjectId = null;
    },
    isCurrent(candidateToken: number, projectId: string): boolean {
      return candidateToken === token && activeProjectId === projectId;
    },
  };
}
