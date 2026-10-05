<script setup lang="ts">
/**
 * 模块职责：执行会话里的**冻结方案卡**（`PLAN`）——每个 Run 一张，投影时前置。
 *
 * 为什么单独成组件：它不是一行，是这张卡本身有展开态、有统计、有跳转动作。
 * 这些跟"摆一行消息"没有关系，挤在那条 `v-if / v-else-if` 链里只会让两边都难读。
 */
import { ref } from "vue";
import MarkdownMessage from "./MarkdownMessage.vue";
import type { ExecutionPlanSnapshot } from "../utils/executionStream";

defineProps<{ itemId: string; plan: ExecutionPlanSnapshot }>();
const emit = defineEmits<{ view: [] }>();

const expanded = ref(false);
</script>

<template>
  <div class="execution-plan-message">
    <div class="execution-plan-message-summary"><MarkdownMessage :source="plan.goal" /></div>
    <button
      :id="`execution-plan-toggle-${itemId}`"
      class="execution-plan-toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="`execution-plan-details-${itemId}`"
      @click="expanded = !expanded"
    >{{ expanded ? '收起 Plan 摘要' : '展开 Plan 摘要' }}</button>
    <div v-if="expanded" :id="`execution-plan-details-${itemId}`" class="execution-plan-message-details">
      <div class="execution-plan-message-stats">
        <span><strong>{{ plan.tasks.length }}</strong> 个任务</span>
        <span><strong>{{ plan.acceptanceCriteria.length }}</strong> 条验收标准</span>
        <span><strong>{{ plan.verificationCommandIds.length }}</strong> 条验证命令</span>
      </div>
      <div v-if="plan.tasks.length" class="execution-plan-message-section">
        <span class="execution-plan-message-label">任务</span>
        <ul><li v-for="task in plan.tasks" :key="task.id ?? task.title">{{ task.title }}</li></ul>
      </div>
      <div class="execution-plan-message-scope">
        <div>
          <span class="execution-plan-message-label">包含</span>
          <code v-for="path in plan.includePaths" :key="`include-${path}`">{{ path }}</code>
          <small v-if="!plan.includePaths.length">无包含路径</small>
        </div>
        <div>
          <span class="execution-plan-message-label">排除</span>
          <code v-for="path in plan.excludePaths" :key="`exclude-${path}`">{{ path }}</code>
          <small v-if="!plan.excludePaths.length">无排除路径</small>
        </div>
      </div>
    </div>
    <div class="execution-plan-message-actions"><el-button text size="small" @click="emit('view')">查看方案</el-button></div>
  </div>
</template>
