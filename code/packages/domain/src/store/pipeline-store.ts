/**
 * 模块职责：Domain 的持久化端口（PipelineStore）声明——内存实现与 SQLite 实现共同遵守的契约。
 *
 * 为什么从 index.ts 抽出来：这个端口是 store 三件套里第一件要被搬走的。它**只由类型构成**，
 *   搬走后对 index.ts 只保留 import type（tsc 整条擦除），不产生任何运行时边；而事实上的
 *   InMemory / Sqlite 两个实现一旦跟着搬走，就会牵出它们共用的十几个模块级辅助函数
 *   （defaultExplorerPlan、planQueryProjectionFor 等）——那些是**值**，必须有各自的叶子模块，
 *   否则 store → index.ts 的反向边会把 P2 刚清零的值级环重新引回来。所以顺序是：端口先走。
 *
 * 维护提示（契约约束，两个实现必须同时满足）：
 *   1) 内存实现与 SQLite 实现必须保持**相同的事实与事件语义**。新增方法时两侧都要实现，
 *      且事件追加的时点（写事实之前还是之后）必须一致，否则同一份业务代码在两种存储下
 *      会表现出不同的重放结果。
 *   2) appendEvent 的入参是 Omit<DomainEvent, "id" | "occurredAt" | "sequence">：id 与序号
 *      由存储层生成，调用方不得指定。这是"事件序号单调且在聚合内连续"的唯一保证。
 *   3) listEvents 的 aggregateIds / types 过滤是**下推到存储层**的手段，不是可选优化：
 *      去掉它们会让 Plan 时间线读出整张事件表。
 *   4) runInTransaction 是可选的（`?`）：SQLite 实现提供它以保证启动恢复的原子性，
 *      内存实现不需要。调用方必须容忍它不存在，不能假定一定有事务边界。
 *   5) deleteExplorerCascade 返回摘要是为了让调用方拿到级联删除的计数，
 *      不要改成 void——上层的事件载荷依赖这些计数。
 *   6) **saveIdempotency 是"首次写入生效"**，重复的 (scope, key) **不得覆盖**已有结果。
 *      调用方一律是"先 getIdempotency，未命中才写"（见 explorer/thread-service.ts、
 *      plan/service.ts），所以覆盖在单进程下不会发生；但该"先查后写"不是原子的，
 *      并发重放时只有 INSERT OR IGNORE 语义才能保证重放拿到**原来**那条结果。
 *      内存实现曾用 Map.set（后写覆盖），与 SQLite 的 INSERT OR IGNORE 语义相反——
 *      已按首次写入生效对齐，不要再退回后者。
 *   7) pruneEvents **只**能删除 PRUNABLE_EVENT_TYPES 与 MODEL_OUTPUT 那批 run.executor.event，
 *      且每个聚合要留够保底条数。白名单是"这一条事件是不是某段事实的中间态、最终态是否另有
 *      持久化副本"的判定结果，不是"看起来不重要"。往白名单里加类型之前先回答那个问题，
 *      见 PRUNABLE_EVENT_TYPES 的注释。
 */
import type { EventPruneInput } from "./event-retention.js";
import type {
  AgentLoop,
  AgentLoopStep,
  AgentLoopStepInput,
  CandidatePlan,
  ChangeProposal,
  DomainEvent,
  ExecutionJournalEntry,
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
  PlanDispatchState,
  PlanQueryProjection,
  PlanRevisionDraft,
  PlanRevision,
  Project,
  ProjectConfigRevision,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  RegisterThreadInput,
  Run,
  RunGuidance,
  RunGuidanceMode,
  RunGuidanceStatus,
  VerificationRun,
} from "../index.js";

/**
 * 事件查询参数。`aggregateIds` / `types` 是把过滤下推到存储层的手段，
 * 让调用方不必为了筛出少量事件而把整张事件表读进内存；空数组等同于不筛选。
 */
export type EventQuery = {
  afterSequence?: number;
  aggregateId?: string;
  aggregateIds?: readonly string[];
  types?: readonly string[];
  /**
   * 截断条数。**取哪一端由 limitFrom 决定**，缺省 `"tail"` 即"最新的 N 条"，
   * 与引入 limitFrom 之前的行为完全一致。
   *
   * 游标式增量读取（"从 cursor 往后接着读"）必须显式传 `limitFrom: "head"`：
   * 那种场景下取最新的 N 条是错的——游标停在旧位置时会一直读到最新那一批，
   * 中间的事件被静默跳过，且因为游标推进到本批末尾而永远补不回来。
   */
  limit?: number;
  limitFrom?: "head" | "tail";
};

/** Domain 的持久化端口；内存和 SQLite 实现必须保持相同的事实及事件语义。 */
export type PipelineStore = {
  now(): string;
  nextId(prefix: string): string;
  saveThread(input: RegisterThreadInput): ExplorerThread;
  getThread(id: string): ExplorerThread | undefined;
  listThreads(): ExplorerThread[];
  updateThread(thread: ExplorerThread): ExplorerThread;
  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan;
  getExplorerPlan(id: string): ExplorerPlan | undefined;
  listExplorerPlans(threadId?: string): ExplorerPlan[];
  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan;
  saveProject(project: Project): Project;
  getProject(projectId: string): Project | undefined;
  saveProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread;
  getProjectExecutionThread(projectId: string): ProjectExecutionThread | undefined;
  updateProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread;
  saveProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage;
  getProjectExecutionMessageByClientTurnId(threadId: string, clientTurnId: string): ProjectExecutionMessage | undefined;
  listProjectExecutionMessages(threadId: string): ProjectExecutionMessage[];
  updateProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage;
  listProjects(): Project[];
  updateProject(project: Project): Project;
  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision;
  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[];
  saveTurn(turn: ExplorerTurn): ExplorerTurn;
  updateTurn(turn: ExplorerTurn): ExplorerTurn;
  listTurns(threadId: string): ExplorerTurn[];
  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest;
  getInputRequest(id: string): ExplorerInputRequest | undefined;
  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[];
  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest;
  savePlan(plan: CandidatePlan): CandidatePlan;
  getPlan(id: string): CandidatePlan | undefined;
  listPlans(): CandidatePlan[];
  updatePlan(plan: CandidatePlan): CandidatePlan;
  saveCandidateVersion(plan: CandidatePlan): CandidatePlan;
  listCandidateVersions(planId: string): CandidatePlan[];
  saveDispatchState(state: PlanDispatchState): PlanDispatchState;
  /** 删除当前调度投影；历史状态变更仍保留在领域事件中。 */
  deleteDispatchState(planId: string): void;
  getDispatchState(planId: string): PlanDispatchState | undefined;
  listDispatchStates(projectId?: string): PlanDispatchState[];
  saveRevision(revision: PlanRevision): PlanRevision;
  getRevision(planId: string, revision: number): PlanRevision | undefined;
  listRevisions(planId: string): PlanRevision[];
  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft;
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined;
  listRevisionDrafts(planId?: string): PlanRevisionDraft[];
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft;
  saveChangeProposal(proposal: ChangeProposal): ChangeProposal;
  getChangeProposal(id: string): ChangeProposal | undefined;
  listChangeProposals(runId?: string): ChangeProposal[];
  updateChangeProposal(proposal: ChangeProposal): ChangeProposal;
  saveRun(run: Run): Run;
  getRun(runId: string): Run | undefined;
  listRuns(): Run[];
  saveExecutionThread(thread: ExecutionThread): ExecutionThread;
  getExecutionThread(threadId: string): ExecutionThread | undefined;
  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry;
  saveHookExecution(execution: HookExecution): HookExecution;
  listHookExecutions(runId?: string): HookExecution[];
  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection;
  listPlanQueryProjection(projectId?: string): PlanQueryProjection[];
  saveVerificationRun(verification: VerificationRun): VerificationRun;
  getVerificationRun(runId: string): VerificationRun | undefined;
  listVerificationRuns(runId?: string): VerificationRun[];
  saveMergeRequest(request: MergeRequest): MergeRequest;
  getMergeRequest(requestId: string): MergeRequest | undefined;
  findMergeRequestByRun(runId: string): MergeRequest | undefined;
  listMergeRequests(): MergeRequest[];
  updateMergeRequest(request: MergeRequest): MergeRequest;
  saveRunGuidance(guidance: RunGuidance): RunGuidance;
  updateRunGuidance(guidance: RunGuidance): RunGuidance;
  /** 按创建顺序返回某个 Run 的补充要求；两个过滤条件都可省略（省略即不筛）。 */
  listRunGuidance(runId: string, filter?: { mode?: RunGuidanceMode; status?: RunGuidanceStatus }): RunGuidance[];
  saveAgentLoop(loop: AgentLoop): AgentLoop;
  getAgentLoop(loopId: string): AgentLoop | undefined;
  listAgentLoops(ownerId?: string): AgentLoop[];
  updateAgentLoop(loop: AgentLoop): AgentLoop;
  appendAgentLoopStep(step: AgentLoopStepInput): AgentLoopStep;
  listAgentLoopSteps(loopId: string, options?: { stepTypes?: readonly string[] }): AgentLoopStep[];
  /** 只返回 Loop 当前最大步骤序号；用于事件序号推进，避免为此读取全部步骤。 */
  getLastAgentLoopStepSequence(loopId: string): number;
  recoverAgentLoops(): AgentLoop[];
  saveToolCall(call: PersistedToolCall): PersistedToolCall;
  getToolCall(callId: string): PersistedToolCall | undefined;
  listToolCalls(loopId?: string): PersistedToolCall[];
  updateToolCall(call: PersistedToolCall): PersistedToolCall;
  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent;
  subscribeEvents?(listener: (event: DomainEvent) => void): () => void;
  /**
   * 按序号升序读取事件。过滤与截断参数见 EventQuery —— 注意 `limit` 缺省从**尾部**取，
   * 游标式增量读取要传 `limitFrom: "head"`。
   */
  listEvents(options?: EventQuery): DomainEvent[];
  getLastEventSequence(aggregateId?: string): number;
  /**
   * 回收高频事件。只动 PRUNABLE_EVENT_TYPES（与 MODEL_OUTPUT 的 run.executor.event），
   * 返回实际删除条数。规则与白名单见 store/event-retention.ts——那是**唯一**定义，
   * SQLite 实现的白名单 SQL 必须与它逐条对应。
   */
  pruneEvents(input: EventPruneInput): { deleted: number };
  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary;
  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined;
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void;
  /** Optional store-level transaction used for startup recovery atomicity. */
  runInTransaction?<T>(work: () => T): T;
};
