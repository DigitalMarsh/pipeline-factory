<!--
  模块职责：合并结果对话框 —— 报告这次 Git 操作的结果，以及它**有没有**把 Factory 一侧
   （MergeRequest / Plan / worktree 回收）一起推进。

  维护提示：
    1) **Git 结果与 Factory 联动是两件事，分开显示**。合并已经写进仓库是既成事实，即使
       `confirmMerged` 失败也不会回滚（见 worktree/service.ts 维护提示 4）；把两者混成一句
       "合并成功/失败"会让用户以为需要重做合并。
    2) `merge_conflict` 不是失败：仓库停在合并中，下一步是「继续」或「中止」，文案要指向面板上的横幅。
    3) 分支名、提交号这类事实**原样展示**，不做缩写（`baseHeadBefore → baseHeadAfter` 是排查依据）。
-->
<script setup lang="ts">
import type { WorktreeMergeResult } from "../types";

const props = defineProps<{ modelValue: boolean; result: WorktreeMergeResult | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

function close() {
  emit("update:modelValue", false);
}

function title(result: WorktreeMergeResult | null): string {
  if (!result) return "合并结果";
  if (result.status === "merged") return "合并完成";
  if (result.status === "merge_conflict") return "合并产生冲突";
  if (result.status === "aborted") return "已中止合并";
  return "合并失败";
}
</script>

<template>
  <el-dialog
    class="worktree-merge-result"
    align-center
    :model-value="props.modelValue"
    width="min(620px, calc(100vw - 40px))"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="result-head">
        <span class="result-eyebrow">Worktree 合并</span>
        <h2 data-merge-result-title>{{ title(props.result) }}</h2>
      </div>
    </template>

    <div v-if="props.result" class="result-body" data-merge-result>
      <p :class="['result-message', `tone-${props.result.status}`]" data-merge-result-message>{{ props.result.message }}</p>

      <dl class="result-facts">
        <div>
          <dt>分支</dt>
          <dd>{{ props.result.branch || "detached" }}</dd>
        </div>
        <div>
          <dt>主分支</dt>
          <dd>{{ props.result.baseBranch }}</dd>
        </div>
        <div>
          <dt>合并前 HEAD</dt>
          <dd>
            <code>{{ props.result.baseHeadBefore }}</code>
          </dd>
        </div>
        <div>
          <dt>合并后 HEAD</dt>
          <dd>
            <code>{{ props.result.baseHeadAfter }}</code>
          </dd>
        </div>
      </dl>

      <div v-if="props.result.conflictFiles.length" class="result-block" data-merge-result-conflicts>
        <h3>冲突文件</h3>
        <ul>
          <li v-for="file in props.result.conflictFiles" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
        <p class="result-hint">解决冲突并 <code>git add</code> 之后，在面板顶部点「继续合并」；也可以直接「中止合并」。</p>
      </div>

      <div v-if="props.result.factory" class="result-block" data-merge-result-factory>
        <h3>Factory 联动</h3>
        <p v-if="props.result.factory.mergeRequest === 'confirmed'" class="result-ok">
          已确认 MergeRequest（Run {{ props.result.factory.runId }}），对应 Plan 已推进到 MERGED。
        </p>
        <p v-else-if="props.result.factory.mergeRequest === 'failed'" class="result-error">
          MergeRequest 确认失败：{{ props.result.factory.message || "未知原因" }}
        </p>
        <p v-else class="result-hint">{{ props.result.factory.message || "没有可确认的 MergeRequest。" }}</p>
        <p v-if="props.result.factory.workspace" class="result-hint">
          worktree 回收：{{ props.result.factory.workspace.worktreeRemoved ? "已回收" : "未回收"
          }}<span v-if="props.result.factory.message && props.result.factory.mergeRequest === 'confirmed'"
            >（{{ props.result.factory.message }}）</span
          >
        </p>
      </div>

      <div class="result-block">
        <h3>执行的命令</h3>
        <pre class="command-block">{{ props.result.commands.join("\n") }}</pre>
      </div>
    </div>

    <template #footer>
      <div class="result-footer">
        <el-button type="primary" @click="close">知道了</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.result-head h2 {
  margin: 4px 0 0;
  color: #1e2b40;
  font-size: 19px;
}
.result-eyebrow {
  color: #8796ad;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.result-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.result-message {
  margin: 0;
  padding: 11px 13px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.result-message.tone-merged {
  background: #f4fbf7;
  border: 1px solid #cfe9db;
  color: #2f7a56;
}
.result-message.tone-merge_conflict {
  background: #fffbf1;
  border: 1px solid #f2e4c6;
  color: #8a6a22;
}
.result-message.tone-error {
  background: #fff6f6;
  border: 1px solid #f0d0d3;
  color: #a94851;
}
.result-message.tone-aborted {
  background: #f7f9fc;
  border: 1px solid #e4eaf2;
  color: #5d6f88;
}
.result-facts {
  display: grid;
  gap: 6px;
  margin: 0;
}
.result-facts div {
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.result-facts dt {
  flex: 0 0 96px;
  color: #8b99ae;
}
.result-facts dd {
  margin: 0;
  color: #33425a;
  overflow-wrap: anywhere;
}
.result-block h3 {
  margin: 0 0 7px;
  color: #52637e;
  font-size: 12px;
  letter-spacing: 0.04em;
}
.result-block ul {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.result-ok {
  margin: 0;
  color: #2f7a56;
  font-size: 12px;
  line-height: 1.6;
}
.result-error {
  margin: 0;
  color: #a94851;
  font-size: 12px;
  line-height: 1.6;
}
.result-hint {
  margin: 6px 0 0;
  color: #7c8ba3;
  font-size: 11px;
  line-height: 1.6;
}
.command-block {
  margin: 0;
  padding: 11px 13px;
  border-radius: 8px;
  background: #1e2b40;
  color: #d6e2f1;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.result-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
