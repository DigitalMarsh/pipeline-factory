<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**分隔行**——一轮跑完、Factory 让接着做下一项，这里是那道边界。
 *
 * 保留"两条横线夹一个标签"的形状（时间线上唯一一处边界记号），但标签里带着线程侧标记点，
 * 并写明 `Factory · 续跑检查点`——它是 Factory 记的，不是模型说的。
 *
 * **它不表示上下文被压缩了**（曾长期这么标）：这条步骤只把这一轮正文与续跑提示推进 `messages`
 * 并落一个 checkpoint，什么都没删。真被压缩只有 Provider 自己压那一种，在头部诊断区里。
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
