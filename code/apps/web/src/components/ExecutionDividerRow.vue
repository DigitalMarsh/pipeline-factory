<script setup lang="ts">
/**
 * 模块职责：执行会话里的**分隔行** —— 一轮跑完、Factory 让接着做下一项，这里是那道边界。
 *
 * 为什么是分隔线而不是一行活动：**边界不是一次事件**。它上面与下面的对话看着是连续的，
 * 实际中间夹着 Factory 的一句"接着做下一项"——把这件事画成又一条活动行，读的人不会意识到分界在哪。
 * 与探索侧同一套 `.chat-divider` 形状；行首不再放线程标记点。
 *
 * 标的是「Factory · 续跑检查点」。**别把它当成上下文压缩**——那条步骤只写了 checkpoint，
 * 一个字节都没压（Provider 侧真压了的话是 ④ 的 `PROVIDER_COMPACTION`，进的是 Run 头诊断区，不是这里）。
 */
import type { ExecutionStreamItem } from "../utils/executionStream";
import { formatMessageTime, messageTimeTitle } from "../utils/messageTime";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <div class="chat-divider execution-divider">
    <span class="chat-divider-rule" />
    <span class="chat-divider-label"
      >Factory · 续跑检查点<em v-if="item.detail"> · {{ item.detail }}</em></span
    >
    <time :datetime="item.occurredAt" :title="messageTimeTitle(item.occurredAt)">{{ formatMessageTime(item.occurredAt) }}</time>
    <span class="chat-divider-rule" />
  </div>
</template>
