/**
 * 模块职责：定义控制台页面路由和 Project/Thread/Run 的参数边界。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { createRouter, createWebHistory } from "vue-router";
import ExplorerView from "./views/ExplorerView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import ProjectCatalogView from "./views/ProjectCatalogView.vue";
import ProjectSettingsView from "./views/ProjectSettingsView.vue";
import ProjectExecuteView from "./views/WorkbenchView.vue";
import ProjectCreateView from "./views/ProjectCreateView.vue";
import PlanCenterView from "./views/PlanCenterView.vue";
import { api } from "./api";

/** 页面路由以 Project 为隔离边界，未知 Project 由页面加载错误引导回 Catalog。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/projects", component: ProjectCatalogView },
    { path: "/projects/new", component: ProjectCreateView },
    { path: "/projects/:projectId/execute", component: ProjectExecuteView },
    { path: "/projects/:projectId/explorer", component: ExplorerView },
    { path: "/projects/:projectId/plans", component: PlanCenterView },
    { path: "/projects/:projectId/runs/:runId", component: RunDetailView },
    { path: "/projects/:projectId/settings", component: ProjectSettingsView },
    { path: "/projects/:projectId/settings/hooks", component: ProjectSettingsView },
  ],
});

router.beforeEach(async (to) => {
  const projectId = typeof to.params.projectId === "string" ? to.params.projectId : null;
  if (!projectId) return true;
  try {
    const projects = (await api.projects()).items;
    return projects.some((project) => project.id === projectId) ? true : "/projects";
  } catch {
    return true;
  }
});
