import type { ExecutionThread, ExplorerThread, ExplorerTurn, MergeRequest, Plan, Run, VerificationRun } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
  if (init?.body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  thread: (projectId: string) => request<{ thread: ExplorerThread }>(`/api/v3/projects/${projectId}/explorer-thread`),
  turns: (projectId: string) => request<{ items: ExplorerTurn[] }>(`/api/v3/projects/${projectId}/explorer-thread/turns`),
  sendTurn: (projectId: string, content: string) => request<{ turn: { user: ExplorerTurn; assistant: ExplorerTurn } }>(`/api/v3/projects/${projectId}/explorer-thread/turns`, { method: "POST", body: JSON.stringify({ content }) }),
  candidate: (projectId: string) => request<{ plan: Plan }>(`/api/v3/projects/${projectId}/explorer-thread/candidate`),
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
