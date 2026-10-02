/**
 * 模块职责：集中封装 Web 调用 API 的请求、错误转换和 SSE 连接。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { AgentLoop, AgentLoopStep, DailyActivity, ExecutionThread, ExplorerActivityItem, ExplorerInputRequest, ExplorerPlan, ExplorerThread, ExplorerTurn, MergeRequest, ModelBackendsResponse, Plan, PlanDetail, PlanDispatchState, PlanRevisionDraft, Project, ProjectCatalogItem, ProjectExecutionThread, ProjectExecutionThreadSnapshot, ProjectSummary, Run, ToolCall, VerificationRun, WorkbenchSnapshot, WorkbenchEvent } from "./types";

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
  health: () => request<{ status: string; model: string; modelBackend?: string; modelBackends?: { explorer: string; executor: string } }>("/health"),
  modelBackends: () => request<ModelBackendsResponse>("/api/v4/model-backends"),
  /**
   * 让**本地 API** 弹系统"选择文件夹"对话框，拿回本机绝对路径。浏览器自己做不到：
   * `showDirectoryPicker()` 只有目录句柄、`<input webkitdirectory>` 只有相对路径。
   * `cancelled: true` 是用户在对话框里点了取消——**正常结果**，调用方什么都不该做。
   */
  selectDirectory: () => request<{ cancelled: boolean; path: string | null }>("/api/v4/dialogs/select-directory", { method: "POST" }),
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
  projectExecutionThread: (projectId: string) => request<ProjectExecutionThreadSnapshot>(`/api/v4/projects/${encodeURIComponent(projectId)}/execution-thread`),
  updateProjectExecutionPreferences: (projectId: string, preferences: { model: string | null; reasoningEffort: string | null }) => request<{ thread: ProjectExecutionThread }>(`/api/v4/projects/${encodeURIComponent(projectId)}/execution-thread/preferences`, { method: "PATCH", body: JSON.stringify(preferences) }),
  submitProjectExecutionTurn: (projectId: string, content: string, clientTurnId: string) => request<{ thread: ProjectExecutionThread; user: ProjectExecutionThreadSnapshot["messages"][number]; assistant: ProjectExecutionThreadSnapshot["messages"][number] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/execution-thread/turns`, { method: "POST", body: JSON.stringify({ content, clientTurnId }) }),
  cancelProjectExecutionTurn: (projectId: string, messageId: string) => request<{ message: ProjectExecutionThreadSnapshot["messages"][number] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/execution-thread/turns/${encodeURIComponent(messageId)}/cancel`, { method: "POST" }),
  projectExecutionEventsUrl: (projectId: string, afterSequence?: number) => `/api/v4/projects/${encodeURIComponent(projectId)}/execution-thread/events${afterSequence === undefined ? "" : `?afterSequence=${afterSequence}`}`,
  workbench: (projectId: string) => request<WorkbenchSnapshot>(`/api/v4/workbench?projectId=${encodeURIComponent(projectId)}`),
  /** 项目「今日活动」：执行完成 / 已合并 / 失败或阻塞 / 跨日仍在跑。date 缺省是服务器本地今天。 */
  projectActivity: (projectId: string, date?: string) => request<DailyActivity>(`/api/v4/projects/${encodeURIComponent(projectId)}/activity${date ? `?date=${encodeURIComponent(date)}` : ""}`),
  workbenchEventsUrl: (projectId: string, afterSequence?: number) => `/api/v4/workbench/events?format=sse&projectId=${encodeURIComponent(projectId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  workbenchEvents: (projectId: string, afterSequence?: number) => request<{ items: WorkbenchEvent[]; cursor: number }>(`/api/v4/workbench/events?projectId=${encodeURIComponent(projectId)}&afterSequence=${afterSequence ?? 0}`),
  agentLoopTools: (loopId: string) => request<{ items: ToolCall[] }>("/api/v4/agent-loops/" + encodeURIComponent(loopId) + "/tools"),
  explorerPlanRequirements: () => request<{ requirements: { requirementsVersion: number; schemaVersion: number; areas: Array<{ key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] }>; artifactModes: Array<{ mode: "CONVERSATION" | "REPOSITORY_FILE"; label: string; includePaths: string; verificationMode: string; executable: boolean }>; factoryOwnedFields: string[] } }>("/api/v4/explorer-plan-requirements"),
  explorers: (projectId: string) => request<{ items: ExplorerThread[] }>(`/api/v4/projects/${projectId}/explorers`),
  createExplorer: (projectId: string, title?: string, originThreadId?: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers`, { method: "POST", body: JSON.stringify({ ...(title ? { title } : {}), ...(originThreadId ? { originThreadId } : {}) }) }),
  explorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}`),
  deleteExplorer: (projectId: string, explorerId: string) => request<{ deletedExplorerId: string; replacementExplorer: ExplorerThread; project: Project; deleted: { taskCount: number; planCount: number; runCount: number } }>(`/api/v4/projects/${encodeURIComponent(projectId)}/explorers/${encodeURIComponent(explorerId)}`, { method: "DELETE" }),
  archiveExplorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/archive`, { method: "POST" }),
  activateExplorer: (projectId: string, explorerId: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/activate`, { method: "POST" }),
  renameExplorer: (projectId: string, explorerId: string, title: string) => request<{ explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  explorerActivity: (projectId: string, explorerId: string, explorerPlanId: string) => request<{ items: ExplorerActivityItem[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/activity?explorerPlanId=${encodeURIComponent(explorerPlanId)}`),
  explorerPlanGroups: (projectId: string, explorerId: string) => request<{ items: ExplorerPlan[] }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/explorer-plans`),
  createExplorerPlan: (projectId: string, explorerId: string) => request<{ explorerPlan: ExplorerPlan; explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/explorer-plans`, { method: "POST" }),
  explorerPlanWorkspace: (projectId: string, explorerId: string, explorerPlanId: string) => request<{ explorerPlan: ExplorerPlan; turns: ExplorerTurn[]; activity: ExplorerActivityItem[]; inputRequests: ExplorerInputRequest[]; candidate: Plan | null; revisionDraft: PlanRevisionDraft | null; loops: AgentLoop[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/explorer-plans/${encodeURIComponent(explorerPlanId)}/workspace`),
  renameExplorerPlan: (projectId: string, explorerId: string, explorerPlanId: string, title: string) => request<{ explorerPlan: ExplorerPlan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/explorer-plans/${encodeURIComponent(explorerPlanId)}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  activateExplorerPlan: (projectId: string, explorerId: string, explorerPlanId: string) => request<{ explorerPlan: ExplorerPlan; explorer: ExplorerThread }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/explorer-plans/${encodeURIComponent(explorerPlanId)}/activate`, { method: "POST" }),
  explorerPlans: (projectId: string, explorerId: string, query = "") => request<{ items: Plan[]; nextCursor: string | null }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/plans${query}`),
  explorerConfirmedPlans: (projectId: string, explorerId: string) => request<{ items: Plan[] }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/confirmed-plans`),
  explorerThreadPlans: (projectId: string, explorerId: string) => request<{ items: Plan[] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/explorers/${encodeURIComponent(explorerId)}/all-plans`),
  selectCandidatePlan: (projectId: string, explorerId: string, explorerPlanId: string, planId: string | null) => request<{ explorerPlan: ExplorerPlan }>(`/api/v4/projects/${encodeURIComponent(projectId)}/explorers/${encodeURIComponent(explorerId)}/explorer-plans/${encodeURIComponent(explorerPlanId)}/selected-plan`, { method: "POST", body: JSON.stringify({ planId }) }),
  explorerCandidate: (projectId: string, explorerId: string, explorerPlanId?: string) => request<{ plan: Plan }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/candidate${explorerPlanId ? `?explorerPlanId=${encodeURIComponent(explorerPlanId)}` : ""}`),
  explorerRevisionDraft: (projectId: string, explorerId: string) => request<{ draft: PlanRevisionDraft }>(`/api/v4/projects/${projectId}/explorers/${encodeURIComponent(explorerId)}/revision-draft`),
  startExplorerTurn: (projectId: string, threadId: string, content: string, clientTurnId: string, explorerPlanId: string) => request<{ turn: { user: ExplorerTurn; assistant: ExplorerTurn }; eventsUrl: string; loopId: string | null; state: string }>(`/api/v4/projects/${projectId}/explorer-thread/turns`, { method: "POST", body: JSON.stringify({ threadId, content, clientTurnId, explorerPlanId }) }),
  getExplorerTurns: (projectId: string, threadId: string, explorerPlanId: string) => request<{ items: ExplorerTurn[]; lastEventSequence: number }>(`/api/v4/projects/${projectId}/explorer-thread/turns?threadId=${encodeURIComponent(threadId)}&explorerPlanId=${encodeURIComponent(explorerPlanId)}`),
  explorerAgentLoops: (projectId: string, threadId: string, explorerPlanId: string) => request<{ items: AgentLoop[] }>(`/api/v4/projects/${projectId}/explorer-thread/agent-loops?threadId=${encodeURIComponent(threadId)}&explorerPlanId=${encodeURIComponent(explorerPlanId)}`),
  inputRequests: (projectId: string, threadId: string, explorerPlanId: string, status?: string) => request<{ items: ExplorerInputRequest[] }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests?threadId=${encodeURIComponent(threadId)}&explorerPlanId=${encodeURIComponent(explorerPlanId)}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  answerInput: (projectId: string, requestId: string, answers: Record<string, { answers: string[] }>, clientRequestId: string, actorId = "local-user") => request<{ request: ExplorerInputRequest; turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/input-requests/${requestId}/answer`, { method: "POST", body: JSON.stringify({ answers, clientRequestId, actorId }) }),
  cancelExplorerTurn: (projectId: string, threadId: string, turnId: string, reason = "user_cancelled") => request<{ turn: ExplorerTurn }>(`/api/v4/projects/${projectId}/explorer-thread/turns/${turnId}/cancel`, { method: "POST", body: JSON.stringify({ threadId, reason }) }),
  explorerEventsUrl: (projectId: string, threadId: string, explorerPlanId: string, afterSequence?: number) => `/api/v4/projects/${projectId}/explorer-thread/events?threadId=${encodeURIComponent(threadId)}&explorerPlanId=${encodeURIComponent(explorerPlanId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  explorerRequirementStatusEventsUrl: (projectId: string, threadId: string, afterSequence?: number) => `/api/v4/projects/${projectId}/explorer-thread/requirement-status/events?threadId=${encodeURIComponent(threadId)}${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  agentLoopEventsUrl: (loopId: string) => `/api/v4/agent-loops/${encodeURIComponent(loopId)}/events`,
  runEventsUrl: (runId: string, afterSequence?: number) => `/api/v4/runs/${encodeURIComponent(runId)}/events?format=sse${afterSequence === undefined ? "" : `&afterSequence=${afterSequence}`}`,
  agentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}`),
  agentLoopSteps: (loopId: string) => request<{ items: AgentLoopStep[] }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/steps`),
  pauseAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/pause`, { method: "POST", body: JSON.stringify({ reason }) }),
  resumeAgentLoop: (loopId: string) => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/resume`, { method: "POST" }),
  cancelAgentLoop: (loopId: string, reason = "user_requested") => request<{ loop: AgentLoop }>(`/api/v4/agent-loops/${encodeURIComponent(loopId)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
  plans: (projectId: string, query = "") => request<{ items: Plan[]; nextCursor: string | null }>(`/api/v4/projects/${projectId}/plans${query}`),
  candidatePlans: (projectId: string) => request<{ items: Plan[] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/candidate-plans`),
  projectTasks: (projectId: string) => request<{ items: Plan[] }>(`/api/v4/projects/${encodeURIComponent(projectId)}/tasks`),
  reconcileProjectMerges: (projectId: string) => request<{ projectId: string; checkedAt: string; items: Array<{ runId: string; planId: string; outcome: "DETECTED" | "ALREADY_OPEN" | "NOT_MERGED" | "UNAVAILABLE" | "ALREADY_MERGED"; mergeRequest: MergeRequest | null; sourceCommit: string | null; targetBranch: string | null; targetCommit: string | null; reason: string | null }> }>(`/api/v4/projects/${encodeURIComponent(projectId)}/merge-reconciliation`, { method: "POST" }),
  getPlan: (planId: string) => request<PlanDetail>(`/api/v4/plans/${planId}`),
  candidatePlanVersions: (planId: string) => request<{ planId: string; latestRevision: number; items: Array<Plan & { isLatest: boolean; readOnly: boolean }> }>(`/api/v4/plans/${encodeURIComponent(planId)}/candidate-versions`),
  getCandidatePlanVersion: (planId: string, revision: number) => request<{ planId: string; latestRevision: number; version: Plan; readOnly: boolean }>(`/api/v4/plans/${encodeURIComponent(planId)}/candidate-versions/${revision}`),
  getPlanRevision: (planId: string, revision: number) => request<{ planId: string; revision: { revision: number; contract: Plan["contract"]; resolvedContract?: Plan["resolvedContract"] }; runs: Run[] }>(`/api/v4/plans/${encodeURIComponent(planId)}/revisions/${revision}`),
  planRevisions: (planId: string) => request<{ plan: Plan; items: Array<{ planId: string; revision: number; confirmedAt: string; artifactHash: string }>; drafts: PlanRevisionDraft[] }>(`/api/v4/plans/${encodeURIComponent(planId)}/revisions`),
  createRevisionDraft: (planId: string, fromRevision: number, input: { explorerThreadId: string; discardUnmergedRun: boolean; clientRequestId: string }) => request<{ draft: PlanRevisionDraft; explorerThread: ExplorerThread }>(`/api/v4/plans/${encodeURIComponent(planId)}/revisions/${fromRevision}/drafts`, { method: "POST", body: JSON.stringify({ fromRevision, ...input }) }),
  confirmRevisionDraft: (planId: string, draftId: string) => request<{ plan: Plan; run?: Run | null; dispatch?: PlanDispatchState | null; confirmation?: { stage: string; attempt: number; retryable: boolean } }>(`/api/v4/plans/${encodeURIComponent(planId)}/revision-drafts/${encodeURIComponent(draftId)}/confirm`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  discardRevisionDraft: (planId: string, draftId: string) => request<{ draft: PlanRevisionDraft }>(`/api/v4/plans/${encodeURIComponent(planId)}/revision-drafts/${encodeURIComponent(draftId)}/discard`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  confirmPlan: (planId: string, revision?: number) => request<{ plan: Plan; run: Run | null; dispatch: PlanDispatchState | null; confirmation: { stage: string; attempt: number; retryable: boolean } }>(revision === undefined ? `/api/v4/plans/${encodeURIComponent(planId)}/confirm` : `/api/v4/plans/${encodeURIComponent(planId)}/revisions/${revision}/confirm`, { method: "POST", body: JSON.stringify({ actorId: "local-user", ...(revision === undefined ? {} : { revision }) }) }),
  discardPlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/discard`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  enqueuePlan: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/enqueue`, { method: "POST" }),
  enqueuePlanRevision: (planId: string, revision: number) => request<{ plan: Plan }>(`/api/v4/plans/${encodeURIComponent(planId)}/revisions/${revision}/enqueue`, { method: "POST" }),
  revisePlanConfiguration: (planId: string) => request<{ plan: Plan }>(`/api/v4/plans/${planId}/revise-configuration`, { method: "POST", body: JSON.stringify({ actorId: "local-user" }) }),
  startPlanRun: (planId: string) => request<{ plan: Plan; run: Run | null; dispatch: PlanDispatchState | null }>(`/api/v4/plans/${planId}/run`, { method: "POST" }),
  /** 按 tag 重挑验证子集；空数组 = 回到项目默认全集。命令 ID 仍由 Factory 解析。 */
  updatePlanVerificationSuites: (planId: string, suites: string[]) => request<{ plan: Plan }>(`/api/v4/plans/${encodeURIComponent(planId)}/verification-suites`, { method: "PUT", body: JSON.stringify({ suites, actorId: "local-user" }) }),
  /** 设置前置 Plan。Factory-owned 字段：模型不能填，只能由人从同项目的 Plan 里挑。 */
  updatePlanDependencies: (planId: string, dependsOnPlanIds: string[]) => request<{ plan: Plan }>(`/api/v4/plans/${encodeURIComponent(planId)}/dependencies`, { method: "PUT", body: JSON.stringify({ dependsOnPlanIds, actorId: "local-user" }) }),
  startPlanRevisionRun: (planId: string, revision: number) => request<{ plan: Plan; run: Run | null; dispatch: PlanDispatchState | null }>(`/api/v4/plans/${encodeURIComponent(planId)}/revisions/${revision}/run`, { method: "POST" }),
  /**
   * Run 详情。`executorConfig` 是"这次 Run 该用哪个 executor"（Revision 快照优先）——
   * 遥测要这一轮跑完才有值，运行中的界面靠它回答"现在用的是什么模型"。
   */
  getRun: (runId: string) => request<{ run: Run; executionThread: ExecutionThread | null; executorConfig: { model: string | null; backend: string | null; reasoningEffort: string | null } | null; verification: VerificationRun | null; mergeRequest: MergeRequest | null }>(`/api/v4/runs/${encodeURIComponent(runId)}`),
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
