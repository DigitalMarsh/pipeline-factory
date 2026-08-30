/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerInputRequest, ModelInputQuestion } from "../types";

export function hasSelectableOptions(question: ModelInputQuestion): boolean {
  return Array.isArray(question.options) && question.options.length > 0;
}

export function hasFreeformInput(question: ModelInputQuestion): boolean {
  return question.isOther || !question.options;
}

/** 将当前题目的选择合并为 Provider 协议答案，并处理 Other 单选约束。 */
export function resolveQuestionAnswers(question: ModelInputQuestion, selectedOptions: string[], otherValue: string): string[] {
  const customValue = otherValue.trim();
  return customValue ? [customValue] : selectedOptions;
}

export function inputQuestionComplete(question: ModelInputQuestion, selectedOptions: string[], otherValue: string): boolean {
  return resolveQuestionAnswers(question, selectedOptions, otherValue).some((answer) => answer.trim());
}

/** 只有所有问题完成才允许最终提交；题目之间切换不会触发半成品提交。 */
export function allInputQuestionsAnswered(questions: ModelInputQuestion[], values: Record<string, string[]>, otherValues: Record<string, string>): boolean {
  return questions.length > 0 && questions.every((question) => inputQuestionComplete(question, values[question.id] ?? [], otherValues[question.id] ?? ""));
}

export function nextInputQuestionIndex(currentIndex: number, questionCount: number): number {
  return Math.min(Math.max(0, questionCount - 1), Math.max(0, currentIndex + 1));
}

export function previousInputQuestionIndex(currentIndex: number): number {
  return Math.max(0, currentIndex - 1);
}

export function inputAnswerLabels(question: ModelInputQuestion, summary: Record<string, unknown> | null): string[] {
  const value = summary?.[question.id];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.secret === true) return ["已隐藏"];
  if (Array.isArray(record.answers)) {
    const labels = record.answers.filter((answer): answer is string => typeof answer === "string" && answer.trim().length > 0).map((answer) => answer.trim());
    if (labels.length > 0) return labels;
  }
  return typeof record.answerCount === "number" && record.answerCount > 0 ? [`已提交 ${record.answerCount} 项`] : [];
}

export function buildInputAnswers(questions: ModelInputQuestion[], values: Record<string, string[]>): Record<string, { answers: string[] }> {
  const ids = new Set(questions.map((question) => question.id));
  for (const id of Object.keys(values)) if (!ids.has(id)) throw new Error(`Unknown question id: ${id}`);
  return Object.fromEntries(questions.map((question) => {
    const answers = (values[question.id] ?? []).map((value) => value.trim()).filter(Boolean);
    if (answers.length === 0) throw new Error(`Answer is required for question ${question.id}`);
    if (question.options) {
      const allowed = new Set(question.options.map((option) => option.label));
      const customAnswers = answers.filter((answer) => !allowed.has(answer));
      if (customAnswers.length > 0 && (!question.isOther || answers.length !== 1)) throw new Error(`Invalid option for question ${question.id}`);
    }
    if (question.isOther && (!question.options || answers.some((answer) => !question.options!.some((option) => option.label === answer))) && answers.length !== 1) throw new Error(`Other answer must contain exactly one value for question ${question.id}`);
    return [question.id, { answers }];
  }));
}

/** 生成可持久化的答案摘要；isSecret 题目只保留数量和 secret 标记。 */
export function redactedAnswerSummary(request: ExplorerInputRequest, values: Record<string, string[]>): Record<string, { answerCount: number; secret: boolean; answers?: string[] }> {
  return Object.fromEntries(request.questions.map((question) => {
    const answers = (values[question.id] ?? []).map((answer) => answer.trim()).filter(Boolean);
    return [question.id, { answerCount: answers.length, secret: question.isSecret, ...(question.isSecret ? {} : { answers }) }];
  }));
}
