<!--
  模块职责：在当前 Explorer 页面内管理 Project，避免从项目选择器跳转到独立目录页。
  维护提示：Project Settings 通过父级工作区弹框打开；这里负责项目清单和高频状态操作。
-->
<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ArrowRight, Check, CircleCheck, FolderOpened, Plus, Refresh, Setting, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import type { Project } from "../types";

const props = defineProps<{ modelValue: boolean; projects: Project[]; currentProjectId?: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "select-project": [projectId: string];
  "open-settings": [projectId: string];
  "projects-changed": [projects: Project[]];
  "project-created": [project: Project];
}>();

const managedProjects = ref<Project[]>([]);
const loading = ref(false);
const saving = ref(false);
const actionProjectId = ref<string | null>(null);
const error = ref<string | null>(null);
const createMode = ref(false);
const form = reactive({ name: "", repoRoot: "", defaultBranch: "", worktreeRoot: "" });

watch(() => props.projects, (nextProjects) => {
  managedProjects.value = [...nextProjects];
}, { immediate: true });

watch(() => props.modelValue, (open) => {
  if (open) void refreshProjects();
});

function close() {
  if (createMode.value) cancelCreate();
  emit("update:modelValue", false);
}

function updateDialogVisibility(value: boolean) {
  if (!value) cancelCreate();
  emit("update:modelValue", value);
}

function openCreate() {
  createMode.value = true;
  error.value = null;
}

function cancelCreate() {
  createMode.value = false;
  form.name = "";
  form.repoRoot = "";
  form.defaultBranch = "";
  form.worktreeRoot = "";
  error.value = null;
}

async function refreshProjects() {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.projects();
    managedProjects.value = response.items;
    emit("projects-changed", response.items);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "API 未连接";
  } finally {
    loading.value = false;
  }
}

function selectProject(project: Project) {
  close();
  emit("select-project", project.id);
}

function openSettings(project: Project) {
  close();
  emit("open-settings", project.id);
}

async function toggleArchive(project: Project) {
  actionProjectId.value = project.id;
  error.value = null;
  try {
    if (project.status === "ACTIVE") {
      await ElMessageBox.confirm("归档后项目历史仍可查看，但不能创建新的 Explorer Turn 或 Run。", `归档 ${project.name}？`, { type: "warning", confirmButtonText: "归档项目", cancelButtonText: "取消" });
      await api.archiveProject(project.id);
      ElMessage.success("项目已归档");
    } else {
      await api.activateProject(project.id);
      ElMessage.success("项目已恢复");
    }
    await refreshProjects();
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    error.value = caught instanceof Error ? caught.message : "项目状态更新失败";
    ElMessage.error(error.value);
  } finally {
    actionProjectId.value = null;
  }
}

async function createProject() {
  if (!form.name.trim() || !form.repoRoot.trim()) {
    error.value = "请填写项目名称和 Git 仓库目录";
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const result = await api.createProject({ name: form.name.trim(), repoRoot: form.repoRoot.trim(), ...(form.defaultBranch.trim() ? { defaultBranch: form.defaultBranch.trim() } : {}), ...(form.worktreeRoot.trim() ? { worktreeRoot: form.worktreeRoot.trim() } : {}) });
    ElMessage.success("项目已创建");
    emit("project-created", result.project);
    cancelCreate();
    close();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "项目创建失败";
    ElMessage.error(error.value);
  } finally {
    saving.value = false;
  }
}

function statusLabel(status: Project["status"]) {
  return status === "ACTIVE" ? "Active" : "Archived";
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    class="project-management-dialog"
    width="min(760px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    @update:model-value="updateDialogVisibility($event)"
  >
    <template #header>
      <div class="project-management-heading">
        <div>
          <div class="eyebrow">PIPELINE FACTORY · PROJECTS</div>
          <h2>{{ createMode ? "New Project" : "Manage Projects" }}</h2>
          <p>{{ createMode ? "把一个本机 Git 仓库添加到当前 Factory。" : "在当前 Explorer 中维护项目，关闭弹框即可回到原来的对话位置。" }}</p>
        </div>
        <el-button v-if="!createMode" plain size="small" :loading="loading" @click="refreshProjects"><Refresh :size="14" /> Refresh</el-button>
      </div>
    </template>

    <div v-if="error" class="project-management-alert"><Warning :size="15" /> {{ error }}</div>

    <form v-if="createMode" class="project-create-form" @submit.prevent="createProject">
      <div class="project-dialog-intro">新 Project 必须指向 Git 仓库根目录。创建前 API 会校验真实路径和默认分支。</div>
      <label>Project name <input v-model="form.name" autofocus placeholder="例如：Pipeline Factory" /></label>
      <label>Git repository root <input v-model="form.repoRoot" placeholder="/Users/you/Project/repository" /><small>请输入本机可访问的绝对路径，不能是仓库子目录。</small></label>
      <div class="project-create-grid"><label>Default branch <input v-model="form.defaultBranch" placeholder="自动检测" /></label><label>Worktree root <input v-model="form.worktreeRoot" placeholder="自动生成" /></label></div>
    </form>

    <div v-else class="project-management-content">
      <div class="project-management-toolbar"><div><strong>PROJECTS</strong><span>{{ managedProjects.length }} 个项目</span></div><el-button type="primary" size="small" @click="openCreate"><Plus :size="14" /> New Project</el-button></div>
      <div v-loading="loading" class="project-management-list">
        <article v-for="project in managedProjects" :key="project.id" class="project-management-card" :class="{ archived: project.status === 'ARCHIVED', current: project.id === currentProjectId }">
          <div class="project-management-card-main">
            <div class="project-management-icon"><FolderOpened :size="19" /></div>
            <div class="project-management-copy"><div class="project-management-title"><strong>{{ project.name }}</strong><el-tag :type="project.status === 'ACTIVE' ? 'success' : 'info'" effect="light" size="small">{{ statusLabel(project.status) }}</el-tag><span v-if="project.id === currentProjectId" class="current-project-badge"><CircleCheck :size="12" /> Current</span></div><code>{{ project.repoRoot }}</code><small>{{ project.defaultBranch || "Default branch not set" }} · {{ project.currentExplorerThreadId ? "Explorer selected" : "No Explorer selected" }}</small></div>
          </div>
          <div class="project-management-card-actions"><el-button text size="small" @click="selectProject(project)">Open Explorer <ArrowRight :size="13" /></el-button><el-button text size="small" @click="openSettings(project)"><Setting :size="13" /> Settings</el-button><el-button text size="small" :loading="actionProjectId === project.id" @click="toggleArchive(project)">{{ project.status === "ACTIVE" ? "Archive" : "Activate" }}</el-button></div>
        </article>
        <div v-if="!loading && !managedProjects.length" class="project-management-empty"><FolderOpened :size="27" /><strong>还没有 Project</strong><span>添加一个本地 Git 仓库开始使用。</span><el-button plain size="small" @click="openCreate"><Plus :size="14" /> New Project</el-button></div>
      </div>
    </div>

    <template #footer>
      <template v-if="createMode"><el-button @click="cancelCreate">Cancel</el-button><el-button type="primary" :loading="saving" @click="createProject"><Check :size="14" /> Validate & Create</el-button></template>
      <el-button v-else @click="close">Done</el-button>
    </template>
  </el-dialog>
</template>

<style>
.project-management-dialog .el-dialog__header { margin: 0; padding: 22px 24px 17px; border-bottom: 1px solid #edf0f4; }
.project-management-dialog .el-dialog__body { padding: 18px 24px 8px; }
.project-management-dialog .el-dialog__footer { padding: 13px 24px 18px; border-top: 1px solid #edf0f4; }
.project-management-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.project-management-heading h2 { margin: 7px 0 5px; color: #253650; font-size: 19px; letter-spacing: -.04em; }
.project-management-heading p { margin: 0; color: #8a97a8; font-size: 10px; }
.project-management-heading .el-button { flex: 0 0 auto; margin-top: 1px; color: #71819a; font-size: 10px; }
.project-management-alert { display: flex; align-items: center; gap: 8px; margin-bottom: 13px; padding: 10px 12px; border: 1px solid #f0d1d5; border-radius: 7px; background: #fff6f7; color: #a35560; font-size: 10px; }
.project-management-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.project-management-toolbar > div { display: flex; align-items: baseline; gap: 8px; }.project-management-toolbar strong { color: #74839a; font: 10px ui-monospace, monospace; letter-spacing: .1em; }.project-management-toolbar span { color: #a3adba; font-size: 10px; }.project-management-toolbar .el-button { font-size: 10px; }
.project-management-list { display: grid; gap: 9px; max-height: min(54vh, 470px); overflow-y: auto; padding: 1px 2px 4px; }
.project-management-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; }.project-management-card.current { border-color: #a9c4fb; box-shadow: 0 0 0 2px #edf3ff; }.project-management-card.archived { opacity: .72; }
.project-management-card-main { display: flex; align-items: center; min-width: 0; gap: 11px; }.project-management-icon { display: grid; flex: 0 0 auto; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: #edf3ff; color: #4d7be4; }.project-management-copy { min-width: 0; }.project-management-title { display: flex; align-items: center; gap: 7px; min-width: 0; }.project-management-title strong { overflow: hidden; color: #43536b; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.project-management-title .el-tag { flex: 0 0 auto; font-size: 9px; }.project-management-copy code { display: block; overflow: hidden; margin-top: 4px; color: #8390a2; font: 9px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }.project-management-copy small { display: block; margin-top: 4px; color: #a0aab7; font-size: 9px; }.current-project-badge { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 3px; color: #36a678; font-size: 9px; font-weight: 700; }
.project-management-card-actions { display: flex; flex: 0 0 auto; gap: 0; }.project-management-card-actions .el-button { padding: 0 6px; color: #71829c; font-size: 10px; }.project-management-card-actions .el-button:hover { color: #3f75dd; }
.project-management-empty { display: grid; justify-items: center; gap: 7px; padding: 38px 20px; border: 1px dashed #dbe3ed; border-radius: 8px; color: #a5b0bd; font-size: 10px; }.project-management-empty strong { color: #627188; font-size: 12px; }.project-management-empty .el-button { margin-top: 4px; font-size: 10px; }
.project-create-form { display: grid; gap: 16px; padding: 2px 1px 8px; }.project-dialog-intro { padding: 11px 12px; border: 1px solid #dbe7ff; border-radius: 7px; background: #f6f9ff; color: #7083a4; font-size: 10px; line-height: 1.5; }.project-create-form label { display: block; color: #718097; font-size: 10px; font-weight: 700; }.project-create-form input { display: block; box-sizing: border-box; width: 100%; height: 35px; margin-top: 7px; padding: 0 10px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; }.project-create-form input:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }.project-create-form label small { display: block; margin-top: 5px; color: #9aa6b6; font-size: 9px; }.project-create-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
@media (max-width: 650px) { .project-management-card { display: block; }.project-management-card-actions { justify-content: flex-end; margin-top: 12px; }.project-create-grid { grid-template-columns: 1fr; } }
</style>
