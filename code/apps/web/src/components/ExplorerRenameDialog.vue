<!--
  模块职责：改名对话框的**骨架与样式只有这一份**——线程改名与需求改名共用它，
  差别全在 `copy` 那几行字上（"重命名线程" / "重命名需求"），省得两处样式各自漂。
  维护提示：组件只负责输入和对话框状态，API 请求由 ExplorerView 统一协调。
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Check, CircleClose, EditPen, Warning } from "@element-plus/icons-vue";

type Props = {
  modelValue: boolean;
  initialValue: string;
  saving: boolean;
  error: string | null;
  /** 文案随用途走。字段名与"这是给谁改名"无关，所以四个字都在这里给。 */
  copy: {
    eyebrow: string;
    heading: string;
    fieldLabel: string;
    hint: string;
    submitLabel: string;
  };
};

type Emits = {
  "update:modelValue": [value: boolean];
  submit: [value: string];
};

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const draftTitle = ref("");
const localError = ref<string | null>(null);
const titleInput = ref<HTMLInputElement | null>(null);
const saving = computed(() => props.saving);
const errorMessage = computed(() => props.error ?? localError.value);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    draftTitle.value = props.initialValue;
    localError.value = null;
    await nextTick();
    titleInput.value?.focus();
  },
  { immediate: true },
);

function updateDialogVisibility(value: boolean) {
  if (!value && saving.value) return;
  emit("update:modelValue", value);
}

function close() {
  updateDialogVisibility(false);
}

function submit() {
  const trimmedTitle = draftTitle.value.trim();
  if (!trimmedTitle) {
    localError.value = `${props.copy.fieldLabel}不能为空`;
    return;
  }
  localError.value = null;
  emit("submit", trimmedTitle);
}
</script>

<template>
  <el-dialog
    class="explorer-rename-dialog"
    align-center
    :model-value="props.modelValue"
    width="min(460px, calc(100vw - 28px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    destroy-on-close
    @update:model-value="updateDialogVisibility"
  >
    <template #header>
      <div class="explorer-rename-heading">
        <div class="explorer-rename-heading-icon"><EditPen :size="19" /></div>
        <div>
          <div class="eyebrow">{{ props.copy.eyebrow }}</div>
          <h2>{{ props.copy.heading }}</h2>
        </div>
      </div>
    </template>

    <form class="explorer-rename-form" @submit.prevent="submit">
      <label class="explorer-rename-field">
        <span>{{ props.copy.fieldLabel }}</span>
        <input
          ref="titleInput"
          v-model="draftTitle"
          autofocus
          maxlength="200"
          :disabled="saving"
          :aria-label="props.copy.fieldLabel"
          @keydown.enter.prevent="submit"
        />
      </label>
      <p class="explorer-rename-hint">{{ props.copy.hint }}</p>
      <div v-if="errorMessage" class="explorer-rename-error" role="alert"><Warning :size="14" /> {{ errorMessage }}</div>
    </form>

    <template #footer>
      <div class="explorer-rename-footer">
        <el-button :disabled="saving" @click="close"><CircleClose :size="14" /> 取消</el-button>
        <el-button type="primary" data-rename-action="submit" :loading="saving" :disabled="saving || !draftTitle.trim()" @click="submit"
          ><Check :size="14" /> {{ props.copy.submitLabel }}</el-button
        >
      </div>
    </template>
  </el-dialog>
</template>

<style>
.explorer-rename-dialog .el-dialog__header {
  margin: 0;
  padding: 22px 25px 17px;
  border-bottom: 1px solid #edf0f4;
}
.explorer-rename-dialog .el-dialog__body {
  padding: 20px 25px 18px;
}
.explorer-rename-dialog .el-dialog__footer {
  padding: 13px 25px 19px;
  border-top: 1px solid #edf0f4;
}
.explorer-rename-heading {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.explorer-rename-heading-icon {
  display: grid;
  place-items: center;
  width: 39px;
  height: 39px;
  flex: 0 0 39px;
  border-radius: 8px;
  background: #edf3ff;
  color: #4d7be4;
}
.explorer-rename-heading h2 {
  margin: 6px 0 0;
  color: #253650;
  font-size: 20px;
  letter-spacing: -0.04em;
}
.explorer-rename-dialog .eyebrow {
  color: #8492a8;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.explorer-rename-form {
  display: grid;
  gap: 9px;
}
.explorer-rename-field {
  display: block;
  color: #718097;
  font-size: 10px;
  font-weight: 700;
}
.explorer-rename-field input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 38px;
  margin-top: 8px;
  padding: 0 10px;
  border: 1px solid #dfe6ef;
  border-radius: 6px;
  outline: 0;
  color: #52627a;
  background: #fff;
  font-size: 12px;
}
.explorer-rename-field input:focus {
  border-color: #82a6ef;
  box-shadow: 0 0 0 2px #edf3ff;
}
.explorer-rename-field input:disabled {
  color: #a4afbc;
  background: #f5f7fa;
}
.explorer-rename-hint {
  margin: 0;
  color: #929eae;
  font-size: 10px;
  line-height: 1.5;
}
.explorer-rename-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid #f0d1d5;
  border-radius: 6px;
  background: #fff6f7;
  color: #a35560;
  font-size: 10px;
}
.explorer-rename-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.explorer-rename-footer .el-button {
  font-size: 11px;
}
</style>
