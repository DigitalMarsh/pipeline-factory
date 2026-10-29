<script setup lang="ts">
/**
 * 模块职责：探索时间线里的**调用行 / 门禁行 / 轮次行**——三种行型共用一个组件。
 *
 * 这三者的内容结构相同（正文 + 引用 + 可展开的结果），差别全在 CSS 类上
 * （`activity-line` 给名字加等宽底色、`activity-gate` 加一道竖线、`activity-turn-status` 换成虚线框）。
 * 行的头像、meta（标签/名字/时间/状态）与锚点由 `ExplorerMessageRow` + `ChatMessageShell` 负责；
 * 本组件只摆内容，「摆哪些字段」由 `explorerActivityLine()` 决定。
 */
import { computed, ref } from "vue";
import type { ExplorerActivityItem } from "../types";
import { explorerActivityResult, type ExplorerActivityLine } from "../utils/explorerPresentation";
import { hasActivityPayload } from "../utils/sensitiveValue";
import ActivityResultDetails from "./ActivityResultDetails.vue";

const props = defineProps<{
  activity: ExplorerActivityItem;
  /** 行型：只决定套哪个 CSS 类，不决定结构。 */
  mode: "line" | "gate" | "turn-status";
  /** 公共的"摆哪几个字段"投影；由外层算好传进来，避免和壳各算一遍。 */
  line: ExplorerActivityLine;
}>();

const payload = computed(() => explorerActivityResult(props.activity));
const canExpand = computed(() => hasActivityPayload(payload.value));
const expanded = ref(false);
</script>

<template>
  <div
    :class="[
      'chat-activity-card',
      `activity-${mode}`,
      { waiting: activity.status === 'WAITING', failed: activity.status === 'FAILED', running: activity.status === 'RUNNING' },
    ]"
  >
    <p v-if="line.body" class="chat-activity-detail">{{ line.body }}</p>
    <code v-if="line.reference" class="activity-reference">{{ line.reference }}</code>
    <!-- 「显示结果」是两条对话线共用的效果：默认只占一行，需要时展开看这一调用到底做了什么。 -->
    <div v-if="canExpand" class="activity-result-shell">
      <button type="button" class="activity-result-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? "收起结果" : "显示结果" }}
      </button>
      <ActivityResultDetails v-if="expanded" v-bind="payload" />
    </div>
  </div>
</template>
