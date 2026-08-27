import { createRouter, createWebHistory } from "vue-router";
import ExplorerView from "./views/ExplorerView.vue";
import PlanCenterView from "./views/PlanCenterView.vue";
import RunDetailView from "./views/RunDetailView.vue";
import HookSettingsView from "./views/HookSettingsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/projects/project-demo/explorer" },
    { path: "/projects/:projectId/explorer", component: ExplorerView },
    { path: "/projects/:projectId/plans", component: PlanCenterView },
    { path: "/projects/:projectId/runs/:runId", component: RunDetailView },
    { path: "/projects/:projectId/settings/hooks", component: HookSettingsView },
  ],
});
