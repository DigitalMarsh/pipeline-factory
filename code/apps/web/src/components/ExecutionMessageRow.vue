<script setup lang="ts">
/**
 * 模块职责：执行会话里的**一条消息**——头像 + 一行 meta + 正文。
 *
 * 为什么单独成文件：同一条消息要在**两处**渲染——当前可见的那批，以及折在上方「N 条过程记录」
 * 里那批（展开后是**真实的行**，不是一张只写了标题的清单，照 OpenClaw 的
 * *Expanding it restores the sequence with the existing tool-call groups*）。
 * 两处各写一份模板，就是"折叠展开前后同一条消息长得不一样"的成因。
 *
 * 正文按**形态**（`item.kind`）选行组件，与探索侧同一条规则；某一种形态掉到兜底说明模板没跟上，
 * **当场显示**而不是静默降级。
 */
import { computed } from "vue";
import { executionMessageStatusLabel, type ExecutionStreamItem } from "../utils/executionStream";
import { executionMessageDetails, executionMessageDiagnosticsTitle } from "../utils/executionMessageDetails";
import { statusTagType } from "../utils/statusTag";
import ExecutionActivityRow from "./ExecutionActivityRow.vue";
import ExecutionDividerRow from "./ExecutionDividerRow.vue";
import ExecutionModelRow from "./ExecutionModelRow.vue";
import ExecutionPlanCard from "./ExecutionPlanCard.vue";
import ExecutionReasoningRow from "./ExecutionReasoningRow.vue";
import ExecutionUserRow from "./ExecutionUserRow.vue";

const props = defineProps<{
  item: ExecutionStreamItem;
  /** 诊断字段（Turn #/Call/Provider item）展开了没有。由视图持有——同一条消息在两处要同步。 */
  expanded: boolean;
}>();

const emit = defineEmits<{
  (event: "toggle-details", id: string): void;
  (event: "view-plan"): void;
}>();

/** 头像只给"不是正文"的行：你自己说的话（`user`）与模型的正文（`model`）都不该挂一个字母块。 */
const showsAvatar = computed(() => props.item.kind !== "user" && props.item.kind !== "model");
const avatarText = computed(() => (props.item.kind === "plan" ? "PL" : props.item.kind === "model" ? "EX" : props.item.kind === "tool" ? "TL" : "·"));
const details = computed(() => executionMessageDetails(props.item));

function toggleDetails(): void {
  emit("toggle-details", props.item.id);
}
function viewPlan(): void {
  // 卡片只喊一声"要看方案"就够——视图拿的是当前 Run 的 Plan，不需要从这条消息里回传一份快照。
  emit("view-plan");
}
</script>

<template>
  <article
    :data-sequence="item.sequence"
    :data-task-id="item.taskId"
    :data-model-step="item.modelStep"
    :title="executionMessageDiagnosticsTitle(item)"
    :class="['execution-message', `execution-message-${item.kind}`, { failed: item.status === 'FAILED', waiting: item.status === 'WAITING', running: item.status === 'RUNNING', unknown: item.status === 'UNKNOWN', mine: item.role === 'user' }]"
  >
    <div v-if="showsAvatar" class="execution-message-avatar">{{ avatarText }}</div>
    <div class="execution-message-body">
      <div class="execution-message-meta">
        <strong>{{ item.title }}</strong>
        <el-tag v-if="item.status !== 'INFO'" size="small" effect="light" :type="statusTagType(item.status)">{{ executionMessageStatusLabel(item.status) }}</el-tag>
        <span class="execution-message-time">{{ new Date(item.occurredAt).toLocaleTimeString('zh-CN') }}</span>
        <button v-if="details.length" type="button" class="execution-message-toggle" :aria-expanded="expanded" @click="toggleDetails">{{ expanded ? '收起详情' : '详情' }}</button>
      </div>
      <div v-if="expanded" class="execution-message-details"><span v-for="detail in details" :key="detail">{{ detail }}</span></div>
      <template v-if="item.kind === 'plan' && item.plan"><ExecutionPlanCard :item-id="item.id" :plan="item.plan" @view="viewPlan" /></template>
      <template v-else-if="item.kind === 'model'"><ExecutionModelRow :item="item" /></template>
      <template v-else-if="item.kind === 'user'"><ExecutionUserRow :item="item" /></template>
      <template v-else-if="item.kind === 'divider'"><ExecutionDividerRow :item="item" /></template>
      <template v-else-if="item.kind === 'reasoning'"><ExecutionReasoningRow :item="item" /></template>
      <template v-else-if="item.kind === 'activity' || item.kind === 'tool'"><ExecutionActivityRow :item="item" /></template>
      <article v-else class="execution-unknown-row">未识别的消息形态：{{ item.kind }}（{{ item.messageType }}）</article>
    </div>
  </article>
</template>
