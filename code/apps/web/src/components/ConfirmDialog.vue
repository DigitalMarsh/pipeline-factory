<!--
  模块职责：需要人点一下才肯往下走的确认框——危险动作（删需求、终止 Run）共用这一份骨架。
  维护提示：
    1) **这里只有"确认"与"取消"**，没有第三种结果。此前用 `ElMessageBox.confirm` 时，"取消"与
       "点右上角 ×"是两个不同的 reject 值（`cancel` / `close`），调用方得各写一遍；现在两者
       都只是把 `modelValue` 置回 false，**分不出、也不必分**。
    2) `details` 是"这次会发生什么"的清单，与 `message` 分工：`message` 说**对谁做什么**（一句），
       `details` 说**连带影响**（可以有几条）。危险动作的代价必须写在明面上，不能只靠一个红色按钮暗示。
    3) 提交中（`busy`）关不掉：请求还在飞的时候把框关掉，用户就再也看不到它成没成。
-->
<script setup lang="ts">
import { computed } from "vue";
import { CircleClose, Warning, WarningFilled } from "@element-plus/icons-vue";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    eyebrow: string;
    heading: string;
    /** 一句话说清对谁做什么。 */
    message: string;
    /** 连带影响逐条列出来。 */
    details?: string[];
    confirmLabel: string;
    cancelLabel: string;
    tone?: "danger" | "primary";
    busy?: boolean;
    error?: string | null;
  }>(),
  { details: () => [], tone: "danger", busy: false, error: null },
);

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [];
}>();

const errorMessage = computed(() => props.error);

function updateDialogVisibility(value: boolean) {
  if (!value && props.busy) return;
  emit("update:modelValue", value);
}

function close() {
  updateDialogVisibility(false);
}
</script>

<template>
  <el-dialog
    class="confirm-dialog"
    :class="`tone-${props.tone}`"
    align-center
    :model-value="props.modelValue"
    width="min(560px, calc(100vw - 40px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!props.busy"
    :show-close="!props.busy"
    destroy-on-close
    @update:model-value="updateDialogVisibility"
  >
    <template #header>
      <div class="confirm-dialog-heading">
        <div class="confirm-dialog-heading-icon"><WarningFilled :size="20" /></div>
        <div>
          <div class="eyebrow">{{ props.eyebrow }}</div>
          <h2>{{ props.heading }}</h2>
        </div>
      </div>
    </template>

    <div class="confirm-dialog-body">
      <p class="confirm-dialog-message">{{ props.message }}</p>
      <ul v-if="props.details.length" class="confirm-dialog-details">
        <li v-for="detail in props.details" :key="detail">{{ detail }}</li>
      </ul>
      <div v-if="errorMessage" class="confirm-dialog-error" role="alert"><Warning :size="14" /> {{ errorMessage }}</div>
    </div>

    <template #footer>
      <div class="confirm-dialog-footer">
        <el-button :disabled="props.busy" @click="close"><CircleClose :size="14" /> {{ props.cancelLabel }}</el-button>
        <el-button
          :type="props.tone === 'danger' ? 'danger' : 'primary'"
          data-confirm-dialog-action="confirm"
          :loading="props.busy"
          :disabled="props.busy"
          @click="emit('confirm')"
          >{{ props.confirmLabel }}</el-button
        >
      </div>
    </template>
  </el-dialog>
</template>

<style>
.confirm-dialog .el-dialog__header {
  margin: 0;
  padding: 22px 26px 18px;
  border-bottom: 1px solid #edf0f4;
}
.confirm-dialog .el-dialog__body {
  padding: 20px 26px 18px;
}
.confirm-dialog .el-dialog__footer {
  padding: 14px 26px 20px;
  border-top: 1px solid #edf0f4;
}
.confirm-dialog-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.confirm-dialog-heading-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 9px;
  background: #fdeced;
  color: #c4565f;
}
.confirm-dialog.tone-primary .confirm-dialog-heading-icon {
  background: #edf3ff;
  color: #4d7be4;
}
.confirm-dialog-heading h2 {
  margin: 5px 0 0;
  color: #253650;
  font-size: 20px;
  letter-spacing: -0.04em;
}
.confirm-dialog .eyebrow {
  color: #8492a8;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.confirm-dialog-body {
  display: grid;
  gap: 11px;
}
.confirm-dialog-message {
  margin: 0;
  color: #4a5a72;
  font-size: 13px;
  line-height: 1.72;
}
.confirm-dialog-details {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: #fdf6f6;
  list-style: none;
}
.confirm-dialog.tone-primary .confirm-dialog-details {
  background: #f7f9fd;
}
.confirm-dialog-details li {
  position: relative;
  padding-left: 14px;
  color: #7c6a6d;
  font-size: 11px;
  line-height: 1.6;
}
.confirm-dialog.tone-primary .confirm-dialog-details li {
  color: #6b7a90;
}
.confirm-dialog-details li::before {
  content: "·";
  position: absolute;
  left: 3px;
  color: #c9a2a6;
}
.confirm-dialog.tone-primary .confirm-dialog-details li::before {
  color: #a9b7cb;
}
.confirm-dialog-error {
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
.confirm-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.confirm-dialog-footer .el-button {
  font-size: 11px;
}
</style>
