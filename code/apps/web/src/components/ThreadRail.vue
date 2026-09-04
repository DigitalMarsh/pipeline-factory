<!--
  模块职责：展示 Project 和 ExplorerThread 导航。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { Connection, FolderOpened } from "@element-plus/icons-vue";
import type { ExplorerThread, Project } from "../types";

const props = defineProps<{ thread: ExplorerThread | null; project?: Project | null; projects: Project[] }>();
const emit = defineEmits<{ "open-history": []; "select-project": [projectId: string]; "manage-projects": [] }>();

function selectProject(projectId: string) {
  if (projectId === "catalog") {
    emit("manage-projects");
    return;
  }
  emit("select-project", projectId);
}

</script>

<template>
  <aside class="thread-rail">
    <el-dropdown class="rail-project-switcher" trigger="click" @command="selectProject">
      <button class="rail-project" type="button" aria-label="Switch Project" title="Switch Project">
        <div class="project-icon">PF</div>
        <div class="rail-project-copy"><strong>{{ props.project?.name ?? thread?.projectId ?? "Project" }}</strong><small>{{ props.project?.repoRoot ?? "Local workspace" }}</small></div>
        <span v-if="props.project" :class="['rail-project-status', { archived: props.project.status === 'ARCHIVED' }]">● {{ props.project.status === 'ACTIVE' ? 'Active' : 'Archived' }}</span>
        <span class="chevron">⌄</span>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="availableProject in props.projects" :key="availableProject.id" :command="availableProject.id">
            <span class="project-menu-item"><FolderOpened :size="14" />{{ availableProject.name }}<small>{{ availableProject.status === "ACTIVE" ? "Active" : "Archived" }}</small></span>
          </el-dropdown-item>
          <el-dropdown-item divided command="catalog">Manage Projects</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <div class="rail-label">EXPLORER THREAD</div>
    <button class="thread-identity" type="button" aria-label="Open Explorer history" title="Open Explorer history" @click="emit('open-history')">
      <div class="thread-icon"><Connection :size="16" /></div>
      <div class="thread-copy"><strong>{{ thread?.title ?? "探索线程" }}</strong><small>{{ thread?.id ?? "no-thread" }}</small></div>
      <span class="live-dot" />
    </button>
    <div class="thread-meta"><span>{{ thread?.messageCount ?? 8 }} messages</span><span>Just now</span></div>
  </aside>
</template>
