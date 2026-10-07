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
    <!--
      `v-html` 是这一条链唯一允许的注入点，而它注入的不是原始文本：`renderMarkdown` 先过 marked、
      再过 `utils/markdown.ts` 的清洗（去掉 script/style/iframe、事件属性、javascript: 链接，外链强制
      noopener），所以这里渲染的是**我们生成的** HTML。要动它，先看那个文件的维护提示。
    -->
    <!-- eslint-disable-next-line vue/no-v-html -- 见上：内容来自 renderMarkdown 的清洗结果，不是用户原文 -->
    <div class="markdown-content" v-html="html" />
    <span v-if="streaming" class="processing-dots" aria-hidden="true"><i /><i /><i /></span>
  </div>
</template>
