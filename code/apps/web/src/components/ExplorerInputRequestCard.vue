<!--
  模块职责：探索时间线里的**结构化输入卡**——提问、你的回答、这一问当前的状态合成一张卡。
  独立成文件是因为它同时出现在两种排版里：独立行（`ChatMessageShell`）与回合块内的过程行
  （`ExplorerTurnGroup`）；卡内内容只该有一份。

  维护提示：
  1. 卡上的答案文案读的是**本地草稿与在途标记**（`inputProgress` / `inputAnswerInFlight`），以 props 传入，
     不在这里复制一份状态（复制一份就会与对话框里的编辑态不同步）。
  2. 角色/状态/时间的 meta 由外层负责；这张卡只摆问题、事件时间、回答与「回答」按钮。
  3. 锚点 `id` / `data-nav-key` 在外层行上，不在卡上——时间线跳转按行找目标。
-->
<script setup lang="ts">
import { computed } from "vue";
import { Check, InfoFilled, Warning } from "@element-plus/icons-vue";
import type { ExplorerInputRequest } from "../types";
import { inputAnswerDisplayLabels, inputAnswerDisplayText } from "../utils/explorerInput";
import type { ExplorerInputProgress } from "../utils/explorerInputProgressDraft";
import { formatMessageTime } from "../utils/messageTime";

const props = defineProps<{
  request: ExplorerInputRequest;
  /** 这个输入请求正在等回答（决定行尾那颗「回答」按钮出不出现）。 */
  pendingInputId: string | null;
  inputProgress: ExplorerInputProgress | null;
  inputAnswerInFlight: string | null;
}>();

const emit = defineEmits<{ (event: "answer"): void }>();

const stateClass = computed(() => ({
  recovery: props.request.status === "RECOVERY_REQUIRED",
  answered: props.request.status === "ANSWERED",
  cancelled: props.request.status === "CANCELLED",
}));

function answerLabelsFor(questionIndex: number): string[] {
  return inputAnswerDisplayLabels(props.request, props.request.questions[questionIndex]!, props.inputProgress);
}
function answerTextFor(questionIndex: number): string {
  return inputAnswerDisplayText(props.request, props.request.questions[questionIndex]!, props.inputProgress, props.inputAnswerInFlight);
}
</script>

<template>
  <article :class="['input-request-card', 'timeline-input-request', stateClass]">
    <div class="input-request-card-icon">
      <Check v-if="request.status === 'ANSWERED'" :size="16" /><Warning
        v-else-if="request.status === 'RECOVERY_REQUIRED' || request.status === 'CANCELLED'"
        :size="16"
      /><InfoFilled v-else :size="16" />
    </div>
    <div class="input-request-card-body">
      <div class="input-request-event-times">
        <span
          ><strong>问题生成</strong><time>{{ formatMessageTime(request.createdAt) }}</time></span
        ><span v-if="request.answeredAt"
          ><strong>回答提交</strong><time>{{ formatMessageTime(request.answeredAt) }}</time></span
        >
      </div>
      <p v-if="request.status === 'SUBMITTING' || inputAnswerInFlight === request.id">
        已提交的答案正在等待 Provider 确认。刷新后会保留非敏感答案草稿，请勿重复提交。
      </p>
      <p v-else-if="request.status === 'RECOVERY_REQUIRED'">
        App Server 在回答确认前中断。本次回答不会自动重试，请恢复 Provider 会话后从此线程继续。
      </p>
      <p v-else-if="request.status === 'CANCELLED'">本次结构化输入已取消，问题和当时的时间点仍保留在对话记录中。</p>
      <p v-else-if="request.status === 'ANSWERED'">本轮结构化问题与回答已按原始时间线保留。</p>
      <p v-else>{{ request.questions.length }} 个结构化问题正在等待回答，回答后本轮才能继续。</p>
      <div class="input-request-section-label">问题与回答</div>
      <div class="input-stream-questions">
        <div v-for="(question, questionIndex) in request.questions" :key="question.id" class="input-stream-question">
          <span class="question-index">{{ questionIndex + 1 }}</span>
          <div>
            <strong>{{ question.header }}</strong>
            <p>{{ question.question }}</p>
            <small :class="{ answered: answerLabelsFor(questionIndex).length }">回答：{{ answerTextFor(questionIndex) }}</small>
          </div>
        </div>
      </div>
    </div>
    <el-button v-if="pendingInputId === request.id && inputAnswerInFlight !== request.id" type="primary" plain @click="emit('answer')"
      >回答</el-button
    >
  </article>
</template>
