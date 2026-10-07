<script setup lang="ts">
/**
 * 模块职责：执行会话里的**动作行**（`COMMAND` / `FILE_CHANGE` / `TOOL_CALL` / `MCP_CALL` /
 * `SUBAGENT` / `WEB_SEARCH` / `IMAGE_GENERATION` / `TASK_LIFECYCLE` / `GATE` / `TURN_STATUS` /
 * `UNCLASSIFIED` / `RECOVERY` / `RUN_ACTIVITY` / ④ 的运行事实）。
 *
 * 它们的正文都只有一句话（`item.detail`），标题由投影层按中立类别拼好——所以共用这一个行组件，
 * 与探索侧"调用行 / 门禁行 / 轮次行共用 `ExplorerActivityRow`"是同一条道理：
 * **按 DOM 形状分文件，不按消息类型分。**
 *
 * 「显示结果」是 OpenClaw / Hermes 的招牌效果：一条命令跑完，默认只占一行，需要时展开看它到底
 * 输出了什么、参数是什么。**脱敏与截断在这一层之下的 `utils/sensitiveValue.ts`**，
 * 这里只负责开关。
 */
import { computed, ref } from "vue";
import type { ExecutionStreamItem } from "../utils/executionStream";
import { hasActivityPayload } from "../utils/sensitiveValue";
import ActivityResultDetails from "./ActivityResultDetails.vue";

const props = defineProps<{ item: ExecutionStreamItem }>();

const open = ref(false);
const canExpand = computed(() => hasActivityPayload(props.item));
</script>

<template>
  <p class="execution-activity-detail">{{ item.detail }}</p>
  <small v-if="item.unrecordedFields?.length" class="execution-message-note">{{ item.unrecordedFields.join(" · ") }}</small>
  <div v-if="canExpand" class="activity-result-shell">
    <button type="button" class="activity-result-toggle" :aria-expanded="open" @click="open = !open">
      {{ open ? "收起结果" : "显示结果" }}
    </button>
    <ActivityResultDetails
      v-if="open"
      :arguments="item.arguments"
      :result="item.result"
      :output="item.output"
      :exit-code="item.exitCode"
      :duration-ms="item.durationMs"
    />
  </div>
</template>
