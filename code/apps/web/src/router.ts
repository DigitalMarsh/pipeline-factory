/**
 * 模块职责：定义控制台页面路由和 Project/Thread/Run 的参数边界。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { createRouter, createWebHistory, type LocationQueryRaw } from "vue-router";
import ExplorerView from "./views/ExplorerView.vue";
import ProjectCatalogView from "./views/ProjectCatalogView.vue";
import ProjectExecuteView from "./views/WorkbenchView.vue";
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
 * **为什么带 `explorerId` / `explorerPlanId` 而不只是 `runId`**：探索视图挑线程只看 `explorerId`，没有就
 * 退回「项目当前线程」，再在那个线程的需求里找 `explorerPlanId`。只带 `runId` 的话线程多半不是这条 Run
 * 所属的那一条——抽屉**按 `runId` 能把这条 Run 本身渲染对**，但左栏落在别人的需求上；更糟的是，
 * 之后点一下「Run」页签，`switchDrawerTab` 会按**当前选中的需求行**重新推导 runId，于是把人带到
 * 另一条 Run 去（实测）。所以这两个 id 要一起带上。
 *
 * 这也决定了它**不能写成路由记录上的 `redirect`**——那个必须同步返回，拿不到要查两个接口才知道的 id。
 * 写在记录的 `beforeEnter` 里则可以异步（`beforeEach` 也行，但那样得自己拿正则去认路径；
 * `beforeEnter` 拿到的已经是解析好的 `params`）。
 */
async function runDetailRedirect(projectId: string, runId: string, query: LocationQueryRaw) {
  const target: LocationQueryRaw = { ...query, runId, requirementTab: "task" };
  try {
    const run = (await api.getRun(runId)).run;
    const plan = (await api.getPlan(run.planId)).plan;
    target.explorerId = plan.sourceExplorerThreadId;
    if (plan.explorerPlanId) target.explorerPlanId = plan.explorerPlanId;
  } catch {
    /* 查不到就退回只带 runId 的地址——Run 本身仍能按 id 渲染出来 */
  }
  return { path: `/projects/${encodeURIComponent(projectId)}/explorer`, query: target };
}

/** 页面路由以 Project 为隔离边界，未知 Project 由页面加载错误引导回 Catalog。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: ProjectCatalogView },
    { path: "/projects", component: ProjectCatalogView },
    /**
     * 退役的「新建项目」整页 → 目录页上的新建对话框（见 `ProjectCatalogView` 的 `create=1`）。
     *
     * 与退役的「项目设置」整页是同一种收法：创建项目现在到处都是**对话框**（目录页的「新建项目」
     * 按钮、探索左栏的「新建项目」），整页那条 `/projects/new` 已经**没有任何入口**。留重定向而不是
     * 删掉，是因为这个地址可能还在书签、聊天记录、终端历史里；`create=1` 是语义那一半——只把用户丢到
     * 目录页、不打开表单，他会以为这个地址坏了。
     */
    { path: "/projects/new", redirect: { path: "/projects", query: { create: "1" } } },
    { path: "/projects/:projectId/execute", component: ProjectExecuteView },
    { path: "/projects/:projectId/explorer", component: ExplorerView },
    {
      path: "/projects/:projectId/plans",
      redirect: (to) => ({
        path: `/projects/${encodeURIComponent(String(to.params.projectId))}/explorer`,
        query: { ...to.query, contextPanel: "plan-center" },
      }),
    },
    /**
     * 退役的「Run 详情」整页地址（见 `runDetailRedirect`）。**它没有自己的页面了**，所以这里的
     * `component` 永远不会被渲染——留一个什么都不画的占位，只是为了让 vue-router 认得这条路径
     * （不登记的话每次命中都会在控制台报一句 `No match found for location`，而重定向本身照常发生，
     * 更容易让人以为坏了）。真正的去向由 `beforeEnter` 决定。
     */
    {
      path: "/projects/:projectId/runs/:runId",
      component: { render: () => null },
      beforeEnter: (to) => runDetailRedirect(String(to.params.projectId), String(to.params.runId), to.query),
    },
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
