<script setup lang="ts">
/**
 * 模块职责：执行会话里的**推理行** —— 有正文时是一个可折叠的推理卡。
 *
 * 为什么是 `<details>` 而不是一行：推理是**背景音**，不是内容。OpenClaw 干脆把它从正文与音频里
 * 整个剔除；Hermes 用一个默认折叠的 `Reasoning notes` 容器装它，流式时才自动展开。
 * 折起来让正文干净，展开时又什么都拿得到——这是两者的共同取舍。
 *
 * **没有正文时分两种情况，而且必须分开**：
 *   - Provider 报了这次推理但没给可读正文（Codex 只回 `encrypted_content`；实测本机 140/140 条
 *     都是这个形状）→ 明说「未提供正文」。否则那一行就是一个光秃秃的「推理」，
 *     看着像这一轮根本没推理过——用户没法知道是"没有"还是"读不到"。
 *   - Factory 自己的轮次标记 → 留空，不编句子。
 *
 * 两种情况都**不摆折叠**：一个点开只有空白的展开区比没有更糟。
 */
import { computed } from "vue";
import type { ExecutionStreamItem } from "../utils/executionStream";
// 正文过一遍展示边界的脱敏（与工具结果同一个口）：模型可能把它读到的令牌、邮箱原样复述出来。
import { presentableText } from "../utils/sensitiveValue";

const props = defineProps<{ item: ExecutionStreamItem }>();

/** 跑着的时候自动展开——那时候它正在说事；跑完就收起来，把视线还给正文。 */
const streaming = computed(() => props.item.status === "RUNNING");
const hasBody = computed(() => Boolean(props.item.content.trim()));
const body = computed(() => presentableText(props.item.content));
/** `activityKind` 是 Provider 活动的标志；Factory 自己的推理类条目没有它。 */
const fromProvider = computed(() => props.item.activityKind === "reasoning");
</script>

<template>
  <details v-if="hasBody" class="execution-reasoning" :open="streaming">
    <summary>推理{{ item.modelStep === undefined ? "" : ` · 第 ${item.modelStep} 轮` }}</summary>
    <p class="execution-reasoning-body">{{ body }}</p>
  </details>
  <p v-else-if="fromProvider" class="execution-reasoning-unreadable">Provider 未提供可读的推理正文。</p>
</template>
