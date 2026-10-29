<!--
  模块职责：聊天区唯一的推理块——有正文时可折叠，没有正文时只留一行说明。
  探索线程与执行线程共用，避免同一件事在两处长成两种样子。

  维护提示：
  1. **不要为 Factory 的 MODEL_STARTED 标记留分支**：那条占位推理已经在核心投影里删除
     （packages/core/src/explorer/explorer-activity.ts），时间线上只剩 Provider 真正报过的推理。
  2. **没有正文要分两种情况**：Provider 报了这次推理但没给可读正文 → `unreadableLabel`（如「未提供正文」）；
     其它空正文 → 只显示「推理」，不编句子、也不摆一个点开是空白的折叠区。
  3. 正文必须过 `presentableText`——模型可能把读到的令牌、邮箱原样复述出来。
  4. 运行中默认展开、结束后收起；用原生 `<details>`，键盘与 aria 语义由浏览器负责。
-->
<script setup lang="ts">
import { computed } from "vue";
import { presentableText } from "../utils/sensitiveValue";

const props = withDefaults(
  defineProps<{
    /** Provider 返回的推理原文。 */
    body: string;
    /** 这一轮还在跑：默认展开。 */
    running: boolean;
    /** 行内附注，如「第 2 轮」。 */
    meta?: string | null;
    /** 没有可读正文时的说明，如「未提供正文」；为 null 表示不说这句话。 */
    unreadableLabel?: string | null;
    label?: string;
    /** 已格式化的 HH:MM；放在推理标题行末尾，避免外壳再单独渲染一行只有时间的 meta。 */
    time?: string | null;
    datetime?: string | null;
  }>(),
  { meta: null, unreadableLabel: null, label: "推理", time: null, datetime: null },
);

const hasBody = computed(() => Boolean(props.body.trim()));
const text = computed(() => presentableText(props.body));
</script>

<template>
  <details v-if="hasBody" class="chat-reasoning" :open="running">
    <summary class="chat-reasoning-summary">
      <span class="chat-reasoning-label"
        >{{ label }}<template v-if="meta"> · {{ meta }}</template></span
      >
      <time v-if="time" class="chat-time" :datetime="datetime ?? undefined" :title="datetime ?? undefined">{{ time }}</time>
    </summary>
    <div class="chat-reasoning-body">{{ text }}</div>
  </details>
  <p v-else class="chat-reasoning-inline">
    <span class="chat-reasoning-label"
      >{{ label }}<span v-if="unreadableLabel" class="chat-reasoning-unreadable"> · {{ unreadableLabel }}</span></span
    >
    <time v-if="time" class="chat-time" :datetime="datetime ?? undefined" :title="datetime ?? undefined">{{ time }}</time>
  </p>
</template>
