<script setup lang="ts">
/**
 * 模块职责：执行会话里的**推理行** —— 一个可折叠的推理卡。
 *
 * 为什么是 `<details>` 而不是一行：推理是**背景音**，不是内容。OpenClaw 干脆把它从正文与音频里
 * 整个剔除；Hermes 用一个默认折叠的 `Reasoning notes` 容器装它，流式时才自动展开。
 * 折起来让正文干净，展开时又什么都拿得到——这是两者的共同取舍。
 *
 * 它同时修掉一个真实缺口：Claude 的 `thinking` 块**此前整块没读**（全仓 `grep thinking` 0 命中），
 * 所以换个 Agent 推理就整片消失。现在两个 Provider 的推理都走这条行。
 */
import { computed } from "vue";
import type { ExecutionStreamItem } from "../utils/executionStream";

const props = defineProps<{ item: ExecutionStreamItem }>();

/** 跑着的时候自动展开——那时候它正在说事；跑完就收起来，把视线还给正文。 */
const streaming = computed(() => props.item.status === "RUNNING");
</script>

<template>
  <details class="execution-reasoning" :open="streaming">
    <summary>推理{{ item.modelStep === undefined ? "" : ` · 第 ${item.modelStep} 轮` }}</summary>
    <p class="execution-reasoning-body">{{ item.content }}</p>
  </details>
</template>
