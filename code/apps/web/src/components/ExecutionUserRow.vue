<script setup lang="ts">
/**
 * 模块职责：执行会话里**你自己说的话**（`USER_MESSAGE`）——Codex 那种「`›` + 纯文本」，不套卡片、不带头像。
 *
 * 与探索侧同形：两条线里"我发的"就该长得一样（见 docs/消息类型及事件状态机流程图.md §2.1）。
 */
import MarkdownMessage from "./MarkdownMessage.vue";
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <div class="execution-user-text">
    <span class="execution-user-mark" aria-hidden="true">›</span><MarkdownMessage :source="item.content" />
  </div>
  <small v-if="item.detail || item.unrecordedFields?.length" class="execution-message-note">{{
    item.detail || item.unrecordedFields?.join(" · ")
  }}</small>
</template>
