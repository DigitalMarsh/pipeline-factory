import type { ExplorerInputRequest } from "../types";

export type ExplorerInputProgress = {
  requestId: string;
  currentIndex: number;
  values: Record<string, string[]>;
  otherValues: Record<string, string>;
};

export type ExplorerInputProgressScope = {
  projectId: string;
  threadId: string;
  explorerPlanId: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_PREFIX = "pipeline-factory:explorer-input-progress:v1:";

function getSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function explorerInputProgressDraftKey(scope: ExplorerInputProgressScope, requestId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(`${scope.projectId}:${scope.threadId}:${scope.explorerPlanId}:${requestId}`);
}

function publicQuestionIds(request: ExplorerInputRequest): Set<string> {
  return new Set(request.questions.filter((question) => !question.isSecret).map((question) => question.id));
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Store only non-secret answers in this browser tab so an accidental refresh does not erase the draft. */
export function saveExplorerInputProgressDraft(
  scope: ExplorerInputProgressScope,
  request: ExplorerInputRequest,
  progress: ExplorerInputProgress,
  storage: StorageLike | null = getSessionStorage(),
): void {
  if (!storage || request.id !== progress.requestId) return;
  const allowedIds = publicQuestionIds(request);
  const values: Record<string, string[]> = {};
  const otherValues: Record<string, string> = {};
  for (const questionId of allowedIds) {
    values[questionId] = safeStringArray(progress.values[questionId]);
    if (typeof progress.otherValues[questionId] === "string") otherValues[questionId] = progress.otherValues[questionId]!;
  }
  try {
    storage.setItem(explorerInputProgressDraftKey(scope, request.id), JSON.stringify({
      requestId: request.id,
      currentIndex: Number.isInteger(progress.currentIndex) ? progress.currentIndex : 0,
      values,
      otherValues,
    }));
  } catch {
    // Storage can be disabled or full; the in-memory draft still works for this page.
  }
}

/** Restore a validated, request-scoped draft. Secret answers are always blank after a refresh. */
export function loadExplorerInputProgressDraft(
  scope: ExplorerInputProgressScope,
  request: ExplorerInputRequest,
  storage: StorageLike | null = getSessionStorage(),
): ExplorerInputProgress | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(explorerInputProgressDraftKey(scope, request.id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (value.requestId !== request.id) return null;
    const allowedIds = publicQuestionIds(request);
    const savedValues = value.values && typeof value.values === "object" ? value.values as Record<string, unknown> : {};
    const savedOtherValues = value.otherValues && typeof value.otherValues === "object" ? value.otherValues as Record<string, unknown> : {};
    const values: Record<string, string[]> = {};
    const otherValues: Record<string, string> = {};
    for (const questionId of allowedIds) {
      values[questionId] = safeStringArray(savedValues[questionId]);
      if (typeof savedOtherValues[questionId] === "string") otherValues[questionId] = savedOtherValues[questionId] as string;
    }
    const maxIndex = Math.max(0, request.questions.length - 1);
    const requestedIndex = typeof value.currentIndex === "number" && Number.isFinite(value.currentIndex) ? Math.trunc(value.currentIndex) : 0;
    return { requestId: request.id, currentIndex: Math.max(0, Math.min(maxIndex, requestedIndex)), values, otherValues };
  } catch {
    return null;
  }
}

export function clearExplorerInputProgressDraft(
  scope: ExplorerInputProgressScope,
  requestId: string,
  storage: StorageLike | null = getSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(explorerInputProgressDraftKey(scope, requestId));
  } catch {
    // Ignore unavailable storage; terminal request state remains the source of truth.
  }
}
