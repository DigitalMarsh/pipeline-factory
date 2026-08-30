import { describe, expect, it } from "vitest";
import { allInputQuestionsAnswered, buildInputAnswers, hasFreeformInput, hasSelectableOptions, inputAnswerLabels, inputQuestionComplete, nextInputQuestionIndex, previousInputQuestionIndex, redactedAnswerSummary, resolveQuestionAnswers } from "./explorerInput";

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
