<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Check, Lock, CircleClose } from "@element-plus/icons-vue";
import type { ExplorerInputRequest } from "../types";
import { buildInputAnswers, hasFreeformInput, hasSelectableOptions, resolveQuestionAnswers } from "../utils/explorerInput";

const props = defineProps<{ modelValue: boolean; request: ExplorerInputRequest | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; submit: [answers: Record<string, { answers: string[] }>]; cancel: [] }>();
const answers = ref<Record<string, string[]>>({});
const otherAnswers = ref<Record<string, string>>({});
const submitting = ref(false);
const error = ref<string | null>(null);

const hasAnswers = computed(() => Boolean(props.request?.questions.length) && Boolean(props.request?.questions.every((question) => resolveQuestionAnswers(question, answers.value[question.id] ?? [], otherAnswers.value[question.id] ?? "").some((item) => item.trim()))));

watch(() => props.request?.id, async () => {
  const next: Record<string, string[]> = {};
  for (const question of props.request?.questions ?? []) next[question.id] = [];
  answers.value = next;
  otherAnswers.value = {};
  error.value = null;
  await nextTick();
  const first = document.querySelector<HTMLElement>(".explorer-input-dialog input, .explorer-input-dialog textarea");
  first?.focus();
});

function toggleOption(questionId: string, label: string) {
  const question = props.request?.questions.find((item) => item.id === questionId);
  if (question?.isOther) otherAnswers.value[questionId] = "";
  const current = answers.value[questionId] ?? [];
  answers.value[questionId] = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
}

function setOther(questionId: string, value: string) {
  const question = props.request?.questions.find((item) => item.id === questionId);
  if (question?.isOther) {
    otherAnswers.value[questionId] = value;
    answers.value[questionId] = [];
  } else answers.value[questionId] = value ? [value] : [];
}

function submit() {
  if (!hasAnswers.value || submitting.value) return;
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
      <div class="input-dialog-intro"><span class="input-dialog-status"><span class="mode-dot" /> STRUCTURED INPUT</span><p>这是来自 Plan Mode 的结构化问题，不会把普通模型文本误判为选择请求。</p></div>
      <section v-for="question in request.questions" :key="question.id" class="input-question">
        <div class="input-question-heading"><span class="question-index">{{ request.questions.indexOf(question) + 1 }}</span><div><strong>{{ question.header }}</strong><p>{{ question.question }}</p></div></div>
        <div v-if="hasSelectableOptions(question)" class="choice-list" role="group" :aria-label="question.question">
          <button v-for="option in question.options" :key="option.label" type="button" :class="['choice-option', { selected: (answers[question.id] ?? []).includes(option.label) }]" @click="toggleOption(question.id, option.label)"><span class="choice-check"><Check v-if="(answers[question.id] ?? []).includes(option.label)" :size="14" /></span><span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span></button>
        </div>
        <el-input v-if="hasFreeformInput(question)" :model-value="question.isOther ? otherAnswers[question.id] ?? '' : answers[question.id]?.[0] ?? ''" :type="question.isSecret ? 'password' : 'textarea'" :show-password="question.isSecret" :rows="question.isSecret ? 1 : 3" :placeholder="question.isOther ? '请输入其他方案…' : '请输入回答…'" :aria-label="question.question" @update:model-value="setOther(question.id, String($event))" />
        <div v-if="question.isSecret" class="secret-hint"><Lock :size="13" /> 敏感答案仅传递给 App Server，不会保存到消息、事件或审计正文。</div>
      </section>
      <el-alert v-if="error" type="error" :closable="false" show-icon>{{ error }}</el-alert>
    </div>
    <template #footer>
      <div class="input-dialog-footer"><el-button :disabled="submitting" @click="cancel"><CircleClose :size="14" /> 取消本轮</el-button><el-button type="primary" :loading="submitting" :disabled="!hasAnswers" @click="submit"><Check :size="14" /> 提交选择</el-button></div>
    </template>
  </el-dialog>
</template>
