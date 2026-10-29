<!--
  模块职责：探索时间线上的**一条消息**——按行型选分支渲染（输入卡 / 你说的 / 模型说的 / 推理 /
  分隔行 / 动作行），最后一条兜底当场显示。

  维护提示：
  1. 行的几何、头像、meta、锚点全部交给 `ChatMessageShell`（与执行线程共用）；本文件只决定
     "这一条是哪种形态、内容是什么"。
  2. **过程行不挂头像**：推理 / 工具 / 输入卡都从内容栏开始，与正文同一左边界；头像只表示"谁在说"。
  3. **它不判断"这条该不该显示"**：隐显由视图用 `EXPLORER_DISPLAY_MODES` 过一遍
     （`renderedTimelineItems`），这里只管"长什么样"。新增取值没归到任何一边时，掉进
     `.chat-unknown-row` **当场显示**。
  4. 输入卡上的答案文案读的是本地草稿与在途标记（`inputProgress` / `inputAnswerInFlight`），
     以 props 传入，不在这里复制一份状态。
  5. 方案卡绑到哪条助手消息由视图算好（`planTimeline.planActivityBindings`），这里只负责摆。
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, InfoFilled, Warning } from "@element-plus/icons-vue";
import type { ExplorerActivityItem, ExplorerInputRequest, MessageAttachment, Plan } from "../types";
import { explorerTimelineTarget, inputRequestTarget, type ExplorerTimelineItem } from "../utils/explorerTimeline";
import { inputAnswerDisplayLabels, inputAnswerDisplayText } from "../utils/explorerInput";
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
import MarkdownMessage from "./MarkdownMessage.vue";
import ExplorerActivityRow from "./ExplorerActivityRow.vue";
import ExplorerCandidatePlanCard from "./ExplorerCandidatePlanCard.vue";
import ExplorerDividerRow from "./ExplorerDividerRow.vue";
import ExplorerReasoningRow from "./ExplorerReasoningRow.vue";
import MessageAttachments from "./MessageAttachments.vue";

const props = defineProps<{
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
}>();

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

/** 三道答案文案都把本地状态喂给 utils 里的纯函数——与对话框里的编辑态同源。 */
function answerLabelsFor(request: ExplorerInputRequest, questionIndex: number): string[] {
  return inputAnswerDisplayLabels(request, request.questions[questionIndex]!, props.inputProgress);
}
function answerTextFor(request: ExplorerInputRequest, questionIndex: number): string {
  return inputAnswerDisplayText(request, request.questions[questionIndex]!, props.inputProgress, props.inputAnswerInFlight);
}
function statusTextFor(request: ExplorerInputRequest): string {
  return inputStatusLabel(request, props.inputAnswerInFlight);
}
</script>

<template>
  <!-- 结构化输入卡：提问 + 你的回答 + 这一问当前的状态，三者合成一张，按**提问时间**插进时间线。 -->
  <ChatMessageShell
    v-if="item.kind === 'input'"
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
    <article
      :class="[
        'input-request-card',
        'timeline-input-request',
        {
          recovery: item.request.status === 'RECOVERY_REQUIRED',
          answered: item.request.status === 'ANSWERED',
          cancelled: item.request.status === 'CANCELLED',
        },
      ]"
    >
      <div class="input-request-card-icon">
        <Check v-if="item.request.status === 'ANSWERED'" :size="16" /><Warning
          v-else-if="item.request.status === 'RECOVERY_REQUIRED' || item.request.status === 'CANCELLED'"
          :size="16"
        /><InfoFilled v-else :size="16" />
      </div>
      <div class="input-request-card-body">
        <div class="input-request-event-times">
          <span
            ><strong>问题生成</strong><time>{{ formatMessageTime(item.request.createdAt) }}</time></span
          ><span v-if="item.request.answeredAt"
            ><strong>回答提交</strong><time>{{ formatMessageTime(item.request.answeredAt) }}</time></span
          >
        </div>
        <p v-if="item.request.status === 'SUBMITTING' || inputAnswerInFlight === item.request.id">
          已提交的答案正在等待 Provider 确认。刷新后会保留非敏感答案草稿，请勿重复提交。
        </p>
        <p v-else-if="item.request.status === 'RECOVERY_REQUIRED'">
          App Server 在回答确认前中断。本次回答不会自动重试，请恢复 Provider 会话后从此线程继续。
        </p>
        <p v-else-if="item.request.status === 'CANCELLED'">本次结构化输入已取消，问题和当时的时间点仍保留在对话记录中。</p>
        <p v-else-if="item.request.status === 'ANSWERED'">本轮结构化问题与回答已按原始时间线保留。</p>
        <p v-else>{{ item.request.questions.length }} 个结构化问题正在等待回答，回答后本轮才能继续。</p>
        <div class="input-request-section-label">问题与回答</div>
        <div class="input-stream-questions">
          <div v-for="(question, questionIndex) in item.request.questions" :key="question.id" class="input-stream-question">
            <span class="question-index">{{ questionIndex + 1 }}</span>
            <div>
              <strong>{{ question.header }}</strong>
              <p>{{ question.question }}</p>
              <small :class="{ answered: answerLabelsFor(item.request, questionIndex).length }"
                >回答：{{ answerTextFor(item.request, questionIndex) }}</small
              >
            </div>
          </div>
        </div>
      </div>
      <el-button
        v-if="pendingInputId === item.request.id && inputAnswerInFlight !== item.request.id"
        type="primary"
        plain
        @click="emit('answer')"
        >回答</el-button
      >
    </article>
  </ChatMessageShell>

  <!-- 你说的：右对齐气泡，头像「你」，时间在气泡下方。 -->
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

  <!-- 模型说的正文：头像 + 一行 meta，正文铺开；方案卡内嵌在这一块里。 -->
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
