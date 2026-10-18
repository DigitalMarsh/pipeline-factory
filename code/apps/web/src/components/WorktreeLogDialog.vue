<!--
  模块职责：某条分支（或某个提交）的提交历史浏览器 —— 左列提交、右列该提交的文件与单文件 diff。
  对应 worktree-manage 合并预览里的「Git Log」页签，但独立成一个对话框：diff 需要宽度，
  塞进预览页签里会把它挤成一条缝。

  维护提示：
    1) 这**只读**：不 checkout、不 reset、不动工作区。所有数据来自 `git log` / `git show`。
    2) 三个请求分开做（提交 → 文件 → diff），任何一步失败都在对应区域显示原因，不连带清空别处——
       一个 rename 的文件 diff 取不到，不该让整页提交历史消失。
    3) 没有可显示的文本差异时服务端返回空串（二进制文件、mode-only 变更），这里给一句提示，
       不要把空白的 `<pre>` 当成"加载失败"。
    4) 要查看的 ref 叫 **`target` 而不是 `ref`**：`ref` 是 Vue 的保留 prop 名，`:ref="x"`
       会被当成模板引用，轮不到组件 props（实测：props.target 一直是 undefined）。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import type { WorktreeFileChange, WorktreeLogCommit } from "../types";

const props = withDefaults(defineProps<{ modelValue: boolean; projectId: string; target: string; title?: string }>(), { title: "" });
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const commits = ref<WorktreeLogCommit[]>([]);
const commitsLoading = ref(false);
const commitsError = ref("");
const selectedHash = ref<string | null>(null);
const files = ref<WorktreeFileChange[]>([]);
const filesLoading = ref(false);
const filesError = ref("");
const selectedPath = ref<string | null>(null);
const diff = ref("");
const diffLoading = ref(false);
const diffError = ref("");

watch(
  () => [props.modelValue, props.target, props.projectId] as const,
  ([visible]) => {
    if (!visible) return;
    void loadCommits();
  },
  { immediate: true },
);

async function loadCommits() {
  commitsLoading.value = true;
  commitsError.value = "";
  commits.value = [];
  selectedHash.value = null;
  files.value = [];
  diff.value = "";
  try {
    const response = await api.worktreeLog(props.projectId, props.target);
    commits.value = response.items;
    if (response.items[0]) await selectCommit(response.items[0]);
  } catch (caught) {
    commitsError.value = caught instanceof Error ? caught.message : "提交历史加载失败";
  } finally {
    commitsLoading.value = false;
  }
}

async function selectCommit(commit: WorktreeLogCommit) {
  selectedHash.value = commit.hash;
  selectedPath.value = null;
  diff.value = "";
  diffError.value = "";
  files.value = [];
  filesError.value = "";
  filesLoading.value = true;
  try {
    const response = await api.worktreeCommitFiles(props.projectId, commit.hash);
    files.value = response.items;
  } catch (caught) {
    filesError.value = caught instanceof Error ? caught.message : "提交文件加载失败";
  } finally {
    filesLoading.value = false;
  }
}

async function selectFile(file: WorktreeFileChange) {
  const commit = selectedHash.value;
  if (!commit) return;
  selectedPath.value = file.path;
  diff.value = "";
  diffError.value = "";
  diffLoading.value = true;
  try {
    const response = await api.worktreeCommitDiff(props.projectId, commit, file.path, file.previousPath);
    diff.value = response.diff;
  } catch (caught) {
    diffError.value = caught instanceof Error ? caught.message : "文件 diff 读取失败";
  } finally {
    diffLoading.value = false;
  }
}

const heading = computed(() => props.title || props.target);
</script>

<template>
  <el-dialog
    class="worktree-log-dialog"
    align-center
    :model-value="props.modelValue"
    width="min(1040px, calc(100vw - 40px))"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="log-head">
        <span class="log-eyebrow">提交历史</span>
        <h2>{{ heading }}</h2>
      </div>
    </template>

    <div class="log-body" data-worktree-log>
      <section class="log-commits">
        <p v-if="commitsLoading" class="log-state" role="status">正在读取提交…</p>
        <p v-else-if="commitsError" class="log-state log-error" role="alert">{{ commitsError }}</p>
        <p v-else-if="!commits.length" class="log-state">这条 ref 上没有提交。</p>
        <ul v-else class="commit-list">
          <li v-for="commit in commits" :key="commit.hash">
            <button
              type="button"
              :class="{ active: commit.hash === selectedHash }"
              :data-log-commit="commit.hash"
              @click="selectCommit(commit)"
            >
              <code>{{ commit.shortHash }}</code>
              <span class="commit-subject">{{ commit.subject }}</span>
              <small>{{ commit.author }} · {{ commit.relativeTime }}</small>
            </button>
          </li>
        </ul>
      </section>

      <section class="log-detail">
        <p v-if="filesLoading" class="log-state" role="status">正在读取文件…</p>
        <p v-else-if="filesError" class="log-state log-error" role="alert">{{ filesError }}</p>
        <template v-else-if="selectedHash">
          <ul v-if="files.length" class="file-list">
            <li v-for="file in files" :key="`${file.status}:${file.path}`">
              <button type="button" :class="{ active: file.path === selectedPath }" @click="selectFile(file)">
                <span class="file-status">{{ file.status }}</span>
                <span class="file-path">{{ file.path }}</span>
                <small v-if="file.previousPath">原路径 {{ file.previousPath }}</small>
              </button>
            </li>
          </ul>
          <p v-else class="log-state">这个提交没有文件变更。</p>

          <p v-if="diffLoading" class="log-state" role="status">正在读取 diff…</p>
          <p v-else-if="diffError" class="log-state log-error" role="alert">{{ diffError }}</p>
          <pre v-else-if="diff" class="diff-block" data-log-diff>{{ diff }}</pre>
          <p v-else-if="selectedPath" class="log-state">这个文件在此提交里没有可显示的文本 diff（二进制或仅权限变更）。</p>
          <p v-else class="log-state">选择一个文件查看 diff。</p>
        </template>
        <p v-else class="log-state">选择一条提交查看文件。</p>
      </section>
    </div>

    <template #footer>
      <div class="log-footer">
        <el-button type="primary" @click="emit('update:modelValue', false)">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.log-head h2 {
  margin: 4px 0 0;
  color: #1e2b40;
  font-size: 18px;
  overflow-wrap: anywhere;
}
.log-eyebrow {
  color: #8796ad;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.log-body {
  display: grid;
  grid-template-columns: minmax(240px, 34%) minmax(0, 1fr);
  gap: 14px;
  height: min(62vh, 560px);
}
.log-commits,
.log-detail {
  min-height: 0;
  overflow: auto;
  border: 1px solid #e8edf3;
  border-radius: 10px;
  padding: 8px;
  background: #fbfcfe;
}
.commit-list,
.file-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.commit-list button,
.file-list button {
  display: flex;
  width: 100%;
  align-items: baseline;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: #33425a;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.commit-list button:hover,
.file-list button:hover {
  background: #f2f6fc;
}
.commit-list button.active,
.file-list button.active {
  border-color: #cfe0f4;
  background: #eef5fd;
}
.commit-subject {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-list small {
  flex: none;
  color: #93a1b5;
  font-size: 10px;
}
.file-status {
  flex: none;
  min-width: 30px;
  color: #8b99ae;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 11px;
}
.file-path {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list small {
  flex: none;
  color: #93a1b5;
  font-size: 10px;
}
.diff-block {
  margin: 10px 0 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: #1e2b40;
  color: #d6e2f1;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log-state {
  margin: 6px;
  color: #93a1b5;
  font-size: 12px;
  line-height: 1.6;
}
.log-error {
  color: #a94851;
}
.log-footer {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 820px) {
  .log-body {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .log-commits {
    max-height: 220px;
  }
  .log-detail {
    max-height: 320px;
  }
}
</style>
