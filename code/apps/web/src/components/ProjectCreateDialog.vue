<!--
  模块职责：在当前工作区弹出 Project 创建表单，复用既有创建页的字段和 API 契约。
  维护提示：创建成功后由父级决定 Project/Explorer 切换；本组件不自行改变路由。
-->
<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { Check, FolderOpened, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { ExplorerThread, Project } from "../types";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  "project-created": [project: Project, explorer: ExplorerThread];
}>();

const saving = ref(false);
const error = ref<string | null>(null);
const form = reactive({ name: "", shortName: "", repoRoot: "", defaultBranch: "", worktreeRoot: "" });

function resetForm() {
  form.name = "";
  form.shortName = "";
  form.repoRoot = "";
  form.defaultBranch = "";
  form.worktreeRoot = "";
  error.value = null;
}

function updateDialogVisibility(value: boolean) {
  if (!value) resetForm();
  emit("update:modelValue", value);
}

function close() {
  updateDialogVisibility(false);
}

async function createProject() {
  if (saving.value) return;
  if (!form.name.trim() || !form.repoRoot.trim()) {
    error.value = "请填写项目名称和 Git 仓库目录";
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const result = await api.createProject({
      name: form.name.trim(),
      ...(form.shortName.trim() ? { shortName: form.shortName.trim() } : {}),
      repoRoot: form.repoRoot.trim(),
      ...(form.defaultBranch.trim() ? { defaultBranch: form.defaultBranch.trim() } : {}),
      ...(form.worktreeRoot.trim() ? { worktreeRoot: form.worktreeRoot.trim() } : {}),
    });
    ElMessage.success("项目已创建");
    emit("project-created", result.project, result.explorer);
    updateDialogVisibility(false);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "项目创建失败";
    ElMessage.error(error.value);
  } finally {
    saving.value = false;
  }
}

watch(() => props.modelValue, (open) => {
  if (open) resetForm();
});
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    class="project-create-dialog"
    width="min(620px, calc(100vw - 28px))"
    :close-on-click-modal="false"
    destroy-on-close
    @update:model-value="updateDialogVisibility($event)"
  >
    <template #header>
      <div class="project-create-heading">
        <div class="project-create-heading-icon"><FolderOpened :size="20" /></div>
        <div>
          <div class="eyebrow">PIPELINE FACTORY · PROJECT SETUP</div>
          <h2>New Project</h2>
          <p>在当前 Explorer 中添加一个本机 Git 仓库，不离开当前工作区。</p>
        </div>
      </div>
    </template>

    <div v-if="error" class="project-create-alert"><Warning :size="15" /> {{ error }}</div>
    <form class="project-create-form" @submit.prevent="createProject">
      <div class="project-create-intro">新 Project 必须指向 Git 仓库根目录。创建前 API 会校验真实路径和默认分支。</div>
      <div class="project-create-grid"><label>Project name <input v-model="form.name" autofocus placeholder="例如：Pipeline Factory" /></label><label>Project short name <input v-model="form.shortName" placeholder="例如：PF" /><small>用于列表和执行上下文；留空则使用 Project name。</small></label></div>
      <label>Git repository root <input v-model="form.repoRoot" placeholder="/Users/you/Project/repository" /><small>请输入本机可访问的绝对路径，不能是仓库子目录。</small></label>
      <div class="project-create-grid"><label>Default branch <input v-model="form.defaultBranch" placeholder="自动检测" /></label><label>Worktree root <input v-model="form.worktreeRoot" placeholder="自动生成" /></label></div>
    </form>

    <template #footer>
      <el-button @click="close">Cancel</el-button>
      <el-button type="primary" data-create-action="submit" :loading="saving" :aria-busy="saving ? 'true' : undefined" @click="createProject"><Check :size="14" /> Validate & Create</el-button>
    </template>
  </el-dialog>
</template>

<style>
.project-create-dialog .el-dialog__header { margin: 0; padding: 22px 25px 17px; border-bottom: 1px solid #edf0f4; }
.project-create-dialog .el-dialog__body { padding: 18px 25px 8px; }
.project-create-dialog .el-dialog__footer { padding: 13px 25px 19px; border-top: 1px solid #edf0f4; }
.project-create-heading { display: flex; align-items: flex-start; gap: 11px; }
.project-create-heading-icon { display: grid; place-items: center; width: 39px; height: 39px; flex: 0 0 39px; border-radius: 8px; background: #edf3ff; color: #4d7be4; }
.project-create-heading h2 { margin: 6px 0 5px; color: #253650; font-size: 20px; letter-spacing: -.04em; }
.project-create-heading p { margin: 0; color: #8a97a8; font-size: 10px; }
.project-create-dialog .eyebrow { color: #8492a8; font-size: 10px; font-weight: 800; letter-spacing: .15em; }
.project-create-alert { display: flex; align-items: center; gap: 8px; margin-bottom: 13px; padding: 10px 12px; border: 1px solid #f0d1d5; border-radius: 7px; background: #fff6f7; color: #a35560; font-size: 10px; }
.project-create-form { display: grid; gap: 16px; padding: 2px 1px 8px; }
.project-create-intro { padding: 11px 12px; border: 1px solid #dbe7ff; border-radius: 7px; background: #f6f9ff; color: #7083a4; font-size: 10px; line-height: 1.5; }
.project-create-form label { display: block; color: #718097; font-size: 10px; font-weight: 700; }
.project-create-form input { display: block; box-sizing: border-box; width: 100%; height: 35px; margin-top: 7px; padding: 0 10px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; }
.project-create-form input:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }
.project-create-form label small { display: block; margin-top: 5px; color: #9aa6b6; font-size: 9px; }
.project-create-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
@media (max-width: 650px) { .project-create-grid { grid-template-columns: 1fr; } }
</style>
