<script setup lang="ts">
/**
 * 模块职责：执行会话里 **Executor 的正文与报告**（`ASSISTANT_MESSAGE` / `MODEL_REPORT`）。
 *
 * 两者的差别只在标题上（`executionStream.humanizeModelOutput` 决定），正文都是 markdown，
 * 所以它们共用这一个行组件——和探索侧"命令 / 文件变更 / 工具调用 / MCP 调用共用一条调用行"是同一条道理。
 */
import MarkdownMessage from "./MarkdownMessage.vue";
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <MarkdownMessage :source="item.content" :streaming="item.status === 'RUNNING'" />
  <small v-if="item.detail || item.unrecordedFields?.length" class="execution-message-note">{{ item.detail || item.unrecordedFields?.join(' · ') }}</small>
</template>
