/**
 * 模块职责：PipelineStore 的内存实现——测试与轻量集成用的持久化替身。
 *
 * 为什么从 index.ts 抽出来：Store 是领域层的叶子（只依赖记录形状，不依赖任何 Service），
 *   却因为和 5,000 行的 index.ts 同处一个文件而无法单独被审视。搬出来后「Store 的契约」
 *   （store/pipeline-store.ts）、「记录的形状」（store/records.ts）、「两个实现」各自独立，
 *   批 B2c 搬 Sqlite 实现时也不需要再回到 index.ts。
 *
 * 维护提示：
 *   1) **本实现与 SqlitePipelineStore 必须逐方法保持相同的事实与事件语义**。改任何一侧的
 *      写入时机（先写事实还是先追加事件）、错误文案、幂等键格式，都必须同步另一侧——
 *      同一份业务代码在两种存储下跑出不同结果是最难查的一类 bug。
 *   2) savePlan 里的 planQueryProjection 只在 project 与 thread 都还在时才写入（见下方条件）。
 *      这不是优化而是**投影不悬空**的保证：孤儿 Plan 不该出现在 Plan Center 的查询结果里。
 *   3) deleteExplorerCascade 会顺带清掉 idempotency 里指向被删实体（containsAnyString 深扫）
 *      的键。漏掉这一步会让重放旧请求命中指向已删除实体的幂等结果。
 *   4) 本类的 sort 一律显式写比较器（如 listExplorerPlans 按 ordinal 再按 createdAt），
 *      不要依赖 Map 的插入顺序：Sqlite 实现的返回顺序由 ORDER BY 决定，两者必须一致。
 */
import { containsAnyString, defaultExplorerPlan, defaultPlanExploration, defaultThreadContextSummary, threadTitleMetadata } from "./records.js";
import { planQueryProjectionFor, type PlanQueryProjection } from "../plan/query.js";
import { redactAuditPayload, redactAuditText } from "../platform/redaction.js";
import type { EventQuery, PipelineStore } from "./pipeline-store.js";
import { prunableEventIds, type EventPruneInput } from "./event-retention.js";
import type { AgentLoop, AgentLoopStep, AgentLoopStepInput } from "../agent/agent-loop.js";
import type { PlanDispatchState } from "../run/dispatch-coordinator.js";
import type { Project, ProjectConfigRevision } from "../project/project.js";
import type {
  CandidatePlan,
  ChangeProposal,
  DomainEvent,
  ExecutionJournalEntry,
  ExecutionJournalPayload,
  ExecutionThread,
  ExplorerDeletionInput,
  ExplorerDeletionSummary,
  ExplorerInputRequest,
  ExplorerInputRequestStatus,
  ExplorerPlan,
  ExplorerThread,
  ExplorerTurn,
  HookExecution,
  JournalEntryType,
  MergeRequest,
  PersistedToolCall,
  PlanRevisionDraft,
  PlanRevision,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  RegisterThreadInput,
  Run,
  VerificationRun,
} from "../index.js";

/** 用于测试和轻量集成的内存 Store，不改变领域服务的持久化接口。 */
export class InMemoryPipelineStore implements PipelineStore {
  private readonly projects = new Map<string, Project>();
  private readonly projectExecutionThreads = new Map<string, ProjectExecutionThread>();
  private readonly projectExecutionMessages = new Map<string, ProjectExecutionMessage[]>();
  private readonly projectConfigRevisions = new Map<string, ProjectConfigRevision[]>();
  private readonly explorerPlans = new Map<string, ExplorerPlan>();
  private readonly plans = new Map<string, CandidatePlan>();
  private readonly candidateVersions = new Map<string, CandidatePlan>();
  private readonly dispatchStates = new Map<string, PlanDispatchState>();
  private readonly revisions = new Map<string, PlanRevision>();
  private readonly revisionDrafts = new Map<string, PlanRevisionDraft>();
  private readonly changeProposals = new Map<string, ChangeProposal>();
  private readonly runs = new Map<string, Run>();
  private readonly executionThreads = new Map<string, ExecutionThread>();
  private readonly hookExecutions = new Map<string, HookExecution>();
  private readonly planQueryProjections = new Map<string, PlanQueryProjection>();
  private readonly verificationRuns = new Map<string, VerificationRun>();
  private readonly mergeRequests = new Map<string, MergeRequest>();
  private readonly agentLoops = new Map<string, AgentLoop>();
  private readonly agentLoopSteps = new Map<string, AgentLoopStep[]>();
  private readonly toolCalls = new Map<string, PersistedToolCall>();
  private readonly turns = new Map<string, ExplorerTurn[]>();
  private readonly threads = new Map<string, ExplorerThread>();
  private readonly events: DomainEvent[] = [];
  private readonly inputRequests = new Map<string, ExplorerInputRequest>();
  private readonly idempotency = new Map<string, Record<string, unknown>>();
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  private sequence = 0;
  private eventSequence = 0;

  now(): string {
    this.sequence += 1;
    return new Date(Date.now() + this.sequence).toISOString();
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString(36)}`;
  }

  saveThread(input: RegisterThreadInput): ExplorerThread {
    const createdAt = input.createdAt ?? this.now();
    const title = threadTitleMetadata(input.title, createdAt);
    const thread: ExplorerThread = {
      id: input.id,
      projectId: input.projectId,
      ...title,
      createdAt,
      contextMode: input.contextMode ?? "FRESH",
      originThreadId: input.originThreadId ?? null,
      parentThreadId: input.parentThreadId,
      providerThreadId: input.providerThreadId ?? null,
      state: "ACTIVE",
      messageCount: 0,
      summaryRef: null,
      activeExplorerPlanId: null,
      contextSummary: defaultThreadContextSummary(this.now()),
      lastActivityAt: this.now(),
      exploration: defaultPlanExploration(),
      activeRevisionDraftId: null,
    };
    this.threads.set(thread.id, thread);
    const plan = defaultExplorerPlan(thread, this.nextId("explorer-plan"), 1, thread.lastActivityAt);
    this.explorerPlans.set(plan.id, plan);
    const updated = { ...thread, activeExplorerPlanId: plan.id, contextSummary: { ...thread.contextSummary!, openPlanIds: [plan.id] } };
    this.threads.set(thread.id, updated);
    return updated;
  }

  getThread(id: string): ExplorerThread | undefined {
    return this.threads.get(id);
  }

  listThreads(): ExplorerThread[] {
    return [...this.threads.values()];
  }

  updateThread(thread: ExplorerThread): ExplorerThread { this.threads.set(thread.id, thread); return thread; }
  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan { this.explorerPlans.set(plan.id, plan); return plan; }
  getExplorerPlan(id: string): ExplorerPlan | undefined { return this.explorerPlans.get(id); }
  listExplorerPlans(threadId?: string): ExplorerPlan[] { return [...this.explorerPlans.values()].filter((plan) => !threadId || plan.explorerThreadId === threadId).sort((a, b) => a.ordinal - b.ordinal || a.createdAt.localeCompare(b.createdAt)); }
  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    if (!this.explorerPlans.has(plan.id)) throw new Error(`ExplorerPlan ${plan.id} does not exist`);
    this.explorerPlans.set(plan.id, plan);
    return plan;
  }
  saveProject(project: Project): Project { this.projects.set(project.id, project); return project; }
  getProject(projectId: string): Project | undefined { return this.projects.get(projectId); }
  listProjects(): Project[] { return [...this.projects.values()]; }
  updateProject(project: Project): Project {
    if (!this.projects.has(project.id)) throw new Error(`Project ${project.id} does not exist`);
    this.projects.set(project.id, project);
    return project;
  }
  saveProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread {
    const existing = this.projectExecutionThreads.get(thread.projectId);
    if (existing) return existing;
    this.projectExecutionThreads.set(thread.projectId, thread);
    return thread;
  }
  getProjectExecutionThread(projectId: string): ProjectExecutionThread | undefined { return this.projectExecutionThreads.get(projectId); }
  updateProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread {
    if (!this.projectExecutionThreads.has(thread.projectId)) throw new Error(`Project execution thread for ${thread.projectId} does not exist`);
    this.projectExecutionThreads.set(thread.projectId, thread);
    return thread;
  }
  saveProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage {
    const rows = this.projectExecutionMessages.get(message.threadId) ?? [];
    if (message.clientTurnId) {
      const existing = rows.find((item) => item.role === "user" && item.clientTurnId === message.clientTurnId);
      if (existing) return existing;
    }
    rows.push(message);
    this.projectExecutionMessages.set(message.threadId, rows);
    return message;
  }
  getProjectExecutionMessageByClientTurnId(threadId: string, clientTurnId: string): ProjectExecutionMessage | undefined {
    return (this.projectExecutionMessages.get(threadId) ?? []).find((item) => item.role === "user" && item.clientTurnId === clientTurnId);
  }
  listProjectExecutionMessages(threadId: string): ProjectExecutionMessage[] { return [...(this.projectExecutionMessages.get(threadId) ?? [])].sort((a, b) => a.sequence - b.sequence); }
  updateProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage {
    const rows = this.projectExecutionMessages.get(message.threadId) ?? [];
    const index = rows.findIndex((item) => item.id === message.id);
    if (index < 0) throw new Error(`Project execution message ${message.id} does not exist`);
    rows[index] = message;
    return message;
  }
  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision {
    const revisions = this.projectConfigRevisions.get(revision.projectId) ?? [];
    if (!revisions.some((item) => item.version === revision.version)) revisions.push(revision);
    this.projectConfigRevisions.set(revision.projectId, revisions);
    return revisions.find((item) => item.version === revision.version)!;
  }
  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[] { return [...(this.projectConfigRevisions.get(projectId) ?? [])]; }
  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    const current = this.turns.get(turn.threadId) ?? [];
    current.push(turn);
    this.turns.set(turn.threadId, current);
    return turn;
  }
  updateTurn(turn: ExplorerTurn): ExplorerTurn {
    const current = this.turns.get(turn.threadId) ?? [];
    const index = current.findIndex((item) => item.id === turn.id);
    if (index < 0) throw new Error(`Turn ${turn.id} does not exist`);
    current[index] = turn;
    return turn;
  }
  listTurns(threadId: string): ExplorerTurn[] { return [...(this.turns.get(threadId) ?? [])]; }

  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    const existing = [...this.inputRequests.values()].find((item) => item.providerThreadId === request.providerThreadId && item.providerTurnId === request.providerTurnId && item.providerRequestId === request.providerRequestId);
    if (existing) return existing;
    if (request.isBlocking && [...this.inputRequests.values()].some((item) => item.localTurnId === request.localTurnId && item.isBlocking && item.status === "OPEN")) throw new Error(`Explorer turn ${request.localTurnId} already has an open blocking input request`);
    this.inputRequests.set(request.id, request);
    return request;
  }
  getInputRequest(id: string): ExplorerInputRequest | undefined { return this.inputRequests.get(id); }
  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[] {
    return [...this.inputRequests.values()].filter((request) => request.threadId === threadId && (!status || request.status === status));
  }
  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    if (!this.inputRequests.has(request.id)) throw new Error(`Input request ${request.id} does not exist`);
    this.inputRequests.set(request.id, request);
    return request;
  }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.plans.set(plan.id, plan);
    // 守卫是**外键驱动**的：SQLite 的 plan_query_projection 对 project_id / source_explorer_thread_id
    // 建了 REFERENCES，而 candidate_plans 自己没建。内存实现没有外键，这里跟着守卫纯粹是为了
    // 与 SQLite 保持**同一套可观测行为**（同一份业务代码在两种存储下 Plan Center 的可见集合必须相同）。
    // 不要单方面去掉——那正是本仓 C2 契约套件要防的"双实现漂移"。详见 sqlite-store.ts 的 savePlan。
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    return plan;
  }

  getPlan(id: string): CandidatePlan | undefined {
    return this.plans.get(id);
  }

  listPlans(): CandidatePlan[] {
    return [...this.plans.values()];
  }

  updatePlan(plan: CandidatePlan): CandidatePlan {
    if (!this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} does not exist`);
    }
    this.plans.set(plan.id, plan);
    // 与 savePlan 同一条外键驱动的守卫，理由见那里。
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    return plan;
  }

  saveCandidateVersion(plan: CandidatePlan): CandidatePlan {
    const key = `${plan.id}:${plan.revision}`;
    if (!this.candidateVersions.has(key)) this.candidateVersions.set(key, structuredClone(plan));
    return this.candidateVersions.get(key)!;
  }

  listCandidateVersions(planId: string): CandidatePlan[] {
    return [...this.candidateVersions.values()].filter((plan) => plan.id === planId).sort((a, b) => a.revision - b.revision);
  }

  saveDispatchState(state: PlanDispatchState): PlanDispatchState {
    this.dispatchStates.set(state.planId, state);
    return state;
  }

  deleteDispatchState(planId: string): void {
    this.dispatchStates.delete(planId);
  }

  getDispatchState(planId: string): PlanDispatchState | undefined {
    return this.dispatchStates.get(planId);
  }

  listDispatchStates(projectId?: string): PlanDispatchState[] {
    return [...this.dispatchStates.values()]
      .filter((state) => !projectId || state.projectId === projectId)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.planId.localeCompare(b.planId));
  }

  saveRevision(revision: PlanRevision): PlanRevision {
    this.revisions.set(`${revision.planId}:${revision.revision}`, revision);
    return revision;
  }

  getRevision(planId: string, revision: number): PlanRevision | undefined {
    return this.revisions.get(`${planId}:${revision}`);
  }
  listRevisions(planId: string): PlanRevision[] {
    return [...this.revisions.values()].filter((item) => item.planId === planId).sort((a, b) => a.revision - b.revision);
  }
  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    const active = this.listRevisionDrafts(draft.planId).find((item) => (item.status === "EDITING" || item.status === "READY_TO_CONFIRM" || item.status === "BASE_CHANGED") && item.draftId !== draft.draftId);
    if (active) throw new Error(`Plan ${draft.planId} already has active RevisionDraft ${active.draftId}`);
    this.revisionDrafts.set(draft.draftId, draft);
    return draft;
  }
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined { return this.revisionDrafts.get(draftId); }
  listRevisionDrafts(planId?: string): PlanRevisionDraft[] { return [...this.revisionDrafts.values()].filter((item) => !planId || item.planId === planId).sort((a, b) => a.targetRevision - b.targetRevision || a.createdAt.localeCompare(b.createdAt)); }
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    if (!this.revisionDrafts.has(draft.draftId)) throw new Error(`RevisionDraft ${draft.draftId} does not exist`);
    this.revisionDrafts.set(draft.draftId, draft);
    return draft;
  }

  saveChangeProposal(proposal: ChangeProposal): ChangeProposal {
    if (this.changeProposals.has(proposal.id)) return this.changeProposals.get(proposal.id)!;
    this.changeProposals.set(proposal.id, proposal);
    return proposal;
  }
  getChangeProposal(id: string): ChangeProposal | undefined { return this.changeProposals.get(id); }
  listChangeProposals(runId?: string): ChangeProposal[] { return [...this.changeProposals.values()].filter((proposal) => !runId || proposal.runId === runId); }
  updateChangeProposal(proposal: ChangeProposal): ChangeProposal {
    if (!this.changeProposals.has(proposal.id)) throw new Error(`ChangeProposal ${proposal.id} does not exist`);
    this.changeProposals.set(proposal.id, proposal);
    return proposal;
  }

  saveRun(run: Run): Run { this.runs.set(run.id, run); return run; }
  getRun(runId: string): Run | undefined { return this.runs.get(runId); }
  listRuns(): Run[] { return [...this.runs.values()]; }
  saveExecutionThread(thread: ExecutionThread): ExecutionThread {
    const safe = { ...thread, journal: thread.journal.map((entry) => ({ ...entry, payload: redactAuditPayload(entry.payload) as ExecutionJournalPayload })) };
    this.executionThreads.set(thread.id, safe);
    return safe;
  }
  getExecutionThread(threadId: string): ExecutionThread | undefined { return this.executionThreads.get(threadId); }
  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry {
    const thread = this.executionThreads.get(input.executionThreadId);
    if (!thread || thread.runId !== input.runId) throw new Error(`ExecutionThread ${input.executionThreadId} does not belong to Run ${input.runId}`);
    const entry: ExecutionJournalEntry = { sequence: thread.journal.length + 1, type: input.type, occurredAt: input.occurredAt ?? this.now(), payload: redactAuditPayload(input.payload) as ExecutionJournalPayload };
    this.executionThreads.set(thread.id, { ...thread, journal: [...thread.journal, entry] });
    return entry;
  }
  saveHookExecution(execution: HookExecution): HookExecution {
    const safe = { ...execution, stdout: redactAuditText(execution.stdout), stderr: redactAuditText(execution.stderr) };
    const key = `${safe.runId}:${safe.hookType}:${safe.attempt}`;
    if (!this.hookExecutions.has(key)) this.hookExecutions.set(key, safe);
    return this.hookExecutions.get(key)!;
  }
  listHookExecutions(runId?: string): HookExecution[] {
    return [...this.hookExecutions.values()].filter((execution) => !runId || execution.runId === runId).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt);
  }
  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection { this.planQueryProjections.set(projection.planId, projection); return projection; }
  listPlanQueryProjection(projectId?: string): PlanQueryProjection[] {
    return [...this.planQueryProjections.values()].filter((projection) => !projectId || projection.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
  }
  saveVerificationRun(verification: VerificationRun): VerificationRun {
    if (!this.verificationRuns.has(verification.id)) this.verificationRuns.set(verification.id, verification);
    return this.verificationRuns.get(verification.id)!;
  }
  getVerificationRun(runId: string): VerificationRun | undefined { return this.listVerificationRuns(runId).at(-1); }
  listVerificationRuns(runId?: string): VerificationRun[] { return [...this.verificationRuns.values()].filter((verification) => !runId || verification.runId === runId).sort((a, b) => a.completedAt.localeCompare(b.completedAt)); }
  saveMergeRequest(request: MergeRequest): MergeRequest { if (!this.mergeRequests.has(request.id)) this.mergeRequests.set(request.id, request); return this.mergeRequests.get(request.id)!; }
  getMergeRequest(requestId: string): MergeRequest | undefined { return this.mergeRequests.get(requestId); }
  findMergeRequestByRun(runId: string): MergeRequest | undefined { return this.listMergeRequests().find((request) => request.runId === runId); }
  listMergeRequests(): MergeRequest[] { return [...this.mergeRequests.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  updateMergeRequest(request: MergeRequest): MergeRequest { if (!this.mergeRequests.has(request.id)) throw new Error(`MergeRequest ${request.id} does not exist`); this.mergeRequests.set(request.id, request); return request; }

  saveAgentLoop(loop: AgentLoop): AgentLoop { this.agentLoops.set(loop.id, loop); return loop; }
  getAgentLoop(loopId: string): AgentLoop | undefined { return this.agentLoops.get(loopId); }
  listAgentLoops(ownerId?: string): AgentLoop[] { return [...this.agentLoops.values()].filter((loop) => !ownerId || loop.ownerId === ownerId); }
  updateAgentLoop(loop: AgentLoop): AgentLoop {
    if (!this.agentLoops.has(loop.id)) throw new Error(`AgentLoop ${loop.id} does not exist`);
    this.agentLoops.set(loop.id, loop);
    return loop;
  }
  appendAgentLoopStep(input: AgentLoopStepInput): AgentLoopStep {
    const current = this.agentLoopSteps.get(input.loopId) ?? [];
    const step: AgentLoopStep = { ...input, callId: input.callId ?? null, providerThreadId: input.providerThreadId ?? null, providerTurnId: input.providerTurnId ?? null, sequence: current.length + 1, occurredAt: input.occurredAt ?? this.now() };
    current.push(step);
    this.agentLoopSteps.set(input.loopId, current);
    return step;
  }
  listAgentLoopSteps(loopId: string, options: { stepTypes?: readonly string[] } = {}): AgentLoopStep[] {
    const steps = [...(this.agentLoopSteps.get(loopId) ?? [])];
    return options.stepTypes ? steps.filter((step) => options.stepTypes!.includes(step.stepType)) : steps;
  }
  getLastAgentLoopStepSequence(loopId: string): number { return this.agentLoopSteps.get(loopId)?.length ?? 0; }
  recoverAgentLoops(): AgentLoop[] { return this.listAgentLoops().filter((loop) => loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED"); }
  saveToolCall(call: PersistedToolCall): PersistedToolCall { if (!this.toolCalls.has(call.callId)) this.toolCalls.set(call.callId, call); return this.toolCalls.get(call.callId)!; }
  getToolCall(callId: string): PersistedToolCall | undefined { return this.toolCalls.get(callId); }
  listToolCalls(loopId?: string): PersistedToolCall[] { return [...this.toolCalls.values()].filter((call) => !loopId || call.loopId === loopId); }
  updateToolCall(call: PersistedToolCall): PersistedToolCall { if (!this.toolCalls.has(call.callId)) throw new Error(`Tool call ${call.callId} does not exist`); this.toolCalls.set(call.callId, call); return call; }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent {
    const saved: DomainEvent = { ...event, payload: redactAuditPayload(event.payload), id: this.nextId("event"), sequence: ++this.eventSequence, occurredAt: this.now() };
    this.events.push(saved);
    for (const listener of this.eventListeners) listener(saved);
    return saved;
  }

  subscribeEvents(listener: (event: DomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listEvents(options: EventQuery = {}): DomainEvent[] {
    if (options.aggregateId && options.aggregateIds?.length) throw new Error("listEvents accepts either aggregateId or aggregateIds, not both");
    const aggregateIds = options.aggregateIds?.length ? new Set(options.aggregateIds) : null;
    const types = options.types?.length ? new Set<string>(options.types) : null;
    const matched = this.events.filter((event) => event.sequence > (options.afterSequence ?? 0)
      && (!options.aggregateId || event.aggregateId === options.aggregateId)
      && (!aggregateIds || aggregateIds.has(event.aggregateId))
      && (!types || types.has(event.type)));
    if (options.limit === undefined) return matched;
    return options.limitFrom === "head" ? matched.slice(0, options.limit) : matched.slice(-options.limit);
  }

  getLastEventSequence(aggregateId?: string): number {
    return this.events.filter((event) => !aggregateId || event.aggregateId === aggregateId).at(-1)?.sequence ?? 0;
  }

  pruneEvents(input: EventPruneInput): { deleted: number } {
    // 只从数组里摘掉待删的那些，**不动 eventSequence**：序号是"已经用到哪"的高水位，
    // 回收之后又把序号退回去，会让后续追加的事件与既有行撞号（SQLite 上 sequence 是 UNIQUE）。
    const doomed = prunableEventIds(this.events, input);
    if (doomed.size === 0) return { deleted: 0 };
    const kept = this.events.filter((event) => !doomed.has(event.id));
    this.events.length = 0;
    this.events.push(...kept);
    return { deleted: doomed.size };
  }

  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary {
    const project = this.projects.get(input.projectId);
    const replacement = this.threads.get(input.replacementExplorerId);
    if (!project || !replacement || replacement.projectId !== input.projectId || replacement.id === input.explorerId) throw new Error("Explorer deletion replacement is invalid");
    if (project.currentExplorerThreadId === input.explorerId) this.projects.set(input.projectId, { ...project, currentExplorerThreadId: replacement.id, updatedAt: this.now() });

    const explorerPlanIds = new Set(input.explorerPlanIds);
    const planIds = new Set(input.planIds);
    const runIds = new Set(input.runIds);
    const executionThreadIds = new Set(input.executionThreadIds);
    const agentLoopIds = new Set(input.agentLoopIds);
    const deletedIds = new Set([input.explorerId, ...explorerPlanIds, ...input.turnIds, ...planIds, ...runIds, ...executionThreadIds, ...agentLoopIds, ...input.inputRequestIds]);

    for (const [key, proposal] of this.changeProposals) if (runIds.has(proposal.runId) || planIds.has(proposal.planId)) this.changeProposals.delete(key);
    for (const key of [...this.dispatchStates.keys()]) if (planIds.has(key)) this.dispatchStates.delete(key);
    for (const key of [...this.revisions.keys()]) if (planIds.has(key.split(":")[0] ?? "")) this.revisions.delete(key);
    for (const [key, draft] of this.revisionDrafts) if (planIds.has(draft.planId) || draft.sourceExplorerThreadId === input.explorerId) this.revisionDrafts.delete(key);
    for (const [key, projection] of this.planQueryProjections) if (planIds.has(projection.planId) || projection.sourceExplorerThreadId === input.explorerId) this.planQueryProjections.delete(key);
    for (const [key, execution] of this.hookExecutions) if (runIds.has(execution.runId)) this.hookExecutions.delete(key);
    for (const [key, verification] of this.verificationRuns) if (runIds.has(verification.runId)) this.verificationRuns.delete(key);
    for (const [key, request] of this.mergeRequests) if (runIds.has(request.runId) || planIds.has(request.planId)) this.mergeRequests.delete(key);
    for (const runId of runIds) this.runs.delete(runId);
    for (const executionThreadId of executionThreadIds) this.executionThreads.delete(executionThreadId);
    for (const call of [...this.toolCalls.values()]) if (agentLoopIds.has(call.loopId)) this.toolCalls.delete(call.callId);
    for (const loopId of agentLoopIds) {
      this.agentLoopSteps.delete(loopId);
      this.agentLoops.delete(loopId);
    }
    for (const [id, request] of this.inputRequests) if (request.threadId === input.explorerId || input.inputRequestIds.includes(id)) this.inputRequests.delete(id);
    for (const [threadId] of this.turns) if (threadId === input.explorerId) this.turns.delete(threadId);
    for (const planId of planIds) this.plans.delete(planId);
    for (const [id, plan] of this.plans) if (plan.sourceExplorerThreadId === input.explorerId) this.plans.delete(id);
    for (const [id, plan] of this.explorerPlans) if (explorerPlanIds.has(id) || plan.explorerThreadId === input.explorerId) this.explorerPlans.delete(id);
    this.threads.delete(input.explorerId);
    for (const [key, result] of this.idempotency) if (containsAnyString(result, deletedIds)) this.idempotency.delete(key);
    return { taskCount: input.explorerPlanIds.length, planCount: input.planIds.length, runCount: input.runIds.length };
  }

  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined { return this.idempotency.get(`${scope}:${key}`); }
  /** 首次写入生效（与 SQLite 实现的 INSERT OR IGNORE 一致）；幂等键重放必须拿到**原来**那条结果。 */
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void {
    const composite = `${scope}:${key}`;
    if (this.idempotency.has(composite)) return;
    this.idempotency.set(composite, result);
  }
}
