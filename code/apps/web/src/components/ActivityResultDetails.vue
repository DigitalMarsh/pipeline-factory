<script setup lang="ts">
/**
 * 模块职责：动作行的**「结果」展开区** —— 两个对话框共用一个。
 *
 * 为什么要它：OpenClaw 与 Hermes 的招牌效果之一就是"动作行可以展开看结果"，此前这一侧
 * 连原料都没有（工具的 arguments / result / 输出 / 退出码一个都没进 journal）。
 * 现在有了，但"展开什么、怎么排版、怎么脱敏"必须只有一处实现——两条对话线里同一次调用
 * 展开出两个样子，是这轮要修的那类不一致。
 *
 * 三条规矩：
 *   1) **脱敏与截断在 `utils/sensitiveValue.ts` 一处**（2000 字 + 敏感值），这里只排版。
 *   2) 取不到的键**不摆那一格**——`undefined` 是"Provider 没给"，空串是"Provider 说这里什么都没有"。
 *   3) 一格都没有时，整个"结果"按钮就不该出现（由调用方按 `hasResultDetails` 判断）。
 */
import { computed } from "vue";
import { presentableValue } from "../utils/sensitiveValue";
import { formatDuration } from "../utils/duration";

const props = defineProps<{
  arguments?: unknown;
  result?: unknown;
  output?: string | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
}>();

const sections = computed(() =>
  [
    { key: "arguments", label: "参数", body: presentableValue(props.arguments) },
    { key: "result", label: "结果", body: presentableValue(props.result) },
    { key: "output", label: "输出", body: presentableValue(props.output) },
  ].filter((section): section is { key: string; label: string; body: string } => Boolean(section.body)),
);

/** 退出码与耗时是**一句话能说完的事实**，不占一整块。 */
const meta = computed(() =>
  [
    props.exitCode === undefined ? null : `退出码 ${props.exitCode}`,
    props.durationMs === undefined ? null : `耗时 ${formatDuration(props.durationMs)}`,
  ].filter((line): line is string => Boolean(line)).join(" · "),
);
</script>

<template>
  <div class="activity-result">
    <span v-if="meta" class="activity-result-meta">{{ meta }}</span>
    <div v-for="section in sections" :key="section.key" class="activity-result-section">
      <span class="activity-result-label">{{ section.label }}</span>
      <pre class="activity-result-body">{{ section.body }}</pre>
    </div>
  </div>
</template>
