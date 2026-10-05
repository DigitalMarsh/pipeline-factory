<script setup lang="ts">
/**
 * 模块职责：执行会话里的**动作行**（`COMMAND` / `FILE_CHANGE` / `TOOL_CALL` / `MCP_CALL` /
 * `TASK_LIFECYCLE` / `GATE` / `CONTEXT` / `TURN_STATUS` / `UNCLASSIFIED` / `RECOVERY` / `RUN_ACTIVITY`）。
 *
 * 它们的正文都只有一句话（`item.detail`），标题由投影层按中立类别拼好——所以共用这一个行组件，
 * 与探索侧"调用行 / 门禁行 / 轮次行共用 `ExplorerActivityRow`"是同一条道理：
 * **按 DOM 形状分文件，不按消息类型分。**
 */
import type { ExecutionStreamItem } from "../utils/executionStream";

defineProps<{ item: ExecutionStreamItem }>();
</script>

<template>
  <p class="execution-activity-detail">{{ item.detail }}</p>
  <small v-if="item.unrecordedFields?.length" class="execution-message-note">{{ item.unrecordedFields.join(' · ') }}</small>
</template>
