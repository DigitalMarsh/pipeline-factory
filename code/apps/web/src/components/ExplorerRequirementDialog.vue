<!--
  模块职责：新增一条需求时收集**需求描述**——本对话框只管输入与对话框自己的状态，
  真正建需求、切线程、起探索回合由 ExplorerView 统一协调（与 ExplorerRenameDialog 同一条分工）。

  维护提示：
    1) 提交的是**纯文本**（`submit` 事件），不做任何改写。那段文本会原样落成探索线程里的第一条
       用户消息，也是后续 `draft` 的初值——在这里"顺手美化"会让用户看到的与他写的不一致。
    2) 空描述与纯空白都不算填了：按钮的可用性、`⌘/Ctrl+Enter`、提交前的校验**共用 `canSubmit`**
       一处判据，不要各写一份。
    3) 关闭时若正在提交，忽略这次关闭（`updateDialogVisibility`）——否则会出现"请求还在飞、
       对话框已经没了"的半状态。
    4) `maxlength` 与那个计数器是同一个数（`DESCRIPTION_LIMIT`）；改一处要两处一起改。
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Check, CircleClose, MagicStick, Plus, Warning } from "@element-plus/icons-vue";

const DESCRIPTION_LIMIT = 2000;

const props = defineProps<{
  modelValue: boolean;
  /** 这条需求将落到哪条线程下——写在标题旁边，省得用户不确定自己在给谁加。 */
  threadTitle: string;
  saving: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  submit: [description: string];
}>();

const description = ref("");
const localError = ref<string | null>(null);
const descriptionInput = ref<HTMLTextAreaElement | null>(null);
const errorMessage = computed(() => props.error ?? localError.value);
const canSubmit = computed(() => Boolean(description.value.trim()) && !props.saving);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    description.value = "";
    localError.value = null;
    await nextTick();
    descriptionInput.value?.focus();
  },
  { immediate: true },
);

function updateDialogVisibility(value: boolean) {
  if (!value && props.saving) return;
  emit("update:modelValue", value);
}

function close() {
  updateDialogVisibility(false);
}

function submit() {
  const trimmed = description.value.trim();
  if (!trimmed) {
    localError.value = "请先写下这项需求要解决什么";
    return;
  }
  localError.value = null;
  emit("submit", trimmed);
}

/** `⌘/Ctrl + Enter` 提交；单独 Enter 留给换行——需求描述天然是多行的。 */
function submitOnShortcut(event: KeyboardEvent) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  if (canSubmit.value) submit();
}
</script>

<template>
  <el-dialog
    class="requirement-dialog"
    align-center
    :model-value="props.modelValue"
    width="min(760px, calc(100vw - 40px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    destroy-on-close
    @update:model-value="updateDialogVisibility"
  >
    <template #header>
      <div class="requirement-dialog-heading">
        <div class="requirement-dialog-heading-icon"><Plus :size="20" /></div>
        <div class="requirement-dialog-heading-copy">
          <div class="eyebrow">探索线程</div>
          <h2>新增需求</h2>
        </div>
        <div v-if="props.threadTitle" class="requirement-dialog-thread" :title="props.threadTitle">
          <span>加到</span><strong>{{ props.threadTitle }}</strong>
        </div>
      </div>
    </template>

    <form class="requirement-dialog-form" @submit.prevent="submit">
      <label class="requirement-dialog-field">
        <span class="requirement-dialog-label">需求描述</span>
        <textarea
          ref="descriptionInput"
          v-model="description"
          :maxlength="DESCRIPTION_LIMIT"
          :disabled="saving"
          aria-label="需求描述"
          placeholder="例如：在项目详情页添加任务时总是提示「所属项目不合法」，希望添加的任务能正确归属到当前选中的项目；只改前端请求组装这一处。"
          @keydown="submitOnShortcut"
        />
      </label>

      <div class="requirement-dialog-meta">
        <span class="requirement-dialog-counter" :class="{ near: description.length > DESCRIPTION_LIMIT * 0.9 }"
          >{{ description.length }} / {{ DESCRIPTION_LIMIT }}</span
        >
        <span class="requirement-dialog-shortcut"><kbd>⌘</kbd><kbd>Enter</kbd> 提交</span>
      </div>

      <aside class="requirement-dialog-guide">
        <div class="requirement-dialog-guide-title"><MagicStick :size="14" /> 写清这三件事，探索会少绕几步</div>
        <ul>
          <li><strong>要解决什么</strong>——现在是什么现象、什么时候出现</li>
          <li><strong>期望的结果</strong>——做完之后应该是什么样</li>
          <li><strong>边界</strong>——哪些不能动、只改哪一处</li>
        </ul>
      </aside>

      <div v-if="errorMessage" class="requirement-dialog-error" role="alert"><Warning :size="14" /> {{ errorMessage }}</div>
    </form>

    <template #footer>
      <div class="requirement-dialog-footer">
        <p class="requirement-dialog-footer-hint">提交后会为这条需求开一段独立的探索对话，探索出方案再确认执行。</p>
        <div class="requirement-dialog-footer-actions">
          <el-button :disabled="saving" @click="close"><CircleClose :size="14" /> 取消</el-button>
          <el-button type="primary" data-requirement-dialog-action="submit" :loading="saving" :disabled="!canSubmit" @click="submit"
            ><Check :size="14" /> 开始探索</el-button
          >
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style>
.requirement-dialog .el-dialog__header {
  margin: 0;
  padding: 22px 28px 18px;
  border-bottom: 1px solid #edf0f4;
}
.requirement-dialog .el-dialog__body {
  padding: 22px 28px 20px;
}
.requirement-dialog .el-dialog__footer {
  padding: 15px 28px 20px;
  border-top: 1px solid #edf0f4;
}
.requirement-dialog-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.requirement-dialog-heading-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 9px;
  background: #edf3ff;
  color: #4d7be4;
}
.requirement-dialog-heading-copy h2 {
  margin: 5px 0 0;
  color: #253650;
  font-size: 21px;
  letter-spacing: -0.04em;
}
.requirement-dialog .eyebrow {
  color: #8492a8;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
/* 线程标题只占一行，长了省略——它是"给谁加"的提示，不该跟标题抢位。 */
.requirement-dialog-thread {
  display: flex;
  align-items: baseline;
  gap: 5px;
  max-width: 260px;
  margin-left: auto;
  padding: 5px 9px;
  border-radius: 6px;
  background: #f5f7fb;
  color: #8492a8;
  font-size: 10px;
}
.requirement-dialog-thread strong {
  overflow: hidden;
  color: #5b6a83;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.requirement-dialog-form {
  display: grid;
  gap: 9px;
}
.requirement-dialog-field {
  display: block;
}
.requirement-dialog-label {
  display: block;
  margin-bottom: 8px;
  color: #718097;
  font-size: 10px;
  font-weight: 700;
}
/* 大是对这个对话框的一半要求：需求描述是"一次写清楚"的东西，挤在四行里写不完整。 */
.requirement-dialog-field textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 190px;
  padding: 13px 14px;
  border: 1px solid #dfe6ef;
  border-radius: 8px;
  outline: 0;
  resize: vertical;
  color: #3f4f68;
  background: #fff;
  font:
    13px/1.72 inherit,
    "PingFang SC",
    "Microsoft YaHei",
    sans-serif;
}
.requirement-dialog-field textarea:focus {
  border-color: #82a6ef;
  box-shadow: 0 0 0 3px #edf3ff;
}
.requirement-dialog-field textarea:disabled {
  color: #a4afbc;
  background: #f5f7fa;
}
.requirement-dialog-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #9aa5b4;
  font-size: 10px;
}
.requirement-dialog-counter.near {
  color: #c08a3e;
}
.requirement-dialog-shortcut {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.requirement-dialog-shortcut kbd {
  padding: 2px 5px;
  border: 1px solid #e3e8f0;
  border-radius: 4px;
  background: #f7f9fc;
  color: #7b8798;
  font:
    10px ui-monospace,
    monospace;
}
.requirement-dialog-guide {
  margin-top: 4px;
  padding: 12px 14px;
  border: 1px solid #e6ecf6;
  border-radius: 8px;
  background: #f8faff;
}
.requirement-dialog-guide-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #5b76a8;
  font-size: 11px;
  font-weight: 700;
}
.requirement-dialog-guide ul {
  display: grid;
  gap: 5px;
  margin: 9px 0 0;
  padding: 0;
  list-style: none;
}
.requirement-dialog-guide li {
  color: #7e8b9d;
  font-size: 11px;
  line-height: 1.55;
}
.requirement-dialog-guide li::before {
  content: "·";
  margin-right: 6px;
  color: #a9b7cb;
}
.requirement-dialog-guide strong {
  color: #5f6d81;
}
.requirement-dialog-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  border: 1px solid #f0d1d5;
  border-radius: 6px;
  background: #fff6f7;
  color: #a35560;
  font-size: 11px;
}
.requirement-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.requirement-dialog-footer-hint {
  margin: 0;
  color: #929eae;
  font-size: 10px;
  line-height: 1.5;
}
.requirement-dialog-footer-actions {
  display: flex;
  flex: none;
  gap: 8px;
}
.requirement-dialog-footer-actions .el-button {
  font-size: 11px;
}
</style>
