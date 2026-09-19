<!--
  模块职责：展示 Project 和 ExplorerThread 导航。
  维护提示：探索/项目入口切换左侧内容，Plan Center 入口由 ExplorerView 代理到右侧上下文面板。
-->
<script setup lang="ts">
import { ArrowDown, ArrowRight, Connection, Delete, EditPen, FolderOpened, MoreFilled, Plus, Refresh, Setting, VideoPause, VideoPlay, View } from "@element-plus/icons-vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ExplorerThread, Project } from "../types";
import type { TaskTreeItem } from "../utils/taskTree";
import { taskDisplayTitle, taskRuntimeLabel } from "../utils/taskTree";

type LeftPanel = "projects" | "explorers";
type ThreadActionCommand = "toggle-pause" | "rename" | "policy" | "refresh" | "new-task" | "delete";
type ExplorerTreeNode =
  | { key: string; label: string; kind: "explorer"; explorer: ExplorerThread; children: ExplorerTreeNode[] }
  | { key: string; label: string; kind: "task"; taskItem: TaskTreeItem; children: ExplorerTreeNode[] }
  | { key: string; label: string; kind: "plan"; taskItem: TaskTreeItem; children: ExplorerTreeNode[] };

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
  planCenterActive?: boolean;
  planCenterCount?: number;
  taskTreeItems?: TaskTreeItem[];
  activeExplorerPlanId?: string | null;
  explorerPaused?: boolean;
}>(), {
  showArchived: false,
  explorerActionId: null,
  explorerLoading: false,
  explorerError: null,
  planCenterActive: false,
  planCenterCount: 0,
  taskTreeItems: () => [],
  activeExplorerPlanId: null,
  explorerPaused: false,
});
const emit = defineEmits<{
  "select-panel": [panel: LeftPanel];
  "select-plan-center": [];
  "select-project": [projectId: string];
  "open-project": [projectId: string];
  "open-project-settings": [projectId: string];
  "archive-project": [projectId: string];
  "select-explorer": [explorerId: string];
  "toggle-show-archived": [value: boolean];
  "archive-explorer": [explorerId: string];
  "create-explorer": [];
  "create-project": [];
  "select-explorer-plan": [explorerPlanId: string];
  "select-plan-tree-item": [item: TaskTreeItem];
  "thread-action": [command: ThreadActionCommand];
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

function planStatusLabel(status: string): string {
  return ({ DRAFT: "Candidate", DISCARDED: "Discarded", READY: "Confirmed", ENQUEUED: "Enqueued", DISPATCHED: "Dispatched", QUEUED: "Queued", STARTING: "Starting", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Ready for review", MERGED: "Merged", NEEDS_PLAN_CHANGE: "Plan change required", BLOCKED: "Blocked" } as Record<string, string>)[status] ?? status;
}

const explorerTreeProps = { children: "children", label: "label" };
const explorerTreeData = computed<ExplorerTreeNode[]>(() => {
  const explorer = props.thread;
  if (!explorer) return [];
  return [{
    key: `explorer:${explorer.id}`,
    label: explorer.title,
    kind: "explorer",
    explorer,
    children: props.taskTreeItems.map((taskItem) => ({
      key: `task:${taskItem.task.id}`,
      label: taskDisplayTitle(taskItem.task),
      kind: "task" as const,
      taskItem,
      children: [{
        key: taskItem.planKey ?? `plan-placeholder:${taskItem.task.id}`,
        label: taskItem.plan?.title ?? "等待生成 Plan",
        kind: "plan" as const,
        taskItem,
        children: [],
      }],
    })),
  }];
});
const activeExplorerTreeNodeKey = computed(() => props.activeExplorerPlanId ? `task:${props.activeExplorerPlanId}` : null);

function handleExplorerTreeNodeClick(data: ExplorerTreeNode): void {
  if (data.kind === "explorer") emit("select-explorer", data.explorer.id);
  else if (data.kind === "task") emit("select-explorer-plan", data.taskItem.task.id);
  else if (data.taskItem.plan) emit("select-plan-tree-item", data.taskItem);
}

function emitThreadAction(command: string | number): void {
  if (typeof command === "string") emit("thread-action", command as ThreadActionCommand);
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
      <button
        class="left-entry-button left-entry-button-plan-center"
        type="button"
        data-left-context="plan-center"
        role="tab"
        aria-label="计划中心"
        :aria-selected="props.planCenterActive"
        :class="{ active: props.planCenterActive }"
        @click="emit('select-plan-center')"
      >
        <View :size="17" />
        <span>计划中心</span>
        <span class="left-entry-count">{{ props.planCenterCount }}</span>
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
              <span class="project-context-title-row">
                <strong class="project-context-name">{{ props.project?.name ?? props.thread?.projectId ?? "Local workspace" }}</strong>
              </span>
              <span class="project-context-summary project-context-meta-row">
                <span class="project-context-count">{{ props.explorers.length }} explorations</span>
              </span>
            </span>
            <span v-if="props.project" :class="['project-context-status', { archived: props.project.status === 'ARCHIVED' }]">
              <i /> {{ projectStatusLabel(props.project.status) }}
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
          <div class="left-list-label">线程清单</div>
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
          <template v-if="availableExplorer.id === props.thread?.id">
            <el-tree
              :key="availableExplorer.id"
              class="explorer-thread-tree"
              :data="explorerTreeData"
              node-key="key"
              :props="explorerTreeProps"
              :default-expand-all="true"
              :expand-on-click-node="false"
              :highlight-current="true"
              :current-node-key="activeExplorerTreeNodeKey"
              :indent="16"
              empty-text=""
              aria-label="Explorer Thread、Task 和 Plan 导航"
              @node-click="handleExplorerTreeNodeClick"
            >
              <template #default="{ data }">
                <div v-if="data.kind === 'explorer'" class="explorer-thread-row-head">
                  <button
                    class="explorer-list-item"
                    :class="{ active: data.explorer.id === props.thread?.id }"
                    type="button"
                    :data-explorer-id="data.explorer.id"
                    :aria-label="`Explorer Thread：${data.explorer.title}`"
                    :aria-current="data.explorer.id === props.thread?.id ? 'page' : undefined"
                    aria-expanded="true"
                    @click.stop="emit('select-explorer', data.explorer.id)"
                  >
                    <span class="left-list-copy"><strong>{{ data.explorer.title }}</strong></span>
                    <span :class="['left-list-status', { archived: data.explorer.state === 'ARCHIVED' }]">{{ explorerStatusLabel(data.explorer.state) }}</span>
                  </button>
                  <div class="explorer-thread-row-actions" @click.stop>
                    <el-dropdown placement="bottom-end" popper-class="thread-action-popper" :disabled="!props.thread || Boolean(props.explorerActionId)" @command="emitThreadAction">
                      <el-button text circle class="explorer-thread-menu-trigger" aria-label="线程操作" title="线程操作"><MoreFilled :size="16" /></el-button>
                      <template #dropdown>
                        <el-dropdown-menu class="thread-action-menu">
                          <li class="thread-action-menu-heading" role="presentation">线程操作</li>
                          <el-dropdown-item command="toggle-pause">
                            <span class="thread-action-menu-item">
                              <VideoPlay v-if="props.explorerPaused" :size="16" />
                              <VideoPause v-else :size="16" />
                              <span>{{ props.explorerPaused ? "恢复循环" : "暂停循环" }}</span>
                            </span>
                          </el-dropdown-item>
                          <el-dropdown-item command="rename"><span class="thread-action-menu-item"><EditPen :size="16" /><span>重命名线程</span></span></el-dropdown-item>
                          <el-dropdown-item command="new-task"><span class="thread-action-menu-item"><Plus :size="16" /><span>新建 Task</span></span></el-dropdown-item>
                          <el-dropdown-item command="policy"><span class="thread-action-menu-item"><View :size="16" /><span>查看策略</span></span></el-dropdown-item>
                          <el-dropdown-item command="refresh"><span class="thread-action-menu-item"><Refresh :size="16" /><span>刷新线程</span></span></el-dropdown-item>
                          <el-dropdown-item command="delete" class="thread-action-danger"><span class="thread-action-menu-item"><Delete :size="16" /><span>删除线程</span></span></el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                </div>
                <div v-else-if="data.kind === 'task'" :class="['explorer-tree-task-row', { active: data.taskItem.task.id === props.activeExplorerPlanId }]">
                  <button class="explorer-tree-task-button" type="button" :aria-current="data.taskItem.task.id === props.activeExplorerPlanId ? 'page' : undefined" @click.stop="emit('select-explorer-plan', data.taskItem.task.id)">
                    <span class="explorer-tree-task-title"><strong>{{ taskDisplayTitle(data.taskItem.task) }}</strong><em>{{ taskRuntimeLabel(data.taskItem.task) }}</em></span>
                    <small>{{ data.taskItem.task.latestUserMessageSummary ?? '尚未开始探索' }}</small>
                  </button>
                </div>
                <button v-else-if="data.taskItem.plan" class="explorer-tree-plan-button" type="button" :aria-label="`定位 ${data.taskItem.plan.title}`" @click.stop="emit('select-plan-tree-item', data.taskItem)">
                  <span class="explorer-tree-plan-copy"><strong>{{ data.taskItem.plan.title }}</strong><small>Revision {{ data.taskItem.plan.revision }} · {{ planStatusLabel(data.taskItem.plan.status) }}</small></span>
                </button>
                <span v-else class="explorer-tree-empty-plan">{{ data.taskItem.task.candidatePlanId ? 'Plan 加载失败' : '等待生成 Plan' }}</span>
              </template>
            </el-tree>
          </template>
          <template v-else>
            <div class="explorer-thread-row-head">
              <button
                class="explorer-list-item"
                type="button"
                :data-explorer-id="availableExplorer.id"
                :aria-label="`Explorer Thread：${availableExplorer.title}`"
                aria-expanded="false"
                @click="emit('select-explorer', availableExplorer.id)"
              >
                <span class="left-list-copy"><strong>{{ availableExplorer.title }}</strong></span>
                <span :class="['left-list-status', { archived: availableExplorer.state === 'ARCHIVED' }]">{{ explorerStatusLabel(availableExplorer.state) }}</span>
              </button>
            </div>
          </template>
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
