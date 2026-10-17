<!--
  模块职责：合并预览对话框 —— 把一次合并"会发生什么"摊开给人看，然后才允许确认。

  维护提示：
    1) **确认按钮只认 `preview.canConfirm`**。阻断项由服务端给出（有活动 Run、工作区脏、
      主分支被占用、已合并……），前端不重算，也不提供"我知道有风险，仍然合并"的逃生门——
       服务端在 `merge` 里会把同一条判据再跑一次，能点也没用。
    2) `conflict_risk` 仍然可以确认（预测只是预测），文案改成「仍然尝试合并」；
       这与"被阻断"是两回事，别把两者合并成一个 disabled。
    3) 页签用普通按钮 + v-if，而不是 `el-tabs`：预览内容要能被组件测试直接断言，
       也不需要为六个页签各挂一个未挂载的 pane。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { WorktreeMergePreview } from "../types";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    preview: WorktreeMergePreview | null;
    busy?: boolean;
    error?: string | null;
  }>(),
  { busy: false, error: null },
);

const emit = defineEmits<{ "update:modelValue": [value: boolean]; confirm: [] }>();

type Tab = "overview" | "commits" | "files" | "conflict" | "commands";
const tab = ref<Tab>("overview");
const tabs: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "概览" },
  { key: "commits", label: "提交" },
  { key: "files", label: "文件变更" },
  { key: "conflict", label: "冲突预测" },
  { key: "commands", label: "将要执行的命令" },
];

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) tab.value = "overview";
  },
);

const confirmLabel = computed(() => (props.preview?.conclusion === "conflict_risk" ? "仍然尝试合并" : "确认合并"));
const canConfirm = computed(() => Boolean(props.preview?.canConfirm) && !props.busy);

function close() {
  if (props.busy) return;
  emit("update:modelValue", false);
}

const conflictTitle = computed(() => {
  const prediction = props.preview?.conflictPrediction;
  if (!prediction) return "尚未执行冲突预测";
  if (prediction.hasConflicts) return `预测到 ${prediction.conflictFiles.length} 个冲突文件`;
  return prediction.message || "未预测到文本级合并冲突";
});
</script>

<template>
  <el-dialog
    class="worktree-merge-preview"
    align-center
    :model-value="props.modelValue"
    width="min(880px, calc(100vw - 40px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!props.busy"
    :show-close="!props.busy"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="preview-head">
        <span class="preview-eyebrow">合并预览</span>
        <h2>{{ props.preview?.baseBranch }} ← {{ props.preview?.branch || "detached" }}</h2>
      </div>
    </template>

    <div v-if="props.preview" class="preview-body" data-merge-preview>
      <div :class="['preview-verdict', `verdict-${props.preview.conclusion}`]" data-merge-conclusion>
        <el-tag
          :type="props.preview.conclusion === 'ready' ? 'success' : props.preview.conclusion === 'conflict_risk' ? 'warning' : 'danger'"
          effect="dark"
        >
          {{ props.preview.conclusionLabel }}
        </el-tag>
        <div class="verdict-counts">
          <span
            >Ahead <strong>{{ props.preview.aheadCount }}</strong></span
          >
          <span
            >Behind <strong>{{ props.preview.behindCount }}</strong></span
          >
          <span
            >文件 <strong>{{ props.preview.fileSummary.total }}</strong></span
          >
        </div>
      </div>

      <div v-if="props.preview.blockers.length" class="preview-alerts" data-merge-blockers>
        <p v-for="blocker in props.preview.blockers" :key="blocker" class="alert alert-error">{{ blocker }}</p>
      </div>
      <div v-if="props.preview.warnings.length" class="preview-alerts" data-merge-warnings>
        <p v-for="warning in props.preview.warnings" :key="warning" class="alert alert-warning">{{ warning }}</p>
      </div>
      <p v-if="props.error" class="alert alert-error" role="alert">{{ props.error }}</p>

      <nav class="preview-tabs" aria-label="预览内容">
        <button
          v-for="entry in tabs"
          :key="entry.key"
          type="button"
          :class="{ active: tab === entry.key }"
          :data-preview-tab="entry.key"
          @click="tab = entry.key"
        >
          {{ entry.label }}
        </button>
      </nav>

      <div v-if="tab === 'overview'" class="preview-pane" data-preview-pane="overview">
        <dl class="preview-facts">
          <div>
            <dt>仓库</dt>
            <dd>{{ props.preview.repoRoot }}</dd>
          </div>
          <div>
            <dt>分支</dt>
            <dd>{{ props.preview.branch || "detached" }}</dd>
          </div>
          <div>
            <dt>工作区</dt>
            <dd>{{ props.preview.dirtyState }}</dd>
          </div>
          <div>
            <dt>主分支 HEAD</dt>
            <dd>
              <code>{{ props.preview.baseHead }}</code>
            </dd>
          </div>
          <div>
            <dt>分支 HEAD</dt>
            <dd>
              <code>{{ props.preview.taskHead }}</code>
            </dd>
          </div>
          <div>
            <dt>共同祖先</dt>
            <dd>
              <code>{{ props.preview.mergeBase }}</code>
            </dd>
          </div>
          <div>
            <dt>已合并</dt>
            <dd>{{ props.preview.merged ? "是" : "否" }}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{{ props.preview.factory ? props.preview.factory.planTitle || props.preview.factory.runId : "手动分支" }}</dd>
          </div>
        </dl>
        <div class="file-summary">
          <div>
            <span>新增</span><strong>{{ props.preview.fileSummary.added }}</strong>
          </div>
          <div>
            <span>修改</span><strong>{{ props.preview.fileSummary.modified }}</strong>
          </div>
          <div>
            <span>删除</span><strong>{{ props.preview.fileSummary.deleted }}</strong>
          </div>
          <div>
            <span>重命名</span><strong>{{ props.preview.fileSummary.renamed }}</strong>
          </div>
        </div>
      </div>

      <div v-else-if="tab === 'commits'" class="preview-pane" data-preview-pane="commits">
        <p v-if="!props.preview.recentCommits.length" class="pane-empty">没有待合并提交。</p>
        <ul v-else class="commit-list">
          <li v-for="commit in props.preview.recentCommits" :key="commit.hash">
            <code>{{ commit.hash }}</code>
            <span class="commit-subject">{{ commit.subject }}</span>
            <small>{{ commit.author }} · {{ commit.relativeTime }}</small>
          </li>
        </ul>
      </div>

      <div v-else-if="tab === 'files'" class="preview-pane" data-preview-pane="files">
        <p v-if="!props.preview.fileChanges.length" class="pane-empty">没有文件变更。</p>
        <ul v-else class="file-list">
          <li v-for="change in props.preview.fileChanges" :key="`${change.status}:${change.path}`">
            <el-tag size="small" effect="plain">{{ change.status }}</el-tag>
            <span class="file-path">{{ change.path }}</span>
            <small v-if="change.previousPath" class="file-previous">原路径 {{ change.previousPath }}</small>
          </li>
        </ul>
      </div>

      <div v-else-if="tab === 'conflict'" class="preview-pane" data-preview-pane="conflict">
        <p
          :class="[
            'alert',
            props.preview.conflictPrediction.hasConflicts
              ? 'alert-warning'
              : props.preview.conflictPrediction.status === 'clean'
                ? 'alert-ok'
                : 'alert-warning',
          ]"
        >
          {{ conflictTitle }}
        </p>
        <ul v-if="props.preview.conflictPrediction.conflictFiles.length" class="conflict-files">
          <li v-for="file in props.preview.conflictPrediction.conflictFiles" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
      </div>

      <div v-else class="preview-pane" data-preview-pane="commands">
        <pre class="command-block">{{ props.preview.commands.join("\n") }}</pre>
      </div>
    </div>

    <template #footer>
      <div class="preview-footer">
        <el-button :disabled="props.busy" @click="close">取消</el-button>
        <el-button type="primary" :loading="props.busy" :disabled="!canConfirm" data-merge-confirm @click="emit('confirm')">
          {{ confirmLabel }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.preview-head h2 {
  margin: 4px 0 0;
  color: #1e2b40;
  font-size: 19px;
  letter-spacing: -0.02em;
}
.preview-eyebrow {
  color: #8796ad;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.preview-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: min(62vh, 620px);
  overflow: auto;
}
.preview-verdict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 10px;
  background: #f6f9fd;
  border: 1px solid #e5ebf3;
}
.preview-verdict.verdict-conflict_risk {
  background: #fffbf2;
  border-color: #f2e3c4;
}
.preview-verdict.verdict-blocked {
  background: #fff7f7;
  border-color: #f0d5d5;
}
.verdict-counts {
  display: flex;
  gap: 18px;
  color: #7c8ba3;
  font-size: 11px;
}
.verdict-counts strong {
  margin-left: 4px;
  color: #33425a;
  font-size: 15px;
}
.preview-alerts {
  display: grid;
  gap: 6px;
}
.alert {
  margin: 0;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.alert-error {
  background: #fff6f6;
  border: 1px solid #f0d0d3;
  color: #a94851;
}
.alert-warning {
  background: #fffbf1;
  border: 1px solid #f2e4c6;
  color: #8a6a22;
}
.alert-ok {
  background: #f4fbf7;
  border: 1px solid #cfe9db;
  color: #2f7a56;
}
.preview-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 1px solid #e8edf3;
  padding-bottom: 8px;
}
.preview-tabs button {
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #6b7c94;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.preview-tabs button.active {
  border-color: #cfe0f4;
  background: #eef5fd;
  color: #2c6cad;
  font-weight: 700;
}
.preview-pane {
  min-height: 180px;
}
.preview-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px 20px;
  margin: 0 0 14px;
}
.preview-facts div {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.preview-facts dt {
  flex: 0 0 84px;
  color: #8b99ae;
}
.preview-facts dd {
  margin: 0;
  color: #33425a;
  overflow-wrap: anywhere;
}
.file-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.file-summary div {
  padding: 10px 12px;
  border: 1px solid #e8edf3;
  border-radius: 8px;
  background: #fbfcfe;
}
.file-summary span {
  display: block;
  color: #8b99ae;
  font-size: 10px;
}
.file-summary strong {
  color: #33425a;
  font-size: 18px;
}
.commit-list,
.file-list,
.conflict-files {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.commit-list li,
.file-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid #eef1f5;
  border-radius: 7px;
  font-size: 12px;
}
.commit-subject {
  flex: 1 1 auto;
  color: #33425a;
  overflow-wrap: anywhere;
}
.commit-list small,
.file-previous {
  color: #93a1b5;
  font-size: 10px;
}
.file-path {
  flex: 1 1 auto;
  color: #33425a;
  overflow-wrap: anywhere;
}
.pane-empty {
  margin: 0;
  color: #93a1b5;
  font-size: 12px;
}
.command-block {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: #1e2b40;
  color: #d6e2f1;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preview-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
@media (max-width: 700px) {
  .file-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
