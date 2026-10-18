<!--
  模块职责：对话输入框里的**图片附件条** —— 与 Codex / Claude desktop 一致：截图后直接粘贴进输入框，
  图片以缩略图显示在输入框**上方**，可点击看原图、可逐张删除。三处输入框
  （探索、Run 补充要求、项目执行）共用它；状态由 `useImageAttachments` 提供。

  维护提示：
  1) **不提供"选择文件"按钮**：这条交互是给人贴截图的，多一个上传入口只会让主路径变重。
     仍保留拖拽作为补充（桌面上拖一张图进来同样自然）。
  2) 粘贴只在**真的带图片文件**时 `preventDefault`；否则会把用户粘文字的行为也拦掉。
  3) 缩略图用本地 object URL（发送前），消息里已保存的附件用服务端 url（`MessageAttachment.url`）——
     两者不要混：前者随组件销毁 revoke，后者是持久资源。
  4) 上限文案与 `useImageAttachments` 的常量同源（props.maxFiles / maxBytesLabel），不要在模板里写死数字。
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { Close } from "@element-plus/icons-vue";
import type { PendingImageAttachment } from "../composables/useImageAttachments";

const props = withDefaults(
  defineProps<{
    items: PendingImageAttachment[];
    error?: string | null;
    disabled?: boolean;
  }>(),
  { error: null, disabled: false },
);

const emit = defineEmits<{
  (event: "add", files: File[]): void;
  (event: "remove", key: string): void;
}>();

const dragging = ref(false);
const previewUrls = computed(() => props.items.map((item) => item.previewUrl));

function imageFilesFrom(list: FileList | null | undefined): File[] {
  return list ? [...list].filter((file) => file.type.startsWith("image/")) : [];
}

function onPaste(event: ClipboardEvent): void {
  if (props.disabled) return;
  const files = imageFilesFrom(event.clipboardData?.files);
  if (files.length === 0) return;
  event.preventDefault();
  emit("add", files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (props.disabled) return;
  const files = imageFilesFrom(event.dataTransfer?.files);
  if (files.length > 0) emit("add", files);
}
</script>

<template>
  <div
    class="attachment-composer"
    :class="{ dragging }"
    data-attachment-composer
    @paste="onPaste"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- 缩略图在输入框**上方**：贴完截图先看到图，再写那句话。 -->
    <div v-if="items.length > 0" class="attachment-strip">
      <div v-for="(item, index) in items" :key="item.key" class="attachment-thumb" :data-attachment-key="item.key">
        <el-image
          class="thumb-image"
          :src="item.previewUrl"
          :alt="item.fileName"
          :preview-src-list="previewUrls"
          :initial-index="index"
          preview-teleported
          fit="cover"
        />
        <button type="button" class="thumb-remove" :disabled="disabled" title="移除这张图片" @click="emit('remove', item.key)">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>
    <slot />
    <p v-if="error" class="attachment-error" data-attachment-error>{{ error }}</p>
  </div>
</template>

<style scoped>
.attachment-composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.attachment-composer.dragging {
  outline: 1px dashed var(--el-color-primary);
  outline-offset: 2px;
  border-radius: 6px;
}
.attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.attachment-thumb {
  position: relative;
  width: 70px;
  height: 70px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  overflow: hidden;
  background: var(--el-fill-color-light);
}
.thumb-image {
  width: 100%;
  height: 100%;
  display: block;
  cursor: zoom-in;
}
.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  cursor: pointer;
  font-size: 10px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.attachment-thumb:hover .thumb-remove,
.thumb-remove:focus-visible {
  opacity: 1;
}
.thumb-remove:hover:not(:disabled) {
  background: rgb(0 0 0 / 75%);
}
.thumb-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.attachment-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-error {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
