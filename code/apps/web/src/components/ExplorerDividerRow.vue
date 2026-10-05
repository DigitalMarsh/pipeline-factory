<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**分隔行**——会话在这里换了上下文，是边界不是事件。
 *
 * 保留"两条横线夹一个标签"的形状（时间线上唯一一处边界记号），但标签里带着线程侧标记点，
 * 并写明 `Factory · 上下文压缩`——它是 Factory 记的，不是模型说的。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityLine, formatTurnTime } from "../utils/explorerPresentation";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";

const props = defineProps<{ activity: ExplorerActivityItem; index: number }>();
const line = computed(() => explorerActivityLine(props.activity));
</script>

<template>
  <article :id="activityTarget(activity, index)" :data-nav-key="activityTarget(activity, index)" class="timeline-divider">
    <span class="timeline-divider-rule" />
    <span class="timeline-divider-label">
      <span class="thread-mark" />{{ line.label }}<em v-if="line.reference"> · {{ line.reference }}</em>
    </span>
    <time>{{ formatTurnTime(activity.occurredAt) }}</time>
    <span class="timeline-divider-rule" />
  </article>
</template>
