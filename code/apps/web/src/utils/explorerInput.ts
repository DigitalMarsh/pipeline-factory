import type { ExplorerInputRequest, ModelInputQuestion } from "../types";

export function hasSelectableOptions(question: ModelInputQuestion): boolean {
  return Array.isArray(question.options) && question.options.length > 0;
}

export function hasFreeformInput(question: ModelInputQuestion): boolean {
  return question.isOther || !question.options;
}

export function resolveQuestionAnswers(question: ModelInputQuestion, selectedOptions: string[], otherValue: string): string[] {
  const customValue = otherValue.trim();
  return customValue ? [customValue] : selectedOptions;
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

export function redactedAnswerSummary(request: ExplorerInputRequest, values: Record<string, string[]>): Record<string, { answerCount: number; secret: boolean }> {
  return Object.fromEntries(request.questions.map((question) => [question.id, { answerCount: (values[question.id] ?? []).length, secret: question.isSecret }]));
}
