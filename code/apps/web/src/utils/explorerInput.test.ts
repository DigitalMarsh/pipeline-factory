/**
 * 测试职责：验证 explorerInput 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { allInputQuestionsAnswered, buildInputAnswers, hasFreeformInput, hasSelectableOptions, inputAnswerDisplayLabels, inputAnswerDisplayText, inputAnswerLabels, inputQuestionComplete, nextInputQuestionIndex, previousInputQuestionIndex, redactedAnswerSummary, resolveQuestionAnswers } from "./explorerInput";
import type { ExplorerInputProgress } from "./explorerInputProgressDraft";
import type { ExplorerInputRequest, ModelInputQuestion } from "../types";

describe("explorer structured input", () => {
  const questions = [
    { id: "choice", header: "Choice", question: "Pick", isOther: false, isSecret: false, options: [{ label: "A", description: "one" }, { label: "B", description: "two" }] },
    { id: "other", header: "Other", question: "Explain", isOther: true, isSecret: false, options: null },
  ];

  it("accepts multiple declared option answers and other text", () => {
    expect(buildInputAnswers(questions, { choice: ["A", "B"], other: ["custom"] })).toEqual({ choice: { answers: ["A", "B"] }, other: { answers: ["custom"] } });
  });

  it("rejects unknown and undeclared option values", () => {
    expect(() => buildInputAnswers(questions, { choice: ["X"], other: ["custom"] })).toThrow("Invalid option");
    expect(() => buildInputAnswers(questions, { choice: ["A"], unknown: ["value"], other: ["custom"] })).toThrow("Unknown question");
  });

  it("keeps secret answers out of the redacted summary", () => {
    const secretQuestion = [{ id: "token", header: "Token", question: "Enter token", isOther: true, isSecret: true, options: null }];
    expect(buildInputAnswers(secretQuestion, { token: ["top-secret"] })).toEqual({ token: { answers: ["top-secret"] } });
    expect(redactedAnswerSummary({ id: "input-1", threadId: "thread-1", localTurnId: "turn-1", providerRequestId: "request-1", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", itemId: "item-1", questions: secretQuestion, isBlocking: true, autoResolutionMs: null, status: "OPEN", createdAt: "2026-01-01T00:00:00.000Z", answeredAt: null, answeredBy: null, redactedAnswerSummary: null }, { token: ["top-secret"] })).toEqual({ token: { answerCount: 1, secret: true } });
  });

  it("returns non-secret labels for the conversation stream and masks secret answers", () => {
    const request = { id: "input-1", threadId: "thread-1", localTurnId: "turn-1", providerRequestId: "request-1", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", itemId: "item-1", questions: [...questions, { id: "token", header: "Token", question: "Enter token", isOther: true, isSecret: true, options: null }], isBlocking: true, autoResolutionMs: null, status: "ANSWERED" as const, createdAt: "2026-01-01T00:00:00.000Z", answeredAt: "2026-01-01T00:01:00.000Z", answeredBy: "local-user", redactedAnswerSummary: { choice: { answerCount: 1, secret: false, answers: ["A"] }, token: { answerCount: 1, secret: true } } };
    expect(inputAnswerLabels(request.questions[0]!, request.redactedAnswerSummary)).toEqual(["A"]);
    expect(inputAnswerLabels(request.questions[2]!, request.redactedAnswerSummary)).toEqual(["已隐藏"]);
  });

  it("keeps declared choices visible when a question also allows other input", () => {
    const question = { id: "choice-with-other", header: "Choice", question: "Pick", isOther: true, isSecret: false, options: [{ label: "A", description: "one" }, { label: "B", description: "two" }] };
    expect(hasSelectableOptions(question)).toBe(true);
    expect(hasFreeformInput(question)).toBe(true);
    expect(resolveQuestionAnswers(question, ["A"], "")).toEqual(["A"]);
    expect(resolveQuestionAnswers(question, ["A"], "custom")).toEqual(["custom"]);
    expect(buildInputAnswers([question], { "choice-with-other": ["A", "B"] })).toEqual({ "choice-with-other": { answers: ["A", "B"] } });
    expect(() => buildInputAnswers([question], { "choice-with-other": ["custom", "B"] })).toThrow("Invalid option");
  });

  it("tracks one active question at a time while requiring the full set before submit", () => {
    expect(inputQuestionComplete(questions[0]!, ["A"], "")).toBe(true);
    expect(inputQuestionComplete(questions[1]!, [], "")).toBe(false);
    expect(allInputQuestionsAnswered(questions, { choice: ["A"], other: [] }, { other: "" })).toBe(false);
    expect(allInputQuestionsAnswered(questions, { choice: ["A"], other: [] }, { other: "custom" })).toBe(true);
    expect(nextInputQuestionIndex(0, questions.length)).toBe(1);
    expect(nextInputQuestionIndex(1, questions.length)).toBe(1);
    expect(previousInputQuestionIndex(1)).toBe(0);
    expect(previousInputQuestionIndex(0)).toBe(0);
  });
});

const question = (overrides: Partial<ModelInputQuestion> = {}): ModelInputQuestion => ({ id: "choice", header: "Choice", question: "Pick", isOther: true, isSecret: false, options: [{ label: "A", description: "one" }, { label: "B", description: "two" }], ...overrides });

const request = (overrides: Partial<ExplorerInputRequest> = {}): ExplorerInputRequest => ({
  id: "input-1",
  threadId: "thread-1",
  localTurnId: "turn-1",
  providerRequestId: "request-1",
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  itemId: "item-1",
  questions: [question()],
  isBlocking: true,
  autoResolutionMs: null,
  status: "OPEN",
  createdAt: "2026-01-01T00:00:00.000Z",
  answeredAt: null,
  answeredBy: null,
  redactedAnswerSummary: null,
  ...overrides,
});

const progress = (overrides: Partial<ExplorerInputProgress> = {}): ExplorerInputProgress => ({ requestId: "input-1", currentIndex: 0, values: {}, otherValues: {}, ...overrides });

describe("答案展示（草稿优先）", () => {
  it("本地草稿优先于服务端已提交答案", () => {
    const withDraft = request({ redactedAnswerSummary: { choice: { answerCount: 1, secret: false, answers: ["A"] } } });

    expect(inputAnswerDisplayLabels(withDraft, question(), progress({ values: { choice: ["B"] } }))).toEqual(["B"]);
  });

  it("草稿属于另一张请求时不借用，回落到服务端答案", () => {
    const withAnswer = request({ redactedAnswerSummary: { choice: { answerCount: 1, secret: false, answers: ["A"] } } });

    expect(inputAnswerDisplayLabels(withAnswer, question(), progress({ requestId: "input-other", values: { choice: ["B"] } }))).toEqual(["A"]);
  });

  it("密钥题的本地草稿也隐藏，不让明文出现在屏幕上", () => {
    const secret = question({ id: "token", isSecret: true, options: null });
    const labels = inputAnswerDisplayLabels(request(), secret, progress({ values: { token: ["top-secret"] } }));

    expect(labels).toEqual(["已隐藏"]);
    expect(labels.join("")).not.toContain("top-secret");
  });

  it("没有草稿也没有答案时返回空数组", () => {
    expect(inputAnswerDisplayLabels(request(), question(), null)).toEqual([]);
    expect(inputAnswerDisplayLabels(request(), question(), progress())).toEqual([]);
  });
});

describe("回答行文案", () => {
  it("有答案就显示答案，哪怕请求还在提交中", () => {
    expect(inputAnswerDisplayText(request({ status: "SUBMITTING" }), question(), progress({ values: { choice: ["A"] } }), "input-1")).toBe("A");
  });

  it("多个答案用顿号连接", () => {
    expect(inputAnswerDisplayText(request({ status: "ANSWERED" }), question(), progress({ values: { choice: ["A", "B"] } }), null)).toBe("A、B");
  });

  it("没答案时按状态给过程文案，本地在途标记优先", () => {
    expect(inputAnswerDisplayText(request({ status: "OPEN" }), question(), null, "input-1")).toBe("提交结果确认中");
    expect(inputAnswerDisplayText(request({ status: "SUBMITTING" }), question(), null, null)).toBe("提交结果确认中");
    expect(inputAnswerDisplayText(request({ status: "RECOVERY_REQUIRED" }), question(), null, null)).toBe("等待恢复");
    expect(inputAnswerDisplayText(request({ status: "ANSWERED" }), question(), null, null)).toBe("已提交");
    expect(inputAnswerDisplayText(request({ status: "AUTO_RESOLVED" }), question(), null, null)).toBe("已提交");
    expect(inputAnswerDisplayText(request({ status: "OPEN" }), question(), null, null)).toBe("尚未选择");
  });

  it("在途标记只对同一张请求生效", () => {
    expect(inputAnswerDisplayText(request({ id: "input-2", status: "OPEN" }), question(), null, "input-1")).toBe("尚未选择");
  });
});
