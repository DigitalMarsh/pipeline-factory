<!--
  模块职责：已保存消息上的**图片缩略图**——固定小尺寸显示，点击用 Element Plus 的图片预览看原图。
  探索 / Run 执行 / 项目执行三处消息行共用。

  维护提示：
  1) 缩略图与原图共用同一个 `attachment.url`（服务端按记录返回图片本身），不要在列表里另开一份缩略图，
     也不要在渲染时把 base64 塞进 DOM。
  2) `preview-teleported` 必须保留：消息行在滚动容器里，不 teleport 的遮罩会被裁掉。
-->
<script setup lang="ts">
import type { MessageAttachment } from "../types";

const props = withDefaults(defineProps<{ attachments?: MessageAttachment[] | undefined }>(), { attachments: undefined });

function previewUrls(): string[] {
  return (props.attachments ?? []).map((attachment) => attachment.url);
}
</script>

<template>
  <div v-if="attachments && attachments.length > 0" class="message-attachments" data-message-attachments>
    <el-image
      v-for="(attachment, index) in attachments"
      :key="attachment.id"
      class="message-attachment"
      :src="attachment.url"
      :alt="attachment.fileName"
      :preview-src-list="previewUrls()"
      :initial-index="index"
      preview-teleported
      fit="cover"
      :data-attachment-id="attachment.id"
    />
  </div>
</template>

<style scoped>
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.message-attachment {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color-light);
  cursor: zoom-in;
}
</style>
