<script setup lang="ts">
/**
 * 模块职责：执行会话里的**推理行**——薄壳，折叠与脱敏在共享的 `ChatReasoningRow` 里。
 *
 * 只有 Provider 真正报过推理才会走到这里；Factory 的轮次开始不再单独成行。
 * Provider 报了推理却没给可读正文时明说「未提供正文」，不摆一个点开是空白的折叠区。
 */
import { computed } from "vue";
import type { ExecutionStreamItem } from "../utils/executionStream";
import { formatMessageTime } from "../utils/messageTime";
import ChatReasoningRow from "./ChatReasoningRow.vue";

const props = defineProps<{ item: ExecutionStreamItem }>();

const running = computed(() => props.item.status === "RUNNING");
const fromProvider = computed(() => props.item.activityKind === "reasoning");
const meta = computed(() => (props.item.modelStep === undefined ? null : `第 ${props.item.modelStep} 轮`));
const time = computed(() => formatMessageTime(props.item.occurredAt));
</script>

<template>
  <ChatReasoningRow
    :body="item.content"
    :running="running"
    :meta="meta"
    :unreadable-label="fromProvider && !item.content.trim() ? '未提供正文' : null"
    :time="time"
    :datetime="item.occurredAt"
  />
</template>
