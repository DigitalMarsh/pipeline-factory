<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**推理行**——最轻的一档，一行灰字。
 *
 * 它是"模型在思考"的背景音，不是内容：所以没有边框、没有卡片，只有一个线程侧标记点 + 正文 + 时间。
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
    <p>{{ line.body }}</p>
    <time>{{ formatTurnTime(activity.occurredAt) }}</time>
  </article>
</template>
