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
 * 这个地址是不是「某个项目的探索工作区」。
 *
 * 它此前叫 `projectModuleForPath`，返回 `"explore" | "execute"` 两档——**「执行台」那条整页退役之后
 * 只剩一档**，于是那个"模块"抽象也一起收了：一个只有一个取值的联合类型不表达任何东西，而它下面还挂着
 * `projectPathForModule(module, id)` 的另一半分支（生成 `/plans`）。`/plans` 与 `/runs` 仍是旧地址，
 * 但它们已经是重定向，路由器不会停在上面，所以不必再认。
 */
export function isExplorerWorkspacePath(path: string): boolean {
  return path.split("?")[0]?.split("#")[0]?.split("/")[3] === "explorer";
}

/** 某个项目的探索工作区地址。项目切换器与"新建项目后跳哪"共用，别再各自拼字符串。 */
export function explorerPathFor(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/explorer`;
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
