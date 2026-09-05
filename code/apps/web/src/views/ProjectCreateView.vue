<!--
  模块职责：以独立页面完成 Project 创建向导，先明确 Git、Worktree 和执行边界。
  维护提示：创建前端只提交配置意图，仓库根目录和分支由 API 最终校验。
-->
<script setup lang="ts">
import { reactive, ref } from "vue";
import { Aim, ArrowLeft, Check, Connection, FolderOpened, Lock, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRouter } from "vue-router";
import { api } from "../api";

const router = useRouter();
const saving = ref(false);
const error = ref<string | null>(null);
const form = reactive({ name: "", shortName: "", repoRoot: "", defaultBranch: "", worktreeRoot: "" });

async function createProject() {
  error.value = null;
  if (!form.name.trim() || !form.repoRoot.trim()) {
    error.value = "请填写 Project name 和 Git repository root";
    return;
  }
  saving.value = true;
  try {
    const result = await api.createProject({ name: form.name.trim(), ...(form.shortName.trim() ? { shortName: form.shortName.trim() } : {}), repoRoot: form.repoRoot.trim(), ...(form.defaultBranch.trim() ? { defaultBranch: form.defaultBranch.trim() } : {}), ...(form.worktreeRoot.trim() ? { worktreeRoot: form.worktreeRoot.trim() } : {}) });
    ElMessage.success("Project 创建成功");
    await router.push("/projects/" + result.project.id + "/explorer");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Project 创建失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="project-create-page">
    <div class="create-breadcrumb"><button type="button" @click="router.push('/projects')"><ArrowLeft :size="14" /> Projects</button><span>/</span><strong>New Project</strong></div>
    <div class="create-layout">
      <main class="create-card">
        <div class="create-heading"><div class="create-icon"><FolderOpened :size="21" /></div><div><div class="eyebrow">PROJECT SETUP · 01</div><h1>New Project</h1><p>将一个本地 Git 仓库注册为独立的 Pipeline Factory 工作空间。</p></div></div>
        <div v-if="error" class="create-alert"><Warning :size="15" />{{ error }}</div>
        <el-form label-position="top" @submit.prevent="createProject">
          <div class="create-form-grid"><el-form-item label="Project name" required><el-input v-model="form.name" placeholder="例如：Pipeline Factory" /></el-form-item><el-form-item label="Project short name"><el-input v-model="form.shortName" placeholder="例如：PF" /></el-form-item></div>
          <el-form-item label="Git repository root" required><el-input v-model="form.repoRoot" placeholder="/Users/you/Project/repository" /><small class="create-help">必须是本机可访问的绝对路径，并且是 Git repository root，不接受子目录。</small></el-form-item>
          <div class="create-form-grid"><el-form-item label="Default branch"><el-input v-model="form.defaultBranch" placeholder="自动检测" /></el-form-item><el-form-item label="Worktree root"><el-input v-model="form.worktreeRoot" placeholder="自动生成安全目录" /></el-form-item></div>
          <div class="create-actions"><el-button @click="router.push('/projects')">Cancel</el-button><el-button type="primary" :loading="saving" @click="createProject"><Check :size="14" /> Validate & Create</el-button></div>
        </el-form>
      </main>
      <aside class="create-guide">
        <div class="eyebrow">WHAT HAPPENS NEXT</div>
        <h2>One Project, one boundary.</h2>
        <div class="guide-item"><span><Connection :size="15" /></span><div><strong>Repository validated</strong><p>API 会 canonicalize Git 根目录并检查默认分支。</p></div></div>
        <div class="guide-item"><span><Aim :size="15" /></span><div><strong>Explorer starts read-only</strong><p>ExplorerThread 只读；写入必须来自已确认 Plan。</p></div></div>
        <div class="guide-item"><span><Lock :size="15" /></span><div><strong>Execution stays isolated</strong><p>每个 Run 使用独立 Worktree，沿用冻结的 Project 配置快照。</p></div></div>
        <div class="guide-note"><strong>Recommended defaults</strong><p>先使用自动检测的 branch 和 Worktree root，创建后可在 Settings 调整并查看配置历史。</p></div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.project-create-page { min-height: calc(100vh - 60px); padding: 34px 40px; background: #f7f9fc; }.create-breadcrumb { display: flex; align-items: center; gap: 8px; max-width: 980px; margin: 0 auto 22px; color: #9aa5b4; font-size: 10px; }.create-breadcrumb button { display: flex; align-items: center; gap: 5px; padding: 0; border: 0; background: transparent; color: #5d7ed2; cursor: pointer; font-size: 10px; }.create-breadcrumb strong { color: #66758a; font-weight: 700; }.create-layout { display: grid; grid-template-columns: minmax(480px, 650px) 280px; gap: 20px; max-width: 980px; margin: auto; }.create-card, .create-guide { border: 1px solid #e1e7ef; border-radius: 10px; background: #fff; box-shadow: 0 8px 24px rgba(30, 48, 78, .04); }.create-card { padding: 27px 30px 25px; }.create-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 26px; }.create-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 9px; background: #edf3ff; color: #4d7ce4; }.create-heading h1 { margin: 6px 0 5px; color: #26354b; font-size: 22px; letter-spacing: -.04em; }.create-heading p { margin: 0; color: #8995a5; font-size: 11px; line-height: 1.5; }.create-alert { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 17px; padding: 10px 11px; border: 1px solid #f0cdd1; border-radius: 7px; background: #fff6f7; color: #a84d59; font-size: 10px; line-height: 1.5; }.create-help { display: block; margin-top: 5px; color: #9da8b6; font-size: 9px; line-height: 1.4; }.create-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }.create-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 18px; border-top: 1px solid #edf0f4; }.create-actions .el-button { font-size: 11px; }.create-guide { align-self: start; padding: 22px 20px; background: #fbfcfe; }.create-guide h2 { margin: 7px 0 22px; color: #3c4e68; font-size: 16px; letter-spacing: -.03em; }.guide-item { display: flex; gap: 9px; margin: 0 0 18px; }.guide-item > span { display: grid; place-items: center; width: 27px; height: 27px; flex: 0 0 27px; border-radius: 6px; background: #edf3ff; color: #688bd9; }.guide-item strong { display: block; color: #61718a; font-size: 10px; }.guide-item p, .guide-note p { margin: 4px 0 0; color: #929eae; font-size: 9px; line-height: 1.5; }.guide-note { padding-top: 15px; border-top: 1px solid #e8edf3; }.guide-note strong { color: #a07d37; font-size: 9px; }
@media (max-width: 820px) { .project-create-page { padding: 25px 20px; }.create-layout { grid-template-columns: 1fr; }.create-guide { order: -1; }.create-form-grid { grid-template-columns: 1fr; } }
</style>
