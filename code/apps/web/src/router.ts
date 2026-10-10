/**
 * 模块职责：定义控制台页面路由和 Project/Thread/Run 的参数边界。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { createRouter, createWebHistory } from "vue-router";
import ExplorerView from "./views/ExplorerView.vue";
import ProjectCatalogView from "./views/ProjectCatalogView.vue";
import ProjectExecuteView from "./views/WorkbenchView.vue";
import ProjectCreateView from "./views/ProjectCreateView.vue";
import { api } from "./api";
import { readLastProjectId, rememberProjectId, selectDefaultProjectId } from "./routerDefaults";
export { LAST_PROJECT_STORAGE_KEY, selectDefaultProjectId } from "./routerDefaults";

async function resolveRootRoute(): Promise<string> {
  try {
    const projects = (await api.projects()).items;
    const projectId = selectDefaultProjectId(projects, readLastProjectId());
    return projectId ? `/projects/${encodeURIComponent(projectId)}/explorer` : "/projects";
  } catch {
    return "/projects";
  }
}

/**
 * 「项目设置」的旧整页地址 → Explorer 里的设置对话框（见 ExplorerView 的 `?settings=1`）。
 *
 * 为什么留重定向而不是直接删掉：这两条路径在书签、聊天记录、终端历史里到处都是。删掉它们
 * 之后旧链接会静默落到目录页，看起来像"这个项目坏了"。**带上 `settings=1` 是为了保住语义**——
 * 用户输的那个地址本来就想要设置，重定向过去就得把对话框打开；`tab` 一并带过去，因为旧页面与
 * 对话框用的是同一套页签键（general/execution/commands/hooks/models）。
 */
function settingsRedirect(to: { params: Record<string, unknown>; query: Record<string, unknown> }, defaultTab?: string) {
  const projectId = encodeURIComponent(String(to.params.projectId));
  const tab = typeof to.query.tab === "string" ? to.query.tab : defaultTab;
  return { path: `/projects/${projectId}/explorer`, query: { ...to.query, settings: "1", ...(tab ? { tab } : {}) } };
}

/**
 * 「Run 详情」的旧整页地址 `/projects/:projectId/runs/:runId` → 抽屉里的「Run」页签。
 *
 * **这个页面已经退役了**：`RunDetailView` 现在只有内嵌那一种形态，唯一的宿主是需求抽屉；整页那条
 * 路由此前也**没有任何入口**（全仓没有一处 `router.push` / `RouterLink` 拼过它），内容与内嵌形态
 * 完全同一份代码，只是多一个页头。留着它就是留一套"没人走、但每次改都得跟着改"的分支。
 *
 * 为什么留重定向而不是直接删掉——与上面「项目设置」同理：这个地址可能还留在书签、聊天记录、
 * 终端历史里。删掉之后旧链接会静默落到项目目录页，看起来像"这个项目坏了"。
 *
 * **为什么只带 `runId`、不带需求与线程**：`redirect` 必须是同步的（vue-router 不接受返回 Promise
 * 的 redirect），而那两个 id 得从 Run → Plan 查出来。代价可接受——抽屉**按 `runId` 就能把这条 Run
 * 本身渲染对**，受影响的只是左栏需求清单选中哪一条。要连它也对，就得把查 id 挪进 `beforeEach`
 * （那里可以异步），为一条没人走的旧地址不值得。
 */
function runDetailRedirect(to: { params: Record<string, unknown>; query: Record<string, unknown> }) {
  const projectId = encodeURIComponent(String(to.params.projectId));
  return {
    path: `/projects/${projectId}/explorer`,
    query: { ...to.query, runId: String(to.params.runId), requirementTab: "task" },
  };
}

/** 页面路由以 Project 为隔离边界，未知 Project 由页面加载错误引导回 Catalog。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: ProjectCatalogView },
    { path: "/projects", component: ProjectCatalogView },
    { path: "/projects/new", component: ProjectCreateView },
    { path: "/projects/:projectId/execute", component: ProjectExecuteView },
    { path: "/projects/:projectId/explorer", component: ExplorerView },
    {
      path: "/projects/:projectId/plans",
      redirect: (to) => ({
        path: `/projects/${encodeURIComponent(String(to.params.projectId))}/explorer`,
        query: { ...to.query, contextPanel: "plan-center" },
      }),
    },
    { path: "/projects/:projectId/runs/:runId", redirect: (to) => runDetailRedirect(to) },
    { path: "/projects/:projectId/settings", redirect: (to) => settingsRedirect(to) },
    { path: "/projects/:projectId/settings/hooks", redirect: (to) => settingsRedirect(to, "hooks") },
  ],
});

router.beforeEach(async (to) => {
  if (to.path === "/") return resolveRootRoute();
  const projectId = typeof to.params.projectId === "string" ? to.params.projectId : null;
  if (!projectId) return true;
  try {
    const projects = (await api.projects()).items;
    if (!projects.some((project) => project.id === projectId)) return "/projects";
    rememberProjectId(projectId);
    return true;
  } catch {
    return true;
  }
});
