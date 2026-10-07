<script setup lang="ts">
/**
 * 模块职责：执行会话里的**分隔行** —— 上下文在这里换了。
 *
 * 为什么是分隔线而不是一行活动：压缩**不是一次事件，是一条边界**。它上面与下面的对话看着是连续的，
 * 实际上下文已经重来过一轮——把这件事画成又一条活动行，读的人不会意识到分界在哪。
 * OpenClaw 的处理同名同形（*Compaction entries render as a history divider*），
 * 探索侧的那条 `CONTEXT` 也早就是这个形状。
 *
 * 标的是「Factory · 上下文压缩」：这是 **Factory 自己**压的（Provider 侧另压一次，那是 ④，
 * 进的是 Run 头诊断区，不是这里）。
 */
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <div class="timeline-divider execution-divider">
    <span class="timeline-divider-rule" />
    <span class="timeline-divider-label"
      ><span class="thread-mark" />Factory · 上下文压缩<em v-if="item.detail">{{ item.detail }}</em></span
    >
    <time>{{ new Date(item.occurredAt).toLocaleTimeString("zh-CN") }}</time>
    <span class="timeline-divider-rule" />
  </div>
</template>
