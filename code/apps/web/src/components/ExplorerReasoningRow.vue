<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**推理行**——最轻的一档，一个可折叠的推理卡。
 *
 * 它是"模型在思考"的背景音，不是内容：所以没有卡片、没有边框，只有一个线程侧标记点。
 * 但它是**可折叠**的——与执行侧同形，也是 OpenClaw / Hermes 的共同取舍：
 * 折起来让正文干净（OpenClaw 干脆把推理从正文与音频里整个剔除），展开时又什么都拿得到
 * （Hermes 的 `Reasoning notes`）。跑着的时候默认展开——那时候它正在说事。
 *
 * 正文由 `explorerActivityLine()` 给出；没有说明时它会退回标签（空行只剩一个点和时间更难读）。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityLine, formatTurnTime } from "../utils/explorerPresentation";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";

const props = defineProps<{ activity: ExplorerActivityItem; index: number }>();
const line = computed(() => explorerActivityLine(props.activity));
</script>

<template>
  <article
    :id="activityTarget(activity, index)"
    :data-nav-key="activityTarget(activity, index)"
    class="timeline-note"
    :class="{ running: activity.status === 'RUNNING' }"
  >
    <span class="thread-mark" :class="{ 'thread-mark-live': activity.status === 'RUNNING' }" />
    <details class="timeline-reasoning" :open="activity.status === 'RUNNING'">
      <summary>推理</summary>
      <p>{{ line.body }}</p>
    </details>
    <time>{{ formatTurnTime(activity.occurredAt) }}</time>
  </article>
</template>
