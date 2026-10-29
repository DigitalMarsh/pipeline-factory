<script setup lang="ts">
/**
 * 模块职责：执行会话里**你自己说的话**（`USER_MESSAGE`）——内容在共享壳的气泡里，这里只摆正文。
 *
 * 与探索侧同形：两条线里"我发的"就该长得一样（见 docs/消息类型及事件状态机流程图.md §2.1）。
 * 头像「你」、气泡、时间都由 `ChatMessageShell` 负责。
 */
import MarkdownMessage from "./MarkdownMessage.vue";
import MessageAttachments from "./MessageAttachments.vue";
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <MarkdownMessage :source="item.content" />
  <MessageAttachments :attachments="item.attachments" />
  <small v-if="item.detail || item.unrecordedFields?.length" class="chat-message-note">{{
    item.detail || item.unrecordedFields?.join(" · ")
  }}</small>
</template>
