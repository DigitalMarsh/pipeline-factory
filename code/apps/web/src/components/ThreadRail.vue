<!--
  模块职责：展示 Project 和 ExplorerThread 导航。
  维护提示：左侧入口只切换左侧内容，右侧执行上下文由 ExplorerView 独立管理。
-->
<script setup lang="ts">
import { ArrowDown, ArrowRight, Connection, FolderOpened, Plus, Setting } from "@element-plus/icons-vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ExplorerThread, Project } from "../types";

type LeftPanel = "projects" | "explorers";

const props = withDefaults(defineProps<{
  panel: LeftPanel;
  thread: ExplorerThread | null;
  project?: Project | null;
  projects: Project[];
  explorers: ExplorerThread[];
  creatingExplorer?: boolean;
  projectActionId?: string | null;
  showArchived?: boolean;
  explorerActionId?: string | null;
  explorerLoading?: boolean;
  explorerError?: string | null;
}>(), {
  showArchived: false,
  explorerActionId: null,
  explorerLoading: false,
  explorerError: null,
});
const emit = defineEmits<{
  "select-panel": [panel: LeftPanel];
  "select-project": [projectId: string];
  "open-project": [projectId: string];
  "open-project-settings": [projectId: string];
  "archive-project": [projectId: string];
  "select-explorer": [explorerId: string];
  "toggle-show-archived": [value: boolean];
  "archive-explorer": [explorerId: string];
  "create-explorer": [];
  "create-project": [];
}>();

const panelEntries: { key: LeftPanel; label: string }[] = [
  { key: "explorers", label: "探索" },
  { key: "projects", label: "项目" },
];
const projectSwitcherOpen = ref(false);
const projectSwitcherRef = ref<HTMLElement | null>(null);

function closeProjectSwitcher() {
  projectSwitcherOpen.value = false;
}

function toggleProjectSwitcher() {
  projectSwitcherOpen.value = !projectSwitcherOpen.value;
}

function selectInlineProject(projectId: string) {
  if (projectId === props.project?.id) return;
  closeProjectSwitcher();
  emit("select-project", projectId);
}

function closeProjectSwitcherOnPointerDown(event: PointerEvent) {
  if (!projectSwitcherOpen.value || !(event.target instanceof Node) || projectSwitcherRef.value?.contains(event.target)) return;
  closeProjectSwitcher();
}

function closeProjectSwitcherOnKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closeProjectSwitcher();
}

onMounted(() => {
  document.addEventListener("pointerdown", closeProjectSwitcherOnPointerDown);
  document.addEventListener("keydown", closeProjectSwitcherOnKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeProjectSwitcherOnPointerDown);
  document.removeEventListener("keydown", closeProjectSwitcherOnKeydown);
});

function projectStatusLabel(status: Project["status"]): string {
  return status === "ACTIVE" ? "Active" : "Archived";
}

function explorerStatusLabel(state: ExplorerThread["state"]): string {
  return state === "ACTIVE" ? "Active" : state === "ARCHIVED" ? "Archived" : "Completed";
}

const visibleExplorers = computed(() => props.showArchived ? props.explorers : props.explorers.filter((explorer) => explorer.state !== "ARCHIVED"));

function explorerArchiveLabel(explorer: ExplorerThread): string {
  return explorer.state === "ARCHIVED" ? "Activate" : "Archive";
}

function explorerArchiveAriaLabel(explorer: ExplorerThread): string {
  if (explorer.state !== "ARCHIVED" && explorer.id === props.thread?.id) return `${explorer.title}: 当前线程不能归档`;
  return `${explorerArchiveLabel(explorer)} ${explorer.title}`;
}
</script>

<template>
  <aside class="thread-rail">
    <nav class="left-entry-rail" role="tablist" aria-label="Explorer workspace sections">
      <button
        v-for="entry in panelEntries"
        :key="entry.key"
        class="left-entry-button"
        :class="{ active: props.panel === entry.key }"
        type="button"
        :data-left-panel="entry.key"
        role="tab"
        :aria-selected="props.panel === entry.key"
        @click="emit('select-panel', entry.key)"
      >
        <FolderOpened v-if="entry.key === 'projects'" :size="17" />
        <Connection v-else :size="17" />
        <span>{{ entry.label }}</span>
      </button>
    </nav>

    <section class="left-panel">
      <header class="left-panel-header">
        <div v-if="props.panel === 'explorers'" ref="projectSwitcherRef" class="project-context-switcher">
          <button
            class="project-context-card"
            type="button"
            :aria-label="`切换项目：${props.project?.name ?? props.thread?.projectId ?? 'Local workspace'}`"
            aria-haspopup="listbox"
            :aria-expanded="projectSwitcherOpen"
            aria-controls="inline-project-switcher"
            @click="toggleProjectSwitcher"
          >
            <span class="project-context-copy">
              <span class="eyebrow">CURRENT PROJECT</span>
              <strong>{{ props.project?.name ?? props.thread?.projectId ?? "Local workspace" }}</strong>
              <span class="project-context-summary">
                <span>{{ props.explorers.length }} explorations</span>
                <span v-if="props.project" :class="['project-context-status', { archived: props.project.status === 'ARCHIVED' }]">
                  <i /> {{ projectStatusLabel(props.project.status) }}
                </span>
              </span>
              <small v-if="props.project?.repoRoot">{{ props.project.repoRoot }}</small>
            </span>
            <ArrowDown :class="['project-context-arrow', { open: projectSwitcherOpen }]" :size="16" aria-hidden="true" />
          </button>
          <div v-if="projectSwitcherOpen" id="inline-project-switcher" class="inline-project-switcher" data-inline-project-switcher role="listbox" aria-label="选择项目">
            <button
              v-for="availableProject in props.projects"
              :key="availableProject.id"
              class="inline-project-option"
              :class="{ selected: availableProject.id === props.project?.id }"
              type="button"
              :data-inline-project-id="availableProject.id"
              :aria-selected="availableProject.id === props.project?.id"
              :disabled="availableProject.id === props.project?.id"
              @click="selectInlineProject(availableProject.id)"
            >
              <span class="left-list-icon"><FolderOpened :size="15" /></span>
              <span class="inline-project-option-copy"><strong>{{ availableProject.name }}</strong><small>{{ availableProject.repoRoot }}</small></span>
              <span :class="['left-list-status', { archived: availableProject.status === 'ARCHIVED' }]">{{ projectStatusLabel(availableProject.status) }}</span>
            </button>
          </div>
        </div>
        <template v-else>
          <div class="eyebrow">PROJECTS</div>
          <strong>{{ props.projects.length }} projects</strong>
          <small>{{ props.project?.name ?? props.thread?.projectId ?? "Local workspace" }}</small>
        </template>
      </header>

      <div v-if="props.panel === 'projects'" class="left-panel-scroll project-list">
        <article
          v-for="availableProject in props.projects"
          :key="availableProject.id"
          class="project-list-row"
          :class="{ active: availableProject.id === props.project?.id }"
          :data-project-row="availableProject.id"
        >
          <button
            class="project-list-item"
            :class="{ active: availableProject.id === props.project?.id }"
            type="button"
            :data-project-id="availableProject.id"
            @click="emit('select-project', availableProject.id)"
          >
            <span class="left-list-icon"><FolderOpened :size="16" /></span>
            <span class="left-list-copy"><strong>{{ availableProject.name }}<span v-if="availableProject.shortName && availableProject.shortName !== availableProject.name" class="left-list-short-name">{{ availableProject.shortName }}</span></strong><small>{{ availableProject.repoRoot }}</small></span>
            <span :class="['left-list-status', { archived: availableProject.status === 'ARCHIVED' }]">{{ projectStatusLabel(availableProject.status) }}</span>
          </button>
          <div class="project-list-actions" aria-label="Project actions">
            <button type="button" class="project-list-action" data-project-action="open-explorer" @click.stop="emit('open-project', availableProject.id)">
              Open Explorer <ArrowRight :size="12" />
            </button>
            <button type="button" class="project-list-action" data-project-action="settings" @click.stop="emit('open-project-settings', availableProject.id)">
              <Setting :size="12" /> Settings
            </button>
            <button
              type="button"
              class="project-list-action"
              data-project-action="archive"
              :disabled="props.projectActionId === availableProject.id"
              :aria-busy="props.projectActionId === availableProject.id ? 'true' : undefined"
              @click.stop="emit('archive-project', availableProject.id)"
            >
              {{ availableProject.status === "ACTIVE" ? "Archive" : "Activate" }}
            </button>
          </div>
        </article>
        <button class="left-panel-create-project" type="button" data-project-action="create" @click="emit('create-project')">
          <span class="left-panel-create-icon"><Plus :size="16" /></span>
          <span><strong>New Project</strong><small>添加 Git 仓库</small></span>
        </button>
      </div>

      <div v-else class="left-panel-scroll explorer-list">
        <button
          class="left-panel-create"
          type="button"
          aria-label="新建 Explorer"
          :disabled="props.creatingExplorer"
          :aria-busy="props.creatingExplorer ? 'true' : undefined"
          @click="emit('create-explorer')"
        >
          <span class="left-panel-create-icon"><Plus :size="16" /></span>
          <span><strong>新建 Explorer</strong><small>从全新上下文开始</small></span>
        </button>

        <div class="left-list-label-row">
          <div class="left-list-label">EXPLORER THREADS</div>
          <button
            class="explorer-archive-toggle"
            type="button"
            data-explorer-filter="archived"
            :aria-pressed="props.showArchived"
            :aria-label="props.showArchived ? '隐藏归档线程' : '显示归档线程'"
            @click="emit('toggle-show-archived', !props.showArchived)"
          >
            {{ props.showArchived ? "隐藏归档" : "显示归档" }}
          </button>
        </div>
        <div v-if="props.explorerLoading" class="explorer-list-state" data-explorer-list-state="loading" role="status" aria-live="polite">
          正在加载 Explorer 线程…
        </div>
        <div v-else-if="props.explorerError" class="explorer-list-state explorer-list-state-error" data-explorer-list-state="error" role="alert">
          {{ props.explorerError }}
        </div>
        <div v-else-if="!visibleExplorers.length" class="explorer-list-state" data-explorer-list-state="empty">
          <strong>暂无 Explorer 线程</strong>
          <span>点击上方按钮开始一次全新的探索。</span>
        </div>
        <article
          v-for="availableExplorer in visibleExplorers"
          :key="availableExplorer.id"
          class="explorer-list-row"
          :class="{ active: availableExplorer.id === props.thread?.id }"
          :data-explorer-id="availableExplorer.id"
        >
          <button
            class="explorer-list-item"
            :class="{ active: availableExplorer.id === props.thread?.id }"
            type="button"
            :data-explorer-id="availableExplorer.id"
            @click="emit('select-explorer', availableExplorer.id)"
          >
            <span class="left-list-icon"><Connection :size="15" /></span>
            <span class="left-list-copy"><strong>{{ availableExplorer.title }}</strong><small>{{ availableExplorer.messageCount }} messages · {{ availableExplorer.id }}</small></span>
            <span :class="['left-list-status', { archived: availableExplorer.state === 'ARCHIVED' }]">{{ explorerStatusLabel(availableExplorer.state) }}</span>
          </button>
          <div class="explorer-list-actions">
            <button
              type="button"
              :class="['explorer-list-action', { archived: availableExplorer.state === 'ARCHIVED' }]"
              :data-explorer-action="availableExplorer.state === 'ARCHIVED' ? 'activate' : 'archive'"
              :disabled="props.explorerActionId === availableExplorer.id || (availableExplorer.state !== 'ARCHIVED' && availableExplorer.id === props.thread?.id)"
              :aria-busy="props.explorerActionId === availableExplorer.id ? 'true' : undefined"
              :aria-label="explorerArchiveAriaLabel(availableExplorer)"
              @click.stop="emit('archive-explorer', availableExplorer.id)"
            >
              {{ explorerArchiveLabel(availableExplorer) }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </aside>
</template>
