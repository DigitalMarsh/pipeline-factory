<script setup lang="ts">
/**
 * 模块职责：探索时间线里的推理行——薄壳，真正的折叠与脱敏在共享的 `ChatReasoningRow` 里。
 *
 * **没有正文的两种情况**（现在只剩 Provider 这一种是生产路径）：
 *   - Provider 报了这次推理但没给可读正文（Codex 只回 `encrypted_content`）→ 明说「未提供正文」。
 *   - 其它空正文（历史/异常数据）→ 只写「推理」，不编句子。
 *
 * Factory 的 `MODEL_STARTED` 占位行已经在核心投影里删掉，时间线上不会再出现第二条「推理」。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityLine, isProviderControlled } from "../utils/explorerPresentation";
import { formatMessageTime } from "../utils/messageTime";
import ChatReasoningRow from "./ChatReasoningRow.vue";

const props = defineProps<{ activity: ExplorerActivityItem }>();

const line = computed(() => explorerActivityLine(props.activity));
const running = computed(() => props.activity.status === "RUNNING");
const fromProvider = computed(() => isProviderControlled(props.activity));
const time = computed(() => formatMessageTime(props.activity.occurredAt));
</script>

<template>
  <ChatReasoningRow
    :body="line.body"
    :running="running"
    :unreadable-label="fromProvider && !line.body.trim() ? '未提供正文' : null"
    :time="time"
    :datetime="activity.occurredAt"
  />
</template>
