<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ArrowLeft, ArrowRight, Check, Lock, CircleClose } from "@element-plus/icons-vue";
import type { ExplorerInputRequest } from "../types";
import { allInputQuestionsAnswered, buildInputAnswers, hasFreeformInput, hasSelectableOptions, inputQuestionComplete, nextInputQuestionIndex, previousInputQuestionIndex, resolveQuestionAnswers } from "../utils/explorerInput";

const props = defineProps<{ modelValue: boolean; request: ExplorerInputRequest | null }>();
type InputProgress = { requestId: string; currentIndex: number; values: Record<string, string[]>; otherValues: Record<string, string> };
const emit = defineEmits<{ "update:modelValue": [value: boolean]; submit: [answers: Record<string, { answers: string[] }>]; cancel: []; progress: [progress: InputProgress] }>();
const answers = ref<Record<string, string[]>>({});
const otherAnswers = ref<Record<string, string>>({});
const currentIndex = ref(0);
const submitting = ref(false);
const error = ref<string | null>(null);

const currentQuestion = computed(() => props.request?.questions[currentIndex.value] ?? null);
const currentQuestionAnswered = computed(() => currentQuestion.value ? inputQuestionComplete(currentQuestion.value, answers.value[currentQuestion.value.id] ?? [], otherAnswers.value[currentQuestion.value.id] ?? "") : false);
const allAnswers = computed(() => {
  const request = props.request;
  if (!request) return false;
  return allInputQuestionsAnswered(request.questions, answers.value, otherAnswers.value);
});
const isLastQuestion = computed(() => {
  const request = props.request;
  return Boolean(request) && currentIndex.value === (request?.questions.length ?? 0) - 1;
});
const completedQuestionCount = computed(() => props.request?.questions.filter((question) => inputQuestionComplete(question, answers.value[question.id] ?? [], otherAnswers.value[question.id] ?? "")).length ?? 0);

watch(() => props.request?.id, async () => {
  const next: Record<string, string[]> = {};
  for (const question of props.request?.questions ?? []) next[question.id] = [];
  answers.value = next;
  otherAnswers.value = {};
  currentIndex.value = 0;
  error.value = null;
  await nextTick();
  focusCurrentQuestion();
});

function focusCurrentQuestion() {
  const first = document.querySelector<HTMLElement>(".explorer-input-dialog .input-question-current input, .explorer-input-dialog .input-question-current textarea, .explorer-input-dialog .input-question-current button");
  first?.focus();
}

function emitProgress() {
  if (!props.request) return;
  emit("progress", {
    requestId: props.request.id,
    currentIndex: currentIndex.value,
    values: Object.fromEntries(Object.entries(answers.value).map(([id, values]) => [id, [...values]])),
    otherValues: { ...otherAnswers.value },
  });
}

function selectQuestion(index: number) {
  if (!props.request || submitting.value || index < 0 || index >= props.request.questions.length) return;
  currentIndex.value = index;
  error.value = null;
  void nextTick(focusCurrentQuestion);
}

function previousQuestion() {
  currentIndex.value = previousInputQuestionIndex(currentIndex.value);
  error.value = null;
  void nextTick(focusCurrentQuestion);
}

function nextQuestion() {
  if (!currentQuestion.value) return;
  if (!currentQuestionAnswered.value) {
    error.value = "请先回答当前问题";
    return;
  }
  currentIndex.value = nextInputQuestionIndex(currentIndex.value, props.request?.questions.length ?? 0);
  error.value = null;
  void nextTick(focusCurrentQuestion);
}

function toggleOption(questionId: string, label: string) {
  const question = props.request?.questions.find((item) => item.id === questionId);
  if (question?.isOther) otherAnswers.value[questionId] = "";
  const current = answers.value[questionId] ?? [];
  answers.value[questionId] = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
  error.value = null;
  emitProgress();
}

function setOther(questionId: string, value: string) {
  const question = props.request?.questions.find((item) => item.id === questionId);
  if (question?.isOther) {
    otherAnswers.value[questionId] = value;
    answers.value[questionId] = [];
  } else answers.value[questionId] = value ? [value] : [];
  error.value = null;
  emitProgress();
}

function submit() {
  if (!allAnswers.value || submitting.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const values = Object.fromEntries((props.request?.questions ?? []).map((question) => [question.id, resolveQuestionAnswers(question, answers.value[question.id] ?? [], otherAnswers.value[question.id] ?? "")]));
    emit("submit", buildInputAnswers(props.request?.questions ?? [], values));
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "提交失败，请重试";
    ElMessage.error(error.value);
    submitting.value = false;
  }
}

function onSubmitted() { submitting.value = false; emit("update:modelValue", false); }
function onFailed(message: string) { submitting.value = false; error.value = message; }
function cancel() { if (!submitting.value) emit("cancel"); }

defineExpose({ onSubmitted, onFailed });
</script>

<template>
  <el-dialog
    class="explorer-input-dialog"
    :model-value="modelValue"
    :title="request?.isBlocking ? 'Plan Explorer 需要你的选择' : '补充探索信息'"
    width="min(560px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!request?.isBlocking"
    :show-close="!request?.isBlocking"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="request" class="input-dialog-content">
      <div class="input-dialog-intro"><span class="input-dialog-status"><span class="mode-dot" /> STRUCTURED INPUT</span><p>这是来自 Plan Mode 的结构化问题。请按序号逐题作答，答案会在最后统一提交。</p></div>
      <nav class="input-question-nav" aria-label="结构化问题导航">
        <button v-for="(question, index) in request.questions" :key="question.id" type="button" :class="['input-question-step', { active: currentIndex === index, complete: inputQuestionComplete(question, answers[question.id] ?? [], otherAnswers[question.id] ?? '') }]" :aria-current="currentIndex === index ? 'step' : undefined" :aria-label="`第 ${index + 1} 题：${question.header}`" :disabled="submitting" @click="selectQuestion(index)"><span>{{ index + 1 }}</span><small>{{ question.header }}</small></button>
      </nav>
      <div class="input-dialog-question-stage">
        <section v-if="currentQuestion" class="input-question input-question-current">
          <div class="input-question-heading"><span class="question-index">{{ currentIndex + 1 }}</span><div><strong>{{ currentQuestion.header }}</strong><p>{{ currentQuestion.question }}</p></div></div>
          <div v-if="hasSelectableOptions(currentQuestion)" class="choice-list" role="group" :aria-label="currentQuestion.question">
            <button v-for="option in currentQuestion.options" :key="option.label" type="button" :class="['choice-option', { selected: (answers[currentQuestion.id] ?? []).includes(option.label) }]" :disabled="submitting" @click="toggleOption(currentQuestion.id, option.label)"><span class="choice-check"><Check v-if="(answers[currentQuestion.id] ?? []).includes(option.label)" :size="14" /></span><span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span></button>
          </div>
          <el-input v-if="hasFreeformInput(currentQuestion)" :model-value="currentQuestion.isOther ? otherAnswers[currentQuestion.id] ?? '' : answers[currentQuestion.id]?.[0] ?? ''" :type="currentQuestion.isSecret ? 'password' : 'textarea'" :show-password="currentQuestion.isSecret" :rows="currentQuestion.isSecret ? 1 : 3" :placeholder="currentQuestion.isOther ? '请输入其他方案…' : '请输入回答…'" :aria-label="currentQuestion.question" @update:model-value="setOther(currentQuestion.id, String($event))" />
          <div v-if="currentQuestion.isSecret" class="secret-hint"><Lock :size="13" /> 敏感答案仅传递给 App Server，不会保存到消息、事件或审计正文。</div>
        </section>
      </div>
      <div class="input-dialog-progress" role="status">已完成 {{ completedQuestionCount }} / {{ request.questions.length }} 题</div>
      <el-alert v-if="error" type="error" :closable="false" show-icon>{{ error }}</el-alert>
    </div>
    <template #footer>
      <div class="input-dialog-footer"><el-button :disabled="submitting" @click="cancel"><CircleClose :size="14" /> 取消本轮</el-button><el-button plain :disabled="submitting || currentIndex === 0" @click="previousQuestion"><ArrowLeft :size="14" /> 上一题</el-button><el-button v-if="!isLastQuestion" type="primary" :disabled="!currentQuestionAnswered || submitting" @click="nextQuestion">下一题 <ArrowRight :size="14" /></el-button><el-button v-else type="primary" :loading="submitting" :disabled="!allAnswers" @click="submit"><Check :size="14" /> 提交选择</el-button></div>
    </template>
  </el-dialog>
</template>
