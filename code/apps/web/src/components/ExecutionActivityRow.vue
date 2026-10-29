<script setup lang="ts">
/**
 * 模块职责：执行会话里的**动作行**（命令 / 文件变更 / 工具 / MCP / 子代理 / 搜索 / 生图 /
 * 任务生命周期 / 门禁 / 轮次状态 / 未识别 / 恢复 / Run 活动 / Provider 运行事实）。
 *
 * 它们的正文都只有一句话（`item.detail`），标题由投影层按中立类别拼好——所以共用这一个行组件，
 * 与探索侧"调用行 / 门禁行 / 轮次行共用 `ExplorerActivityRow`"是同一条道理：
 * **按 DOM 形状分文件，不按消息类型分。**
 *
 * 行的头像 / meta / 锚点归 `ExecutionMessageRow` + `ChatMessageShell`；这里只摆内容与「显示结果」。
 * 脱敏与截断在 `utils/sensitiveValue.ts`，这里只负责开关。
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
  <div
    class="chat-activity-card"
    :class="{ waiting: item.status === 'WAITING', failed: item.status === 'FAILED', running: item.status === 'RUNNING' }"
  >
    <p class="chat-activity-detail">{{ item.detail }}</p>
    <small v-if="item.unrecordedFields?.length" class="chat-message-note">{{ item.unrecordedFields.join(" · ") }}</small>
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
  </div>
</template>
