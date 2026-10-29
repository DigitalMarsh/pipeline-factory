<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**分隔行**——一轮跑完、Factory 让接着做下一项，这里是那道边界。
 *
 * 保留"两条横线夹一个标签"的形状（时间线上唯一一处边界记号），标签写明
 * `Factory · 续跑检查点`——它是 Factory 记的，不是模型说的。行首不再放线程标记点：
 * 头像/标记只属于"谁在说"，边界用横线表达。
 *
 * **它不表示上下文被压缩了**（曾长期这么标）：这条步骤只把这一轮正文与续跑提示推进 `messages`
 * 并落一个 checkpoint，什么都没删。真被压缩只有 Provider 自己压那一种，在头部诊断区里。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityLine } from "../utils/explorerPresentation";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";
import { formatMessageTime, messageTimeTitle } from "../utils/messageTime";

const props = defineProps<{ activity: ExplorerActivityItem; index: number }>();
const line = computed(() => explorerActivityLine(props.activity));
</script>

<template>
  <article :id="activityTarget(activity, index)" :data-nav-key="activityTarget(activity, index)" class="chat-divider">
    <span class="chat-divider-rule" />
    <span class="chat-divider-label"
      >{{ line.label }}<em v-if="line.reference"> · {{ line.reference }}</em></span
    >
    <time :datetime="activity.occurredAt" :title="messageTimeTitle(activity.occurredAt)">{{ formatMessageTime(activity.occurredAt) }}</time>
    <span class="chat-divider-rule" />
  </article>
</template>
