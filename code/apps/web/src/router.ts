import { createRouter, createWebHistory } from "vue-router";
import ExplorerView from "./views/ExplorerView.vue";
import PlanCenterView from "./views/PlanCenterView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import ProjectCatalogView from "./views/ProjectCatalogView.vue";
import ProjectSettingsView from "./views/ProjectSettingsView.vue";
import { api } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects" },
    { path: "/projects", component: ProjectCatalogView },
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
