<!--
  模块职责：探索对话底部的输入区 —— 文本、图片附件、发送按钮与"为什么现在不能发"的状态文案。
  从 ExplorerView（2100+ 行）里抽出来：这一块只依赖输入状态，与看板/需求清单/抽屉切换无关。

  维护提示：
  1) 发送按钮的禁用条件与视图里的 `sendTurn` 守卫是**同一组业务前提**（归档、暂停、正在跑、发送中）。
     视图侧仍然保留守卫——按钮禁用只是体验，不能替代真正执行前的判断。
  2) `⌘/Ctrl+Enter` 只在这里拦截并 emit；是否真的能发仍由视图的 `canSend` 判据决定。
  3) 「停止」与「发送」共用同一个按钮位：`stoppable` 由视图按"当前需求有没有可取消的回合"给出，
     点击只 emit `stop`；取消请求、停止后的本地状态与聚焦全归视图。
-->
<script setup lang="ts">
import { ArrowUp } from "@element-plus/icons-vue";
import AttachmentComposer from "./AttachmentComposer.vue";
import ProviderUsageFooter from "./ProviderUsageFooter.vue";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import type { PendingImageAttachment } from "../composables/useImageAttachments";

const props = defineProps<{
  modelValue: string;
  /** 线程/项目已归档或尚未加载。 */
  disabled: boolean;
  paused: boolean;
  busy: boolean;
  activePlanBusy: boolean;
  activePlanWaitingForInput: boolean;
  /** 当前需求有一个可以停止的助手回合：发送按钮换成「停止」。 */
  stoppable: boolean;
  /** 停止请求在途。 */
  stopping: boolean;
  sending: boolean;
  pendingInput: boolean;
  inputAnswerInFlight: string | null;
  inputSubmitting: boolean;
  attachmentItems: PendingImageAttachment[];
  attachmentError: string | null;
  model: string;
  backend: string;
  context: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  send: [];
  stop: [];
  add: [files: File[]];
  remove: [key: string];
}>();

const sendDisabled = () =>
  props.disabled || !props.modelValue.trim() || props.paused || props.activePlanBusy || props.sending || props.busy;

function onKeydown(event: KeyboardEvent): void {
  if (!shouldSubmitComposer(event)) return;
  event.preventDefault();
  if (!sendDisabled()) emit("send");
}
</script>

<template>
  <div class="composer">
    <AttachmentComposer
      :items="attachmentItems"
      :error="attachmentError"
      :disabled="disabled || paused || busy"
      @add="emit('add', $event)"
      @remove="emit('remove', $event)"
    >
      <div class="composer-input">
        <textarea
          :value="modelValue"
          :disabled="disabled || paused"
          aria-label="探索消息"
          placeholder="继续探索，或提出修改…"
          @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
          @keydown="onKeydown"
        /><span class="composer-mode">Plan 模式</span>
      </div>
    </AttachmentComposer>
    <div class="composer-footer">
      <ProviderUsageFooter :model="model" :backend="backend" :context="context" context-note="估算" />
      <span v-if="inputAnswerInFlight || inputSubmitting" class="composer-status" role="status" aria-live="polite"
        >正在提交结构化答案，确认后本轮会继续…</span
      ><span v-else-if="pendingInput" class="composer-status" role="status" aria-live="polite">请先回答上方结构化问题，再继续探索。</span
      ><span v-else-if="sending" class="composer-status" role="status" aria-live="polite">消息已发送 · 等待 Plan Explorer…</span
      ><span v-else-if="activePlanBusy" class="composer-status" role="status" aria-live="polite"
        >Plan Explorer 正在探索，可随时停止并补充消息。</span
      ><el-button
        v-if="stoppable"
        class="composer-stop"
        type="primary"
        plain
        circle
        :loading="stopping"
        aria-label="停止本轮探索"
        title="停止本轮探索"
        @click="emit('stop')"
        ><span v-if="!stopping" class="composer-stop-icon" aria-hidden="true"
      /></el-button>
      <el-button
        v-else
        class="composer-send"
        type="primary"
        circle
        :loading="(activePlanBusy && !activePlanWaitingForInput) || sending"
        :disabled="sendDisabled()"
        aria-label="发送消息"
        :title="pendingInput ? '请先回答上方结构化问题' : activePlanBusy ? '当前需求回合执行中，完成后可继续' : '发送消息'"
        @click="emit('send')"
        ><ArrowUp :size="18"
      /></el-button>
    </div>
  </div>
</template>
