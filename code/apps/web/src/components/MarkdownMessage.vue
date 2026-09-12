<script setup lang="ts">
/**
 * 模块职责：把模型消息正文按 Markdown 渲染，并在流式输出期间给出节流与等待指示。
 *
 * 维护提示：流式渲染策略或消毒规则变化时，应同步更新 utils/markdown.ts 与相关测试。
 */
import { computed, toRef } from "vue";
import { renderMarkdown } from "../utils/markdown";
import { useThrottledText } from "../utils/throttledText";

const props = withDefaults(defineProps<{ source: string; streaming?: boolean }>(), { streaming: false });

const streaming = computed(() => props.streaming === true);
const displayed = useThrottledText(toRef(props, "source"), streaming);
const html = computed(() => renderMarkdown(displayed.value));
</script>

<template>
  <div class="markdown-body" :aria-live="streaming ? 'polite' : undefined">
    <div class="markdown-content" v-html="html" />
    <span v-if="streaming" class="processing-dots" aria-hidden="true"><i /><i /><i /></span>
  </div>
</template>
