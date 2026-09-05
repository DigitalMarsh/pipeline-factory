/**
 * 模块职责：集中封装 Web 调用 API 的请求、错误转换和 SSE 连接。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { AgentLoop, AgentLoopStep, CodexRateLimitsStatus, ExecutionThread, ExplorerActivityItem, ExplorerInputRequest, ExplorerThread, ExplorerTurn, MergeRequest, Plan, PlanDispatchState, Project, ProjectCatalogItem, ProjectSummary, Run, ToolCall, VerificationRun, WorkbenchSnapshot, WorkbenchEvent } from "./types";

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** 统一处理 JSON 请求和错误响应，保证页面只依赖稳定的 typed API 方法。 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
  if (init?.body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new ApiRequestError((await response.json().catch(() => null))?.error ?? `Request failed: ${response.status}`, response.status);
  return response.json() as Promise<T>;
}

/**
 * Web 端 API facade。方法按业务域分组，路径拼接集中在此处，避免各页面自行构造 Project/Thread/Run URL。
 */
export const api = {
  health: () => request<{ status: string; model: string }>("/health"),
  projects: (status?: string) => request<{ items: ProjectCatalogItem[] }>(`/api/v4/projects${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  project: (projectId: string) => request<{ project: Project; summary: ProjectSummary }>(`/api/v4/projects/${encodeURIComponent(projectId)}`),
  createProject: (input: { name: string; shortName?: string; repoRoot: string; defaultBranch?: string; worktreeRoot?: string; settings?: Record<string, unknown> }) => request<{ project: Project; explorer: ExplorerThread }>("/api/v4/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (projectId: string, input: Record<string, unknown>) => request<{ project: Project }>(`/api/v4/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  validateRepository: (projectId: string, repoRoot?: string) => request<{ valid: boolean; repoRoot: string; defaultBranch: string }>(`/api/v4/projects/${encodeURIComponent(projectId)}/validate-repository`, { method: "POST", body: JSON.stringify(repoRoot ? { repoRoot } : {}) }),
  archiveProject: (projectId: string) => request<{ project: Project }>(`/api/v4/projects/${encodeURIComponent(projectId)}/archive`, { method: "POST" }),
  activateProject: (projectId: string) => request<{ project: Project }>(`/api/v4/projects/${encodeURIComponent(projectId)}/activate`, { method: "POST" }),
  selectProjectExplorer: (projectId: string, explorerId: string) => request<{ project: Project }>(`/api/v4/projects/${encodeURIComponent(projectId)}/select-explorer`, { method: "POST", body: JSON.stringify({ explorerId }) }),
  projectConfigHistory: (projectId: string) => request<{ items: Array<{ projectId: string; version: number; hash: string; snapshot: Record<string, unknown>; createdAt: string }> }>(`/api/v4/projects/${encodeURIComponent(projectId)}/config-history`),
  projectRuns: (projectId: string) => request<{ items: Run[] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/runs`),
  workbench: (projectId: string) => request<WorkbenchSnapshot>(`/api/v4/workbench?projectId=${encodeURIComponent(projectId)}`),
  workbenchEventsUrl: (projectId: string, afterSequence?: number) => `/api/v4/workbench/events?format=sse&projectId=${encodeURIComponent(projectId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  workbenchEvents: (projectId: string, afterSequence?: number) => request<{ items: WorkbenchEvent[]; cursor: number }>(`/api/v4/workbench/events?projectId=${encodeURIComponent(projectId)}&afterSequence=${afterSequence ?? 0}`),
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
  explorerConfirmedPlans: (projectId: string, explorerId: string) => request<{ items: Plan[] }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/confirmed-plans`),
  explorerCandidate: (projectId: string, explorerId: string) => request<{ plan: Plan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/candidate`),
  createExplorerCandidate: (projectId: string, explorerId: string, title: string) => request<{ plan: Plan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/candidate`, { method: "POST", body: JSON.stringify({ title }) }),
  startExplorerTurn: (projectId: string, threadId: string, content: string, clientTurnId: string) => request<{ turn: { user: ExplorerTurn; assistant: ExplorerTurn }; eventsUrl: string; loopId: string; state: string }>(`/api/v4/projects/${projectId}/explorer-thread/turns`, { method: "POST", body: JSON.stringify({ threadId, content, clientTurnId }) }),
  getExplorerTurns: (projectId: string, threadId: string) => request<{ items: ExplorerTurn[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorer-thread/turns?threadId=${encodeURIComponent(threadId)}`),
  explorerAgentLoops: (projectId: string, threadId: string) => request<{ items: AgentLoop[] }>(`/api/v4/projects/${projectId}/explorer-thread/agent-loops?threadId=${encodeURIComponent(threadId)}`),
  inputRequests: (projectId: string, threadId: string, status?: string) => request<{ items: ExplorerInputRequest[] }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests?threadId=${encodeURIComponent(threadId)}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  answerInput: (projectId: string, requestId: string, answers: Record<string, { answers: string[] }>, clientRequestId: string, actorId = "local-user") => request<{ request: ExplorerInputRequest; turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests/${requestId}/answer`, { method: "POST", body: JSON.stringify({ answers, clientRequestId, actorId }) }),
  cancelExplorerTurn: (projectId: string, threadId: string, turnId: string, reason = "user_cancelled") => request<{ turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/turns/${turnId}/cancel`, { method: "POST", body: JSON.stringify({ threadId, reason }) }),
  explorerEventsUrl: (projectId: string, threadId: string, afterSequence?: number) => `/api/v4/projects/${projectId}/explorer-thread/events?threadId=${encodeURIComponent(threadId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  agentLoopEventsUrl: (loopId: string) => `/api/v4/agent-loops/${encodeURIComponent(loopId)}/events`,
  runEventsUrl: (runId: string, afterSequence?: number) => `/api/v4/runs/${encodeURIComponent(runId)}/events?format=sse${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  agentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}`),
  agentLoopSteps: (loopId: string) => request<{ items: AgentLoopStep[] }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/steps`),
  pauseAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/pause`, { method: "POST", body: JSON.stringify({ reason }) }),
  resumeAgentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/resume`, { method: "POST" }),
  cancelAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  plans: (projectId: string, query = "") => request<{ items: Plan[]; nextCursor: string | null }>(`/api/v4/projects/${projectId}/plans${query}`),
  getPlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}`),
  confirmPlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/confirm`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  discardPlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/discard`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  enqueuePlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/enqueue`, { method: "POST" }),
  startPlanRun: (planId: string) => request<{ plan: Plan; run: Run | null; dispatch: PlanDispatchState | null }>(`/api/v4/plans/${planId}/run`, { method: "POST" }),
  getRun: (runId: string) => request<{ run: Run; executionThread: ExecutionThread | null; verification: VerificationRun | null; mergeRequest: MergeRequest | null }>(`/api/v4/runs/${encodeURIComponent(runId)}`),
  getExecutionThread: (threadId: string) => request<{ thread: ExecutionThread }>(`/api/v4/execution-threads/${threadId}`),
  cancelRun: (runId: string, reason = "user_requested") => request<{ run: Run }>(`/api/v4/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  pauseRun: (runId: string) => request<{ run: Run; thread: ExecutionThread }>(`/api/v4/runs/${runId}/pause`, { method: "POST" }),
  resumeRun: (runId: string) => request<{ run: Run; thread: ExecutionThread }>(`/api/v4/runs/${runId}/resume`, { method: "POST" }),
  addRunGuidance: (runId: string, content: string) => request<{ thread: ExecutionThread }>(`/api/v4/runs/${runId}/guidance`, { method: "POST", body: JSON.stringify({ content }) }),
  verifyRun: (runId: string) => request<{ verification: VerificationRun }>(`/api/v4/runs/${runId}/verify`, { method: "POST" }),
  createMergeRequest: (runId: string, sourceCommit: string) => request<{ mergeRequest: MergeRequest }>(`/api/v4/runs/${runId}/merge-request`, { method: "POST", body: JSON.stringify({ sourceCommit }) }),
  getMergeRequest: (mergeRequestId: string) => request<{ mergeRequest: MergeRequest }>(`/api/v4/merge-requests/${mergeRequestId}`),
  confirmMerged: (mergeRequestId: string, targetCommit: string) => request<{ mergeRequest: MergeRequest }>(`/api/v4/merge-requests/${mergeRequestId}/confirm-merged`, { method: "POST", body: JSON.stringify({ targetCommit }) }),
  getProjectHooks: (projectId: string) => request<{ projectId: string; lifecycle: { start?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number }; cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number } } }>(`/api/v4/projects/${projectId}/settings/hooks`),
  saveProjectHooks: (projectId: string, lifecycle: Record<string, unknown>) => request<{ projectId: string; lifecycle: Record<string, unknown> }>(`/api/v4/projects/${projectId}/settings/hooks`, { method: "PUT", body: JSON.stringify(lifecycle) }),
};
