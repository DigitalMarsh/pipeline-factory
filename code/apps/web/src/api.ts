import type { AgentLoop, AgentLoopStep, CodexRateLimitsStatus, ExecutionThread, ExplorerActivityItem, ExplorerInputRequest, ExplorerThread, ExplorerTurn, MergeRequest, Plan, Run, ToolCall, VerificationRun } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
  if (init?.body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; model: string }>("/health"),
  agentLoopTools: (loopId: string) => request<{ items: ToolCall[] }>("/api/v4/agent-loops/" + encodeURIComponent(loopId) + "/tools"),
  codexRateLimits: () => request<{ rateLimits: CodexRateLimitsStatus }>("/api/v4/codex/rate-limits"),
  explorers: (projectId: string) => request<{ items: ExplorerThread[] }>(`/api/v4/projects/${projectId}/explorers`),
  createExplorer: (projectId: string, title?: string, originThreadId?: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers`, { method: "POST", body: JSON.stringify({ ...(title ? { title } : {}), ...(originThreadId ? { originThreadId } : {}) }) }),
  explorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}`),
  archiveExplorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/archive`, { method: "POST" }),
  activateExplorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/activate`, { method: "POST" }),
  renameExplorer: (projectId: string, explorerId: string, title: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  explorerActivity: (projectId: string, explorerId: string) => request<{ items: ExplorerActivityItem[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/activity`),
  explorerPlans: (projectId: string, explorerId: string, query = "") => request<{ items: Plan[]; nextCursor: string | null }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/plans${query}`),
  explorerCandidate: (projectId: string, explorerId: string) => request<{ plan: Plan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/candidate`),
  createExplorerCandidate: (projectId: string, explorerId: string, title: string) => request<{ plan: Plan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/candidate`, { method: "POST", body: JSON.stringify({ title }) }),
  thread: (projectId: string) => request<{ thread: ExplorerThread }>(`/api/v3/projects/${projectId}/explorer-thread`),
  turns: (projectId: string) => request<{ items: ExplorerTurn[] }>(`/api/v3/projects/${projectId}/explorer-thread/turns`),
  sendTurn: (projectId: string, content: string) => request<{ turn: { user: ExplorerTurn; assistant: ExplorerTurn } }>(`/api/v3/projects/${projectId}/explorer-thread/turns`, { method: "POST", body: JSON.stringify({ content }) }),
  startExplorerTurn: (projectId: string, threadId: string, content: string, clientTurnId: string) => request<{ turn: { user: ExplorerTurn; assistant: ExplorerTurn }; eventsUrl: string; loopId: string; state: string }>(`/api/v4/projects/${projectId}/explorer-thread/turns`, { method: "POST", body: JSON.stringify({ threadId, content, clientTurnId }) }),
  explorerTurnsV4: (projectId: string, threadId: string) => request<{ items: ExplorerTurn[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorer-thread/turns?threadId=${encodeURIComponent(threadId)}`),
  explorerAgentLoops: (projectId: string, threadId: string) => request<{ items: AgentLoop[] }>(`/api/v4/projects/${projectId}/explorer-thread/agent-loops?threadId=${encodeURIComponent(threadId)}`),
  inputRequests: (projectId: string, threadId: string, status?: string) => request<{ items: ExplorerInputRequest[] }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests?threadId=${encodeURIComponent(threadId)}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  answerInput: (projectId: string, requestId: string, answers: Record<string, { answers: string[] }>, clientRequestId: string, actorId = "local-user") => request<{ request: ExplorerInputRequest; turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests/${requestId}/answer`, { method: "POST", body: JSON.stringify({ answers, clientRequestId, actorId }) }),
  cancelExplorerTurn: (projectId: string, threadId: string, turnId: string, reason = "user_cancelled") => request<{ turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/turns/${turnId}/cancel`, { method: "POST", body: JSON.stringify({ threadId, reason }) }),
  explorerEventsUrl: (projectId: string, threadId: string, afterSequence?: number) => `/api/v4/projects/${projectId}/explorer-thread/events?threadId=${encodeURIComponent(threadId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  agentLoopEventsUrl: (loopId: string) => `/api/v4/agent-loops/${encodeURIComponent(loopId)}/events`,
  agentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}`),
  agentLoopSteps: (loopId: string) => request<{ items: AgentLoopStep[] }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/steps`),
  pauseAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/pause`, { method: "POST", body: JSON.stringify({ reason }) }),
  resumeAgentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/resume`, { method: "POST" }),
  cancelAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  candidate: (projectId: string) => request<{ plan: Plan }>(`/api/v3/projects/${projectId}/explorer-thread/candidate`),
  createCandidate: (projectId: string, title: string) => request<{ plan: Plan }>(`/api/v3/projects/${projectId}/explorer-thread/candidate`, { method: "POST", body: JSON.stringify({ title }) }),
  plans: (projectId: string, query = "") => request<{ items: Plan[]; nextCursor: string | null }>(`/api/v3/projects/${projectId}/explorer-thread/plans${query}`),
  plan: (planId: string) => request<{ plan: Plan }>(`/api/v3/plans/${planId}`),
  confirm: (planId: string) => request<{ plan: Plan }>(`/api/v3/plans/${planId}/confirm`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  enqueue: (planId: string) => request<{ plan: Plan }>(`/api/v3/plans/${planId}/enqueue`, { method: "POST" }),
  startRun: (planId: string) => request<{ run: Run }>(`/api/v3/plans/${planId}/run`, { method: "POST" }),
  run: (runId: string) => request<{ run: Run; executionThread: ExecutionThread | null; verification: VerificationRun | null; mergeRequest: MergeRequest | null }>(`/api/v3/runs/${runId}`),
  pauseRun: (runId: string) => request<{ run: Run; thread: ExecutionThread }>(`/api/v3/runs/${runId}/pause`, { method: "POST" }),
  resumeRun: (runId: string) => request<{ run: Run; thread: ExecutionThread }>(`/api/v3/runs/${runId}/resume`, { method: "POST" }),
  addGuidance: (runId: string, content: string) => request<{ thread: ExecutionThread }>(`/api/v3/runs/${runId}/guidance`, { method: "POST", body: JSON.stringify({ content }) }),
  verifyRun: (runId: string) => request<{ verification: VerificationRun }>(`/api/v3/runs/${runId}/verify`, { method: "POST" }),
  createMergeRequest: (runId: string, sourceCommit: string) => request<{ mergeRequest: MergeRequest }>(`/api/v3/runs/${runId}/merge-request`, { method: "POST", body: JSON.stringify({ sourceCommit }) }),
  confirmMerged: (mergeRequestId: string, targetCommit: string) => request<{ mergeRequest: MergeRequest }>(`/api/v3/merge-requests/${mergeRequestId}/confirm-merged`, { method: "POST", body: JSON.stringify({ targetCommit }) }),
  hooks: (projectId: string) => request<{ projectId: string; lifecycle: { start?: { commandId: string; enabled?: boolean; timeoutMs?: number }; cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number } } }>(`/api/v3/projects/${projectId}/settings/hooks`),
  saveHooks: (projectId: string, lifecycle: Record<string, unknown>) => request<{ projectId: string; lifecycle: Record<string, unknown> }>(`/api/v3/projects/${projectId}/settings/hooks`, { method: "PUT", body: JSON.stringify(lifecycle) }),
};
