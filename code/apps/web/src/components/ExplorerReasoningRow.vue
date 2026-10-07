<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**推理行**——最轻的一档，有正文时是一个可折叠的推理卡。
 *
 * 它是"模型在思考"的背景音，不是内容：所以没有卡片、没有边框，只有一个线程侧标记点。
 * 有正文时**可折叠**——与执行侧同形，也是 OpenClaw / Hermes 的共同取舍：折起来让正文干净，
 * 展开时又什么都拿得到（Hermes 的 `Reasoning notes`）。跑着的时候默认展开。
 *
 * **没有正文时分两种情况，而且必须分开**（见 `isProviderControlled`）：
 *   - Provider 报了这次推理但没给可读正文（Codex 只回 `encrypted_content`）→ 明说「未提供正文」。
 *     否则那一行就是一个光秃秃的「推理」，看着像这一轮根本没推理过——用户没法知道是"没有"还是"读不到"。
 *   - Factory 自己的 `MODEL_STARTED` 标记（"这一轮跑起来了"）→ 留空，不编句子。
 *
 * 两种情况都**不摆折叠**：一个点开只有空白的展开区比没有更糟。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityLine, formatTurnTime, isProviderControlled } from "../utils/explorerPresentation";
// 正文过一遍展示边界的脱敏（与工具结果同一个口）：模型可能把它读到的令牌、邮箱原样复述出来。
import { presentableText } from "../utils/sensitiveValue";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";

const props = defineProps<{ activity: ExplorerActivityItem; index: number }>();
const line = computed(() => explorerActivityLine(props.activity));
const hasBody = computed(() => Boolean(line.value.body.trim()));
const body = computed(() => presentableText(line.value.body));
const running = computed(() => props.activity.status === "RUNNING");
const unreadable = computed(() => !hasBody.value && isProviderControlled(props.activity));
</script>

<template>
  <article
    :id="activityTarget(activity, index)"
    :data-nav-key="activityTarget(activity, index)"
    class="timeline-note"
    :class="{ running }"
  >
    <span class="thread-mark" :class="{ 'thread-mark-live': running }" />
    <details v-if="hasBody" class="timeline-reasoning" :open="running">
      <summary>推理</summary>
      <p>{{ body }}</p>
    </details>
    <p v-else class="timeline-reasoning-plain">
      推理<span v-if="unreadable" class="timeline-reasoning-unreadable"> · 未提供正文</span>
    </p>
    <time>{{ formatTurnTime(activity.occurredAt) }}</time>
  </article>
</template>
