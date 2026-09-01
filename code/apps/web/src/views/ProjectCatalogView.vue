<!--
  模块职责：展示 Project 清单、状态、仓库信息和进入入口。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ArrowRight, ChatDotRound, Clock, Connection, FolderOpened, Plus, Refresh, Setting, VideoPlay, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRouter } from "vue-router";
import { api } from "../api";
import type { Project, ProjectCatalogItem } from "../types";

const router = useRouter();
const projects = ref<ProjectCatalogItem[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const createOpen = ref(false);
const saving = ref(false);
const form = reactive({ name: "", repoRoot: "", defaultBranch: "", worktreeRoot: "" });

/** 加载 Project 清单及统计；路由切换和归档操作完成后复用同一刷新入口。 */
async function load() {
  loading.value = true;
  error.value = null;
  try { projects.value = (await api.projects()).items; }
  catch (caught) { error.value = caught instanceof Error ? caught.message : "API 未连接"; }
  finally { loading.value = false; }
}

/** 打开创建向导，表单状态与已存在 Project 清单隔离。 */
function openCreate() {
  void router.push("/projects/new");
}

/** 提交 Project 创建请求；服务端负责 Git 根目录和重复仓库校验。 */
async function createProject() {
  if (!form.name.trim() || !form.repoRoot.trim()) {
    ElMessage.warning("请填写项目名称和 Git 仓库目录");
    return;
  }
  saving.value = true;
  try {
    const result = await api.createProject({ name: form.name, repoRoot: form.repoRoot, ...(form.defaultBranch ? { defaultBranch: form.defaultBranch } : {}), ...(form.worktreeRoot ? { worktreeRoot: form.worktreeRoot } : {}) });
    createOpen.value = false;
    await router.push(`/projects/${result.project.id}/explorer`);
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "项目创建失败"); }
  finally { saving.value = false; }
}

/** 归档或恢复 Project；归档失败时保留列表状态并显示服务端原因。 */
async function toggleArchive(project: Project) {
  try {
    if (project.status === "ACTIVE") {
      await ElMessageBox.confirm("归档后项目历史仍可查看，但不能创建新的 Explorer Turn 或 Run。", `归档 ${project.name}？`, { type: "warning", confirmButtonText: "归档项目", cancelButtonText: "取消" });
      await api.archiveProject(project.id);
      ElMessage.success("项目已归档");
    } else {
      await api.activateProject(project.id);
      ElMessage.success("项目已恢复");
    }
    await load();
  } catch (caught) {
    if (caught === "cancel" || caught === "close") return;
    ElMessage.error(caught instanceof Error ? caught.message : "项目状态更新失败");
  }
}

function openProject(project: Project) {
  void router.push(`/projects/${project.id}/explorer`);
}

function openSettings(project: Project) {
  void router.push(`/projects/${project.id}/settings`);
}

function statusLabel(status: Project["status"]) { return status === "ACTIVE" ? "Active" : "Archived"; }
function activityLabel(value: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
onMounted(() => { void load(); });
</script>

<template>
  <div class="project-catalog-page">
    <div class="catalog-heading">
      <div>
        <div class="eyebrow">PIPELINE FACTORY · PROJECTS</div>
        <h1>Projects</h1>
        <p>每个 Project 对应一个 Git 仓库，并独立保存 Explorer、Plan、Run 和执行配置。</p>
      </div>
      <div class="catalog-actions"><el-button plain @click="load"><Refresh :size="15" /> Refresh</el-button><el-button type="primary" @click="openCreate"><Plus :size="15" /> New Project</el-button></div>
    </div>

    <div v-if="error" class="catalog-alert"><Warning :size="15" /> {{ error }}</div>
    <div v-loading="loading" class="project-card-grid">
      <article v-for="project in projects" :key="project.id" class="project-card" :class="{ archived: project.status === 'ARCHIVED' }">
        <div class="project-card-top"><div class="project-card-icon"><FolderOpened :size="20" /></div><el-tag :type="project.status === 'ACTIVE' ? 'success' : 'info'" effect="light">{{ statusLabel(project.status) }}</el-tag></div>
        <button class="project-card-title" type="button" @click="openProject(project)"><strong>{{ project.name }}</strong><ArrowRight :size="16" /></button>
        <code class="project-id">{{ project.id }}</code>
        <div class="project-path"><FolderOpened :size="14" /><span>{{ project.repoRoot }}</span></div>
        <div class="project-current"><ChatDotRound :size="13" /><span>Current Explorer</span><code :title="project.summary.currentExplorerThread ?? undefined">{{ project.summary.currentExplorerTitle ?? project.summary.currentExplorerThread ?? "Not selected" }}</code></div>
        <div class="project-facts"><span><Connection :size="13" />{{ project.defaultBranch }}</span><span><VideoPlay :size="13" />{{ project.settings.concurrency.maxParallelRuns }} parallel</span><span><VideoPlay :size="13" />{{ project.summary.activeRunCount }} running</span></div>
        <div class="project-facts project-facts-secondary"><span><Warning :size="13" />{{ project.summary.needsAttentionCount }} attention</span><span><Clock :size="13" />{{ activityLabel(project.summary.lastActivityAt) }}</span></div>
        <div class="project-card-footer"><el-button text size="small" @click="openProject(project)">Open Explorer</el-button><el-button text size="small" @click="openSettings(project)"><Setting :size="13" /> Settings</el-button><el-button text size="small" @click="toggleArchive(project)">{{ project.status === 'ACTIVE' ? 'Archive' : 'Activate' }}</el-button></div>
      </article>
      <button class="project-add-card" type="button" @click="openCreate"><span><Plus :size="20" /></span><strong>添加 Git Project</strong><small>配置仓库目录、Worktree 和运行策略</small></button>
      <div v-if="!loading && !projects.length" class="catalog-empty"><FolderOpened :size="30" /><strong>还没有 Project</strong><span>导入一个本地 Git 仓库开始使用。</span></div>
    </div>

    <el-dialog v-model="createOpen" title="New Project" width="min(560px, 92vw)">
      <div class="project-dialog-intro">新 Project 必须指向 Git 仓库根目录。创建前 API 会校验真实路径和默认分支。</div>
      <el-form label-position="top" @submit.prevent="createProject">
        <el-form-item label="Project name" required><el-input v-model="form.name" placeholder="例如：Pipeline Factory" /></el-form-item>
        <el-form-item label="Git repository root" required><el-input v-model="form.repoRoot" placeholder="/Users/you/Project/repository" /><small class="form-help">请输入本机可访问的绝对路径，不能是仓库子目录。</small></el-form-item>
        <div class="dialog-form-grid"><el-form-item label="Default branch"><el-input v-model="form.defaultBranch" placeholder="自动检测" /></el-form-item><el-form-item label="Worktree root"><el-input v-model="form.worktreeRoot" placeholder="自动生成" /></el-form-item></div>
      </el-form>
      <template #footer><el-button @click="createOpen = false">Cancel</el-button><el-button type="primary" :loading="saving" @click="createProject">Validate & Create</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.project-catalog-page { min-height: calc(100vh - 60px); padding: 39px 54px 54px; background: #f8fafc; }
.catalog-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 30px; max-width: 1180px; margin: 0 auto 28px; }
.catalog-heading h1 { margin: 7px 0 6px; color: #1c2a3d; font-size: 28px; letter-spacing: -.05em; }
.catalog-heading p { margin: 0; color: #7e8b9d; font-size: 12px; }
.catalog-actions { display: flex; gap: 8px; }
.catalog-actions .el-button { font-size: 11px; }
.catalog-alert { display: flex; align-items: center; gap: 8px; max-width: 1180px; margin: 0 auto 16px; padding: 11px 13px; border: 1px solid #f1d6da; border-radius: 7px; background: #fff6f7; color: #a3535e; font-size: 11px; }
.project-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)); gap: 15px; max-width: 1180px; margin: auto; min-height: 180px; }
.project-card, .project-add-card { min-height: 235px; padding: 18px; border: 1px solid #e0e7f0; border-radius: 10px; background: #fff; box-shadow: 0 5px 18px rgba(36, 59, 94, .04); }
.project-card.archived { opacity: .72; }
.project-card-top { display: flex; align-items: center; justify-content: space-between; }
.project-card-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 9px; background: #edf3ff; color: #4d7be4; }
.project-card-title { display: flex; align-items: center; justify-content: space-between; width: 100%; margin: 18px 0 4px; padding: 0; border: 0; background: transparent; color: #33445d; cursor: pointer; text-align: left; }
.project-card-title strong { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.project-card-title:hover { color: #3f75dd; }
.project-id { color: #9ba7b6; font-size: 9px; }
.project-path { display: flex; gap: 7px; align-items: center; margin-top: 17px; color: #77869b; font: 10px ui-monospace, monospace; }
.project-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-current { display: flex; align-items: center; gap: 6px; margin-top: 15px; color: #8b98a9; font-size: 10px; }
.project-current code { overflow: hidden; margin-left: auto; color: #657ba9; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.project-facts { display: flex; gap: 15px; margin-top: 17px; color: #9aa6b6; font-size: 10px; }
.project-facts span { display: flex; align-items: center; gap: 5px; }
.project-facts-secondary { margin-top: 9px; }
.project-card-footer { display: flex; gap: 0; margin-top: 19px; padding-top: 11px; border-top: 1px solid #edf0f4; }
.project-card-footer .el-button { padding: 0 7px; font-size: 10px; }
.project-add-card { display: grid; place-items: center; align-content: center; gap: 8px; border-style: dashed; color: #8190a4; cursor: pointer; text-align: center; }
.project-add-card:hover { border-color: #9bb7f0; background: #fbfdff; color: #4d77d1; }
.project-add-card > span { display: grid; place-items: center; width: 39px; height: 39px; border-radius: 50%; background: #edf3ff; color: #4e7ae0; }
.project-add-card strong { font-size: 12px; }.project-add-card small { color: #a0acbb; font-size: 10px; }
.catalog-empty { grid-column: 1 / -1; display: grid; justify-items: center; gap: 8px; padding: 46px; border: 1px dashed #dbe3ed; border-radius: 10px; color: #a5b0bd; }.catalog-empty strong { color: #627188; font-size: 13px; }.catalog-empty span { font-size: 10px; }
.project-dialog-intro { margin-bottom: 18px; padding: 11px 12px; border: 1px solid #dbe7ff; border-radius: 7px; background: #f6f9ff; color: #7083a4; font-size: 10px; line-height: 1.5; }.dialog-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }.form-help { display: block; margin-top: 5px; color: #9aa6b6; font-size: 9px; }
@media (max-width: 760px) { .project-catalog-page { padding: 28px 20px; }.catalog-heading { display: block; }.catalog-actions { margin-top: 17px; }.dialog-form-grid { grid-template-columns: 1fr; } }
</style>
