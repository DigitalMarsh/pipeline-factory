<!--
  模块职责：探索时间线上的**一条消息**——按行型选分支渲染（输入卡 / 你说的 / 模型说的 / 推理 /
  分隔行 / 动作行），最后一条兜底当场显示。
  维护提示：新增一种行型时，先把它归到 `EXPLORER_ROW_MODES` 或 `EXPLORER_INLINE_MODES`（编译期护栏
  会逼着人回答"它归哪一边"），再来这里补分支。
-->
<script setup lang="ts">
/**
 * 为什么单独成文件：这三段就地模板（用户消息 / 助手正文 / 结构化输入卡）与那串 `v-if` 分派原先住在
 * `ExplorerView.vue`（2127 行）里，与加载、SSE、抽屉、需求清单混在一处——改一次行型要把两千行从头读到尾。
 * 执行侧早就这么分了（`ExecutionMessageRow.vue` 是外壳、六个叶子各一个文件），这里补齐同一分法，
 * 与 §0.2 那条"**渲染只跟形态走**"是同一件事。
 *
 * 维护提示：
 * 1. **它不判断"这条该不该显示"**：隐显由视图用 `EXPLORER_DISPLAY_MODES` 过一遍（`renderedTimelineItems`），
 *    这里只管"长什么样"。新增取值没归到任何一边时，掉进 `.timeline-unknown-row` **当场显示**。
 * 2. 输入卡上那三处答案文案读的是**本地草稿与在途标记**（`inputProgress` / `inputAnswerInFlight`），
 *    它们归 `useExplorerInputRequests` 所有——以 props 传进来，不在这里复制一份状态
 *    （复制一份就会与对话框里的编辑态不同步）。
 * 3. 方案卡绑到哪条助手消息由视图算好（`planTimeline.planActivityBindings`），这里只负责摆；
 *    查看 / 确认 / 入队都往上报，动作由视图做（它拿着当前需求与 busy）。
 */
import { computed } from "vue";
import { Check, InfoFilled, Warning } from "@element-plus/icons-vue";
import type { ExplorerInputRequest, Plan } from "../types";
import { explorerTimelineTarget, inputRequestTarget, type ExplorerTimelineItem } from "../utils/explorerTimeline";
import { inputAnswerDisplayLabels, inputAnswerDisplayText } from "../utils/explorerInput";
import type { ExplorerInputProgress } from "../utils/explorerInputProgressDraft";
import {
  assistantActivityLabel,
  explorerDisplayMode,
  formatTurnTime,
  inputStatusLabel,
  EXPLORER_ROW_MODES,
  type ExplorerRowMode,
} from "../utils/explorerPresentation";
import { inputStatusTagType, statusTagType } from "../utils/statusTag";
import { readableAssistantText } from "../utils/planProtocolDisplay";
import MarkdownMessage from "./MarkdownMessage.vue";
import ExplorerActivityRow from "./ExplorerActivityRow.vue";
import ExplorerCandidatePlanCard from "./ExplorerCandidatePlanCard.vue";
import ExplorerDividerRow from "./ExplorerDividerRow.vue";
import ExplorerReasoningRow from "./ExplorerReasoningRow.vue";

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
}>();

/** 活动条目的行型；输入卡走另一条路（`item.kind === "input"`）。 */
const activity = computed(() => (props.item.kind === "activity" ? props.item.activity : null));
const mode = computed(() => (activity.value ? explorerDisplayMode(activity.value.kind) : null));
/** 属于"共用行组件的那三种行型"时交出它的行型，否则 null（由别的分支负责）。 */
const rowMode = computed<ExplorerRowMode | null>(() =>
  mode.value && (EXPLORER_ROW_MODES as readonly string[]).includes(mode.value) ? (mode.value as ExplorerRowMode) : null,
);
/** 方案卡显不显示也问同一张清单表——与整个条目要不要显示是同一条判据（见文件头维护提示 1）。 */
const showCandidatePlanCard = explorerDisplayMode("CANDIDATE_PLAN") !== "hidden";

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
  <article
    v-if="item.kind === 'input'"
    :id="inputRequestTarget(item.request)"
    :data-nav-key="`input:${item.request.id}`"
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
      <div class="message-meta">
        <strong>Plan Explorer 输入</strong
        ><el-tag size="small" effect="light" :type="inputStatusTagType(item.request.status)">{{ statusTextFor(item.request) }}</el-tag>
      </div>
      <div class="input-request-event-times">
        <span
          ><strong>问题生成</strong><time>{{ formatTurnTime(item.request.createdAt) }}</time></span
        ><span v-if="item.request.answeredAt"
          ><strong>回答提交</strong><time>{{ formatTurnTime(item.request.answeredAt) }}</time></span
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

  <!-- 你自己说的话：一行原文，靠右、带 `›`，**没有头像、没有卡片、没有展开按钮**。 -->
  <article
    v-else-if="activity && mode === 'text'"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    :class="['timeline-user-text', { 'failed-message': activity.status === 'FAILED' }]"
  >
    <span class="timeline-user-mark" aria-hidden="true">›</span>
    <div class="timeline-user-body">
      <MarkdownMessage :source="activity.summary" />
      <time>{{ formatTurnTime(activity.occurredAt) }}</time>
    </div>
  </article>

  <!-- 模型说的正文：铺开、不套气泡；上面一行 meta 说"还在跑 / 失败"，方案卡内嵌在这一块里。 -->
  <article
    v-else-if="activity && mode === 'prose'"
    :id="explorerTimelineTarget(activity, index)"
    :data-nav-key="explorerTimelineTarget(activity, index)"
    :class="['timeline-assistant-prose', { 'failed-message': activity.status === 'FAILED' }]"
  >
    <div class="timeline-assistant-body">
      <div class="timeline-assistant-meta">
        <span class="thread-mark" :class="{ 'thread-mark-live': activity.status === 'RUNNING' }" /><strong>{{ activity.title }}</strong
        ><el-tag size="small" effect="light" :type="statusTagType(activity.status)">{{ assistantActivityLabel(activity) }}</el-tag
        ><span>{{ formatTurnTime(activity.occurredAt) }}</span>
      </div>
      <MarkdownMessage
        :source="readableAssistantText(activity.summary)"
        :streaming="activity.status === 'RUNNING'"
      /><ExplorerCandidatePlanCard
        v-if="showCandidatePlanCard && plan"
        :plan="plan"
        :is-candidate="isCandidatePlan"
        :busy="busy"
        @view="emit('view-plan', $event)"
        @confirm="emit('confirm-plan', $event)"
        @enqueue="emit('enqueue-plan', $event)"
      />
    </div>
  </article>

  <template v-else-if="activity && mode === 'reasoning'"><ExplorerReasoningRow :activity="activity" :index="index" /></template>
  <template v-else-if="activity && mode === 'divider'"><ExplorerDividerRow :activity="activity" :index="index" /></template>
  <template v-else-if="activity && rowMode"><ExplorerActivityRow :activity="activity" :index="index" :mode="rowMode" /></template>
  <article v-else class="timeline-unknown-row">未识别的行型：{{ mode }}（{{ activity?.kind }}）</article>
</template>
