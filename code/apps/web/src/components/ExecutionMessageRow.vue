<script setup lang="ts">
/**
 * 模块职责：执行会话里的**一条消息**——共享消息壳（头像 / meta / 正文）+ 按形态选行组件。
 *
 * 同一条消息要在**两处**渲染：当前可见的那批，以及折在上方「N 条过程记录」里那批（展开后是
 * **真实的行**，不是一张只写了标题的清单）。两处共用这一个组件，所以展开前后同一条消息长得一样。
 *
 * 维护提示：
 * 1. 头像只表示"谁在说"：用户 = 你，Executor 的正文 = 执；过程行（Plan / 推理 / 工具 / 活动）
 *    不挂头像，内容仍与正文同一左边界。此前 `PL` / `TL` / `·` 字母块表示的是"哪一类行"，
 *    与探索侧的圆点各说各话，已删除。
 * 2. `data-sequence` / `data-task-id` / `data-model-step` / `title` 直接挂在外壳上，靠属性透传
 *    落到根 `<article>`；`RunDetailView.focusExecutionTask()` 依赖 `[data-sequence]`。
 * 3. 状态文案与 tag 类型仍走 `executionMessageStatusLabel` / `statusTagType`，与探索侧同一套词。
 */
import { computed } from "vue";
import { executionMessageStatusLabel, type ExecutionStreamItem } from "../utils/executionStream";
import { executionMessageDetails, executionMessageDiagnosticsTitle } from "../utils/executionMessageDetails";
import { statusTagType } from "../utils/statusTag";
import { formatMessageTime } from "../utils/messageTime";
import ChatMessageShell from "./ChatMessageShell.vue";
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

const isUser = computed(() => props.item.role === "user");
const isModel = computed(() => props.item.kind === "model");
const isProcess = computed(() => !isUser.value && !isModel.value);
const statusLabel = computed(() => (props.item.status === "INFO" ? null : executionMessageStatusLabel(props.item.status)));
const time = computed(() => formatMessageTime(props.item.occurredAt));
const details = computed(() => executionMessageDetails(props.item));
/** 推理块的标题由 ChatReasoningRow 自己写（「推理 · 第 N 轮」），meta 里不再重复。 */
const headline = computed(() => (props.item.kind === "reasoning" ? null : props.item.title));

function toggleDetails(): void {
  emit("toggle-details", props.item.id);
}
function viewPlan(): void {
  // 卡片只喊一声"要看方案"就够——视图拿的是当前 Run 的 Plan，不需要从这条消息里回传一份快照。
  emit("view-plan");
}
</script>

<template>
  <ExecutionDividerRow v-if="item.kind === 'divider'" :item="item" :data-sequence="item.sequence" :data-task-id="item.taskId" />
  <ChatMessageShell
    v-else
    :side="isUser ? 'user' : 'assistant'"
    :avatar="isUser ? 'user' : isModel ? 'executor' : null"
    :author="isModel ? 'Executor' : null"
    :headline="headline"
    :status-label="statusLabel"
    :status-type="statusTagType(item.status)"
    :time="item.kind === 'reasoning' ? null : time"
    :datetime="item.kind === 'reasoning' ? null : item.occurredAt"
    :title="executionMessageDiagnosticsTitle(item)"
    :data-sequence="item.sequence"
    :data-task-id="item.taskId"
    :data-model-step="item.modelStep"
    :class="[
      'execution-message',
      `execution-message-${item.kind}`,
      {
        failed: item.status === 'FAILED',
        waiting: item.status === 'WAITING',
        running: item.status === 'RUNNING',
        unknown: item.status === 'UNKNOWN',
        mine: isUser,
      },
    ]"
    :compact="isProcess"
    :failed="item.status === 'FAILED'"
    :running="item.status === 'RUNNING'"
  >
    <template v-if="details.length" #meta-actions>
      <button type="button" class="execution-message-toggle" :aria-expanded="expanded" @click="toggleDetails">
        {{ expanded ? "收起详情" : "详情" }}
      </button>
    </template>
    <div v-if="expanded" class="execution-message-details">
      <span v-for="detail in details" :key="detail">{{ detail }}</span>
    </div>
    <template v-if="item.kind === 'plan' && item.plan">
      <ExecutionPlanCard :item-id="item.id" :plan="item.plan" @view="viewPlan" />
    </template>
    <template v-else-if="item.kind === 'model'"><ExecutionModelRow :item="item" /></template>
    <template v-else-if="item.kind === 'user'"><ExecutionUserRow :item="item" /></template>
    <template v-else-if="item.kind === 'reasoning'"><ExecutionReasoningRow :item="item" /></template>
    <template v-else-if="item.kind === 'activity' || item.kind === 'tool'"><ExecutionActivityRow :item="item" /></template>
    <article v-else class="chat-unknown-row">未识别的消息形态：{{ item.kind }}（{{ item.messageType }}）</article>
  </ChatMessageShell>
</template>
