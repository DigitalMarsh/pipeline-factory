<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Bell, FolderOpened, Help, Search } from "@element-plus/icons-vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "./api";
import type { Project } from "./types";

const helpOpen = ref(false);
const notificationsOpen = ref(false);
const projects = ref<Project[]>([]);
const route = useRoute();
const router = useRouter();
const currentProjectId = computed(() => typeof route.params.projectId === "string" ? route.params.projectId : null);
const currentProject = computed(() => projects.value.find((project) => project.id === currentProjectId.value) ?? null);

async function loadProjects() {
  try { projects.value = (await api.projects()).items; } catch { projects.value = []; }
}

function switchProject(projectId: string) {
  if (projectId === "catalog") { void router.push("/projects"); return; }
  void router.push(`/projects/${projectId}/explorer`);
}

watch(currentProjectId, () => { if (!projects.value.length) void loadProjects(); });
onMounted(() => { void loadProjects(); });
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-mark"><span class="brand-dot" /> Pipeline Factory <small>v4</small></div>
      <el-dropdown class="project-switcher" trigger="click" @command="switchProject">
        <button class="topbar-project" type="button" aria-label="Switch Project"><FolderOpened :size="15" /> <span>{{ currentProject?.name ?? "Projects" }}</span><span v-if="currentProject" class="project-live">● {{ currentProject.status === "ACTIVE" ? "Active" : "Archived" }}</span><span v-else class="project-switch-chevron">⌄</span></button>
        <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="project in projects" :key="project.id" :command="project.id"><span class="project-menu-item"><FolderOpened :size="14" />{{ project.name }}<small>{{ project.status === "ACTIVE" ? "Active" : "Archived" }}</small></span></el-dropdown-item><el-dropdown-item divided command="catalog">Manage Projects</el-dropdown-item></el-dropdown-menu></template>
      </el-dropdown>
      <div class="topbar-actions">
        <div class="global-search"><Search :size="15" /><span>Search plans, runs, threads</span><kbd>⌘ K</kbd></div>
        <el-tooltip content="System healthy"><span class="system-health"><i /> Healthy</span></el-tooltip>
        <el-button text circle aria-label="Help" @click="helpOpen = true"><Help :size="17" /></el-button>
        <el-button text circle aria-label="Notifications" @click="notificationsOpen = true"><Bell :size="17" /></el-button>
        <div class="avatar">LS</div>
      </div>
    </header>
    <main class="page-frame"><router-view /></main>

    <el-drawer v-model="helpOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">PIPELINE FACTORY · HELP</div><h2>How this workspace works</h2></div><el-button text circle aria-label="Close help" @click="helpOpen = false">×</el-button></div>
        <div class="help-card"><strong>Explore first</strong><p>Use the ExplorerThread to inspect the repository and shape a CandidatePlan. Explorer remains read only until you confirm and enqueue the plan.</p></div>
        <div class="help-card"><strong>Follow execution</strong><p>Each dispatched plan gets its own Run and ExecutionThread. Pause, guide, verify and review the run from its detail page.</p></div>
        <div class="help-card"><strong>Need assistance?</strong><p>Use the project settings page to review lifecycle hooks and the Plan Center to find every dispatched plan.</p></div>
      </div>
    </el-drawer>

    <el-drawer v-model="notificationsOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">ACTIVITY CENTER</div><h2>Notifications</h2></div><el-button text circle aria-label="Close notifications" @click="notificationsOpen = false">×</el-button></div>
        <div class="notification-item"><span class="notification-dot success" /><div><strong>Factory is healthy</strong><p>API and web workspace are available.</p><small>Now</small></div></div>
        <div class="notification-item"><span class="notification-dot" /><div><strong>Explorer policy active</strong><p>Write, shell, test and commit tools are disabled in Plan Mode.</p><small>Now</small></div></div>
        <div class="notification-empty">No additional notifications.</div>
      </div>
    </el-drawer>
  </div>
</template>
