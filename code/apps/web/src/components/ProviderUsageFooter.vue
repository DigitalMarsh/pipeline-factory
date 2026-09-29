<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  model: string;
  context: string;
  contextNote?: string;
}>(), {
  contextNote: "",
});

/**
 * 用量栏只呈现两件 provider 无关的事实：这一轮用的是哪个模型、上下文占了多少。
 *
 * **这里曾经还有"5 小时限额 / 7 天限额"两格**，数据来自 `/api/v4/codex/rate-limits`。它被移除是因为
 * 那份数据的唯一来源是 Codex App Server 的账号额度接口，而账号额度是**按账号**而非按会话的，
 * 与本栏"这一轮用了什么"的语义并不相称；Claude 侧根本没有这个接口。要恢复的话，先回答
 * "额度该按谁显示、拿不到时显示什么"，而不是把这两格加回来。
 */
const contextNoteText = computed(() => props.contextNote);
</script>

<template>
  <div class="provider-usage-footer" aria-label="模型与上下文信息">
    <span class="provider-usage-fact">
      <small>MODEL</small>
      <strong :title="props.model">{{ props.model }}</strong>
    </span>
    <span class="provider-usage-fact">
      <small>CONTEXT</small>
      <strong :title="props.context">{{ props.context }}</strong>
      <em v-if="contextNoteText">{{ contextNoteText }}</em>
    </span>
  </div>
</template>
