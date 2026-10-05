<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**调用行 / 门禁行 / 轮次行**——三种行型共用一个组件。
 *
 * 为什么合成一个：这三者的 DOM **逐字相同**（线程侧标记点 + 标签 + 名字 + 时间 + 状态标签 + 正文 + 引用），
 * 差别**全在 CSS 类上**（`activity-tool` 给名字加等宽底色、`activity-gate` 加一道竖线、
 * `activity-turn-status` 换成虚线框）。按行型写三份同构模板，与按消息类型写四份同构模板是同一个错误。
 *
 * 「摆哪些字段」不在这里：`explorerActivityLine()` 把活动条目算成 `{label, name, reference, body}`，
 * 本组件只负责摆位置。
 */
import { computed } from "vue";
import type { ExplorerActivityItem } from "../types";
import { activityStatusLabel, explorerActivityLine, formatTurnTime } from "../utils/explorerPresentation";
import { explorerTimelineTarget as activityTarget } from "../utils/explorerTimeline";
import { statusTagType } from "../utils/statusTag";

const props = defineProps<{
  activity: ExplorerActivityItem;
  index: number;
  /** 行型：只决定套哪个 CSS 类，不决定结构。 */
  mode: "line" | "gate" | "turn-status";
}>();

const line = computed(() => explorerActivityLine(props.activity));
</script>

<template>
  <article
    :id="activityTarget(activity, index)"
    :data-nav-key="activityTarget(activity, index)"
    :class="['loop-activity-card', `activity-${mode}`, { waiting: activity.status === 'WAITING', failed: activity.status === 'FAILED', running: activity.status === 'RUNNING' }]"
  >
    <span class="thread-mark" />
    <div class="loop-activity-copy">
      <div class="loop-activity-meta">
        <strong>{{ line.label }}</strong>
        <code v-if="line.name">{{ line.name }}</code>
        <span>{{ formatTurnTime(activity.occurredAt) }}</span>
        <el-tag size="small" effect="light" :type="statusTagType(activity.status)">{{ activityStatusLabel(activity) }}</el-tag>
      </div>
      <p v-if="line.body">{{ line.body }}</p>
      <code v-if="line.reference" class="activity-reference">{{ line.reference }}</code>
    </div>
  </article>
</template>
