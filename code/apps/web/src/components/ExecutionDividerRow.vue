<script setup lang="ts">
/**
 * 模块职责：执行会话里的**分隔行** —— 一轮跑完、Factory 让接着做下一项，这里是那道边界。
 *
 * 为什么是分隔线而不是一行活动：**边界不是一次事件**。它上面与下面的对话看着是连续的，
 * 实际中间夹着 Factory 的一句"接着做下一项"——把这件事画成又一条活动行，读的人不会意识到分界在哪。
 * OpenClaw 的处理同名同形（*Compaction entries render as a history divider*），
 * 探索侧的那条 `CONTEXT` 也早就是这个形状。
 *
 * 标的是「Factory · 续跑检查点」。**别把它当成上下文压缩**——那条步骤只写了 checkpoint，
 * 一个字节都没压（Provider 侧真压了的话是 ④ 的 `PROVIDER_COMPACTION`，进的是 Run 头诊断区，不是这里）。
 */
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <div class="timeline-divider execution-divider">
    <span class="timeline-divider-rule" />
    <span class="timeline-divider-label"
      ><span class="thread-mark" />Factory · 续跑检查点<em v-if="item.detail">{{ item.detail }}</em></span
    >
    <time>{{ new Date(item.occurredAt).toLocaleTimeString("zh-CN") }}</time>
    <span class="timeline-divider-rule" />
  </div>
</template>
