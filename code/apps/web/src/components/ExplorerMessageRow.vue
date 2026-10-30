<!--
  模块职责：探索时间线上的**一条消息**——按行型选分支渲染（输入卡 / 你说的 / 模型说的 / 推理 /
  分隔行 / 动作行），最后一条兜底当场显示。

  维护提示：
  1. 两条渲染路径：
     - `grouped = false`（默认）：独立行，几何/头像/meta/锚点交给 `ChatMessageShell`（与执行线程共用）；
       用户消息、分隔行、以及没归入回合的条目走这里。
     - `grouped = true`：`ExplorerTurnGroup` 里的子行——回合头已经给了角色/状态/时间，
       所以正文不再带头像与 meta；过程行缩进一格并保留类型图标与 meta。
  2. **过程行不挂角色头像**：推理 / 工具 / 输入卡都用类型图标；头像只表示"谁在说"。
  3. **它不判断"这条该不该显示"**：隐显由视图用 `EXPLORER_DISPLAY_MODES` 过一遍
     （`renderedTimelineItems`），这里只管"长什么样"。新增取值没归到任何一边时，掉进
     `.chat-unknown-row` **当场显示**。
  4. 输入卡的内容在 `ExplorerInputRequestCard.vue`（独立行与回合内共用）；答案文案读的是本地草稿
     与在途标记，以 props 传入。
  5. 方案卡绑到哪条助手消息由视图算好（`planTimeline.planActivityBindings`），这里只负责摆。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ExplorerActivityItem, ExplorerInputRequest, MessageAttachment, Plan } from "../types";
import { explorerTimelineTarget, inputRequestTarget, type ExplorerTimelineItem } from "../utils/explorerTimeline";
import type { ExplorerInputProgress } from "../utils/explorerInputProgressDraft";
import {
  activityStatusLabel,
  assistantActivityLabel,
  explorerActivityLine,
  explorerDisplayMode,
  inputStatusLabel,
  EXPLORER_ROW_MODES,
  type ExplorerRowMode,
} from "../utils/explorerPresentation";
import { inputStatusTagType, statusTagType } from "../utils/statusTag";
import { formatMessageTime } from "../utils/messageTime";
import { EXPLORER_INPUT_ICON, EXPLORER_UNKNOWN_ICON, explorerProcessIcon } from "../utils/chatIcons";
import { readableAssistantText } from "../utils/planProtocolDisplay";
import ChatMessageShell from "./ChatMessageShell.vue";
import ExplorerInputRequestCard from "./ExplorerInputRequestCard.vue";
import MarkdownMessage from "./MarkdownMessage.vue";
import ExplorerActivityRow from "./ExplorerActivityRow.vue";
import ExplorerCandidatePlanCard from "./ExplorerCandidatePlanCard.vue";
import ExplorerDividerRow from "./ExplorerDividerRow.vue";
import ExplorerReasoningRow from "./ExplorerReasoningRow.vue";
import MessageAttachments from "./MessageAttachments.vue";

const props = withDefaults(
  defineProps<{
    item: ExplorerTimelineItem;
    /** 它在可见条目里的序号——`explorerTimelineTarget()` 的锚点要用它。 */
    index: number;
    /** 绑在这条助手消息上的方案（没有就是 null）。 */
    plan: Plan | null;
    /** 上面那份是不是"当前需求正在用的候选方案"——决定给不给确认 / 入队按钮。 */
    isCandidatePlan: boolean;
    busy: boolean;
    /** 这个输入请求正在等回答（决定行尾那颗「回答」按钮出不出现）。 */
    pendingInputId: string | null;
    inputProgress: ExplorerInputProgress | null;
    inputAnswerInFlight: string | null;
    /** 在 `ExplorerTurnGroup` 里渲染：回合头提供角色/状态/时间，子行不再重复头像与 meta。 */
    grouped?: boolean;
  }>(),
  { grouped: false },
);

const emit = defineEmits<{
  (event: "answer"): void;
  (event: "view-plan", plan: Plan): void;
  (event: "confirm-plan", plan: Plan): void;
  (event: "enqueue-plan", plan: Plan): void;
  /** 失败回合的「重试」：由视图决定重发哪一条用户消息。 */
  (event: "retry", activity: ExplorerActivityItem): void;
}>();

/** 失败详情默认收起：整段英文错误铺在时间线上既刺眼又难扫。 */
const errorExpanded = ref(false);
watch(
  () => props.item.key,
  () => {
    errorExpanded.value = false;
  },
);

/** 详情优先用投影带回来的原始错误；没有时退回正文。 */
function failureDetail(activity: ExplorerActivityItem): string {
  const error = activity.details?.error;
  return typeof error === "string" && error.trim() ? error : activity.summary;
}

/** 活动条目的行型；输入卡走另一条路（`item.kind === "input"`）。 */
const activity = computed(() => (props.item.kind === "activity" ? props.item.activity : null));
const mode = computed(() => (activity.value ? explorerDisplayMode(activity.value.kind) : null));
/** 属于"共用行组件的那三种行型"时交出它的行型，否则 null（由别的分支负责）。 */
const rowMode = computed<ExplorerRowMode | null>(() =>
  mode.value && (EXPLORER_ROW_MODES as readonly string[]).includes(mode.value) ? (mode.value as ExplorerRowMode) : null,
);
/** 活动行要摆的字段（标签 / 名字 / 引用 / 正文）；与纯函数同源，壳只负责摆位置。 */
const activityLine = computed(() => (activity.value ? explorerActivityLine(activity.value) : null));
/** 过程行的类型图标：工具 / 命令 / 文件 / 推理…（头像只留给"谁在说"）。 */
const activityIcon = computed(() => (activity.value ? explorerProcessIcon(activity.value.kind) : EXPLORER_UNKNOWN_ICON));
/** 方案卡显不显示也问同一张清单表——与整个条目要不要显示是同一条判据（见文件头维护提示 3）。 */
const showCandidatePlanCard = explorerDisplayMode("CANDIDATE_PLAN") !== "hidden";

/** 用户消息随带的图片：由 API 投影在 `details.attachments` 上（见 routes/explorers.ts）。 */
const userAttachments = computed<MessageAttachment[]>(() => {
  if (!activity.value || activity.value.kind !== "USER_MESSAGE") return [];
  const value = activity.value.details?.attachments;
  return Array.isArray(value) ? (value as MessageAttachment[]) : [];
});

function statusTextFor(request: ExplorerInputRequest): string {
  return inputStatusLabel(request, props.inputAnswerInFlight);
}
</script>

<template>
  <!-- ───── 回合块内的子行（grouped）───── -->
  <article
    v-if="grouped && item.kind === 'input'"
    :id="inputRequestTarget(item.request)"
    :data-nav-key="`input:${item.request.id}`"
    class="chat-turn-item chat-turn-input"
  >
    <span class="chat-turn-item-icon"><component :is="EXPLORER_INPUT_ICON" /></span>
    <div class="chat-turn-item-main">
      <div class="chat-meta">
        <span class="chat-headline">结构化输入</span>
        <el-tag size="small" effect="light" :type="inputStatusTagType(item.request.status)">{{ statusTextFor(item.request) }}</el-tag>
        <time class="chat-time" :datetime="item.request.createdAt">{{ formatMessageTime(item.request.createdAt) }}</time>
      </div>
      <ExplorerInputRequestCard
        :request="item.request"
        :pending-input-id="pendingInputId"
        :input-progress="inputProgress"
        :input-answer-in-flight="inputAnswerInFlight"
        @answer="emit('answer')"
      />
    </div>
  </article>

  <article
    v-else-if="grouped && activity && mode === 'prose'"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    :class="['chat-turn-item', 'chat-turn-prose', { failed: activity.status === 'FAILED' }]"
  >
    <template v-if="activity.status === 'FAILED'">
      <p class="timeline-failure-summary">模型调用失败，本轮没有产出结果。可以查看详情，或重试上一条消息。</p>
      <div class="timeline-failure-actions">
        <button type="button" class="timeline-failure-link" :aria-expanded="errorExpanded" @click="errorExpanded = !errorExpanded">
          {{ errorExpanded ? "收起详情" : "查看详情" }}
        </button>
        <button type="button" class="timeline-failure-retry" @click="emit('retry', activity)">重试</button>
      </div>
      <pre v-if="errorExpanded" class="timeline-failure-detail">{{ failureDetail(activity) }}</pre>
    </template>
    <template v-else>
      <MarkdownMessage :source="readableAssistantText(activity.summary)" :streaming="activity.status === 'RUNNING'" />
      <ExplorerCandidatePlanCard
        v-if="showCandidatePlanCard && plan"
        :plan="plan"
        :is-candidate="isCandidatePlan"
        :busy="busy"
        @view="emit('view-plan', $event)"
        @confirm="emit('confirm-plan', $event)"
        @enqueue="emit('enqueue-plan', $event)"
      />
    </template>
  </article>

  <article
    v-else-if="grouped && activity && mode === 'reasoning'"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    class="chat-turn-item chat-turn-process"
  >
    <span class="chat-turn-item-icon"><component :is="explorerProcessIcon('REASONING')" /></span>
    <div class="chat-turn-item-main"><ExplorerReasoningRow :activity="activity" /></div>
  </article>

  <article
    v-else-if="grouped && activity && rowMode && activityLine"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    class="chat-turn-item chat-turn-process"
  >
    <span class="chat-turn-item-icon"><component :is="activityIcon" /></span>
    <div class="chat-turn-item-main">
      <div class="chat-meta">
        <span class="chat-headline">{{ activityLine.label }}</span>
        <code v-if="activityLine.name" class="chat-name">{{ activityLine.name }}</code>
        <el-tag size="small" effect="light" :type="statusTagType(activity.status)">{{ activityStatusLabel(activity) }}</el-tag>
        <time class="chat-time" :datetime="activity.occurredAt">{{ formatMessageTime(activity.occurredAt) }}</time>
      </div>
      <ExplorerActivityRow :activity="activity" :mode="rowMode" :line="activityLine" />
    </div>
  </article>

  <article
    v-else-if="grouped && activity"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    class="chat-turn-item chat-turn-process"
  >
    <span class="chat-turn-item-icon"><component :is="EXPLORER_UNKNOWN_ICON" /></span>
    <div class="chat-turn-item-main">
      <article class="chat-unknown-row">未识别的行型：{{ mode }}（{{ activity.kind }}）</article>
    </div>
  </article>

  <!-- ───── 独立行（非 grouped）───── -->
  <ChatMessageShell
    v-else-if="item.kind === 'input'"
    side="assistant"
    compact
    :icon="EXPLORER_INPUT_ICON"
    headline="结构化输入"
    :status-label="statusTextFor(item.request)"
    :status-type="inputStatusTagType(item.request.status)"
    :time="formatMessageTime(item.request.createdAt)"
    :datetime="item.request.createdAt"
    :anchor-id="inputRequestTarget(item.request)"
    :nav-key="`input:${item.request.id}`"
    :aria-label="`结构化输入：${statusTextFor(item.request)}`"
  >
    <ExplorerInputRequestCard
      :request="item.request"
      :pending-input-id="pendingInputId"
      :input-progress="inputProgress"
      :input-answer-in-flight="inputAnswerInFlight"
      @answer="emit('answer')"
    />
  </ChatMessageShell>

  <ChatMessageShell
    v-else-if="activity && mode === 'text'"
    side="user"
    avatar="user"
    :time="formatMessageTime(activity.occurredAt)"
    :datetime="activity.occurredAt"
    :anchor-id="explorerTimelineTarget(activity, index)"
    :nav-key="explorerTimelineTarget(activity, index)"
    :failed="activity.status === 'FAILED'"
    :aria-label="`你：${activity.summary.slice(0, 60)}`"
  >
    <MarkdownMessage :source="activity.summary" />
    <MessageAttachments :attachments="userAttachments" />
  </ChatMessageShell>

  <ChatMessageShell
    v-else-if="activity && mode === 'prose'"
    side="assistant"
    avatar="explorer"
    :author="activity.title"
    :status-label="assistantActivityLabel(activity)"
    :status-type="statusTagType(activity.status)"
    :time="formatMessageTime(activity.occurredAt)"
    :datetime="activity.occurredAt"
    :anchor-id="explorerTimelineTarget(activity, index)"
    :nav-key="explorerTimelineTarget(activity, index)"
    :failed="activity.status === 'FAILED'"
    :running="activity.status === 'RUNNING'"
  >
    <template v-if="activity.status === 'FAILED'">
      <p class="timeline-failure-summary">模型调用失败，本轮没有产出结果。可以查看详情，或重试上一条消息。</p>
      <div class="timeline-failure-actions">
        <button type="button" class="timeline-failure-link" :aria-expanded="errorExpanded" @click="errorExpanded = !errorExpanded">
          {{ errorExpanded ? "收起详情" : "查看详情" }}
        </button>
        <button type="button" class="timeline-failure-retry" @click="emit('retry', activity)">重试</button>
      </div>
      <pre v-if="errorExpanded" class="timeline-failure-detail">{{ failureDetail(activity) }}</pre>
    </template>
    <template v-else>
      <MarkdownMessage :source="readableAssistantText(activity.summary)" :streaming="activity.status === 'RUNNING'" />
      <ExplorerCandidatePlanCard
        v-if="showCandidatePlanCard && plan"
        :plan="plan"
        :is-candidate="isCandidatePlan"
        :busy="busy"
        @view="emit('view-plan', $event)"
        @confirm="emit('confirm-plan', $event)"
        @enqueue="emit('enqueue-plan', $event)"
      />
    </template>
  </ChatMessageShell>

  <ChatMessageShell
    v-else-if="activity && mode === 'reasoning'"
    side="assistant"
    compact
    :icon="explorerProcessIcon('REASONING')"
    :anchor-id="explorerTimelineTarget(activity, index)"
    :nav-key="explorerTimelineTarget(activity, index)"
    :running="activity.status === 'RUNNING'"
  >
    <ExplorerReasoningRow :activity="activity" />
  </ChatMessageShell>

  <ExplorerDividerRow v-else-if="activity && mode === 'divider'" :activity="activity" :index="index" />

  <ChatMessageShell
    v-else-if="activity && rowMode && activityLine"
    side="assistant"
    compact
    :icon="activityIcon"
    :headline="activityLine.label"
    :name="activityLine.name"
    :status-label="activityStatusLabel(activity)"
    :status-type="statusTagType(activity.status)"
    :time="formatMessageTime(activity.occurredAt)"
    :datetime="activity.occurredAt"
    :anchor-id="explorerTimelineTarget(activity, index)"
    :nav-key="explorerTimelineTarget(activity, index)"
    :running="activity.status === 'RUNNING'"
  >
    <ExplorerActivityRow :activity="activity" :mode="rowMode" :line="activityLine" />
  </ChatMessageShell>

  <ChatMessageShell
    v-else-if="activity"
    side="assistant"
    compact
    :icon="EXPLORER_UNKNOWN_ICON"
    :time="formatMessageTime(activity.occurredAt)"
  >
    <article class="chat-unknown-row">未识别的行型：{{ mode }}（{{ activity.kind }}）</article>
  </ChatMessageShell>
</template>
