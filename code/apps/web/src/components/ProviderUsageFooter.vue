<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  model: string;
  context: string;
  contextNote?: string;
  /** 这一轮由哪个 agent 执行；缺省或"未记录"时该格显示占位而不是留空。 */
  backend?: string;
  /**
   * 整行末尾的来源说明（如"本次执行记录"/"按本 Run 冻结的配置"）。**只在真的有两种来源时传**：
   * 执行页在"这一轮还没跑完、没有记录"时会改用配置值，不说清来源就等于把配置当事实展示。
   */
  sourceNote?: string;
}>(), {
  contextNote: "",
  backend: "",
  sourceNote: "",
});

/**
 * 用量栏只呈现三件 provider 无关的事实：这一轮是哪个 agent、哪个模型、上下文占了多少。
 *
 * **"哪个 agent"必须与模型名分开显示**：同一个模型名可能来自不同后端（官方 Claude、DeepSeek 兼容
 * 端点、cc-switch 代理映射），只显示 MODEL 时"这一轮到底是谁跑的"在页面上没有答案。这与
 * `agent.loop.started` 里记的端点指纹是同一件事在界面上的投影。
 *
 * **这里曾经还有"5 小时限额 / 7 天限额"两格**，数据来自 `/api/v4/codex/rate-limits`。它被移除是因为
 * 那份数据的唯一来源是 Codex App Server 的账号额度接口，而账号额度是**按账号**而非按会话的，
 * 与本栏"这一轮用了什么"的语义并不相称；Claude 侧根本没有这个接口。要恢复的话，先回答
 * "额度该按谁显示、拿不到时显示什么"，而不是把这两格加回来。
 */
const contextNoteText = computed(() => props.contextNote);
const sourceNoteText = computed(() => props.sourceNote);
</script>

<template>
  <div class="provider-usage-footer" aria-label="模型与上下文信息">
    <span v-if="props.backend" class="provider-usage-fact">
      <small>Agent</small>
      <strong :title="props.backend">{{ props.backend }}</strong>
    </span>
    <span class="provider-usage-fact">
      <small>模型</small>
      <strong :title="props.model">{{ props.model }}</strong>
    </span>
    <span class="provider-usage-fact">
      <small>上下文</small>
      <strong :title="props.context">{{ props.context }}</strong>
      <em v-if="contextNoteText">{{ contextNoteText }}</em>
    </span>
    <span v-if="sourceNoteText" class="provider-usage-source">{{ sourceNoteText }}</span>
  </div>
</template>
