export type PlanStatus =
  | "DRAFT"
  | "DESIGNED"
  | "PLANNED"
  | "READY"
  | "QUEUED"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "MERGE_READY"
  | "MERGED"
  | "BLOCKED";

export type ExplorerThreadState = "ACTIVE" | "COMPRESSED" | "ARCHIVED";

export type ExplorerThread = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  providerThreadId: string | null;
  state: ExplorerThreadState;
  messageCount: number;
  summaryRef: string | null;
  lastActivityAt: string;
};

export type ExplorerTurn = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status?: "COMPLETED" | "FAILED" | "CANCELLED";
  error?: string;
  createdAt: string;
  sequence: number;
};

export type PlanTask = {
  id: string;
  title: string;
  dependencies: string[];
  status: "PENDING" | "READY" | "DONE";
};

export type PlanContract = {
  goal: string;
  acceptanceCriteria: string[];
  include: string[];
  exclude: string[];
  baseBranch: string;
  baseCommit: string;
  tasks: PlanTask[];
  conflictKeys: string[];
  executorModelRole: string;
  toolPolicy: string;
  verificationCommandIds: string[];
  maxRepairAttempts: number;
  mergeStrategy: "manual" | "fast-forward" | "squash";
  requireHumanMerge: boolean;
};

export type CandidatePlan = {
  id: string;
  projectId: string;
  sourceExplorerThreadId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  queuedAt: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  contract: PlanContract;
};

export type PlanRevisionV2 = Readonly<{
  planId: string;
  revision: number;
  contract: Readonly<PlanContract>;
  artifactHash: string;
  confirmedBy: string;
  confirmedAt: string;
  sourceExplorerThreadId: string;
}>;

export type PlanIndexRow = {
  planId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  queuedAt: string;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
};

export type DomainEvent = {
  id: string;
  type:
    | "explorer.thread.created"
    | "explorer.turn.completed"
    | "explorer.turn.failed"
    | "explorer.turn.failed"
    | "plan.candidate.created"
    | "plan.confirmed"
    | "plan.enqueued"
    | "hook.started"
    | "hook.completed"
    | "hook.failed"
    | "hook.skipped"
    | "run.paused"
    | "run.resumed"
    | "run.guidance.added"
    | "verification.completed"
    | "merge.request.created"
    | "merge.confirmed";
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type CreateCandidatePlanInput = {
  projectId: string;
  sourceExplorerThreadId: string;
  title: string;
};

export type RegisterThreadInput = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  providerThreadId?: string | undefined;
};

export type HookDefinition = {
  commandId: string;
  enabled?: boolean | undefined;
  timeoutMs?: number | undefined;
};

export type HookContext = {
  projectId: string;
  runId: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  exitReason: string;
};

export type CommandInvocation = {
  commandId: string;
  cwd: string;
  timeoutMs: number;
  context: HookContext;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CommandExecutor = (command: CommandInvocation) => Promise<CommandResult>;

export type HookRunResult = {
  hook: "start" | "cleanup";
  status: "completed" | "failed" | "skipped";
  blocked: boolean;
  needsAttention: boolean;
  result: CommandResult | null;
};

export type PipelineStore = {
  now(): string;
  nextId(prefix: string): string;
  saveThread(input: RegisterThreadInput): ExplorerThread;
  getThread(id: string): ExplorerThread | undefined;
  listThreads(): ExplorerThread[];
  updateThread(thread: ExplorerThread): ExplorerThread;
  saveTurn(turn: ExplorerTurn): ExplorerTurn;
  listTurns(threadId: string): ExplorerTurn[];
  savePlan(plan: CandidatePlan): CandidatePlan;
  getPlan(id: string): CandidatePlan | undefined;
  listPlans(): CandidatePlan[];
  updatePlan(plan: CandidatePlan): CandidatePlan;
  saveRevision(revision: PlanRevisionV2): PlanRevisionV2;
  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined;
  saveRun(run: Run): Run;
  getRun(runId: string): Run | undefined;
  listRuns(): Run[];
  saveExecutionThread(thread: ExecutionThread): ExecutionThread;
  getExecutionThread(threadId: string): ExecutionThread | undefined;
  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt">): DomainEvent;
  listEvents(): DomainEvent[];
};

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

export class InMemoryPipelineStore implements PipelineStore {
  private readonly plans = new Map<string, CandidatePlan>();
  private readonly revisions = new Map<string, PlanRevisionV2>();
  private readonly runs = new Map<string, Run>();
  private readonly executionThreads = new Map<string, ExecutionThread>();
  private readonly turns = new Map<string, ExplorerTurn[]>();
  private readonly threads = new Map<string, ExplorerThread>();
  private readonly events: DomainEvent[] = [];
  private sequence = 0;

  now(): string {
    this.sequence += 1;
    return new Date(Date.now() + this.sequence).toISOString();
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString(36)}`;
  }

  saveThread(input: RegisterThreadInput): ExplorerThread {
    const thread: ExplorerThread = {
      id: input.id,
      projectId: input.projectId,
      parentThreadId: input.parentThreadId,
      providerThreadId: input.providerThreadId ?? null,
      state: "ACTIVE",
      messageCount: 0,
      summaryRef: null,
      lastActivityAt: this.now(),
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  getThread(id: string): ExplorerThread | undefined {
    return this.threads.get(id);
  }

  listThreads(): ExplorerThread[] {
    return [...this.threads.values()];
  }

  updateThread(thread: ExplorerThread): ExplorerThread { this.threads.set(thread.id, thread); return thread; }
  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    const current = this.turns.get(turn.threadId) ?? [];
    current.push(turn);
    this.turns.set(turn.threadId, current);
    return turn;
  }
  listTurns(threadId: string): ExplorerTurn[] { return [...(this.turns.get(threadId) ?? [])]; }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.plans.set(plan.id, plan);
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
    return plan;
  }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.revisions.set(`${revision.planId}:${revision.revision}`, revision);
    return revision;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    return this.revisions.get(`${planId}:${revision}`);
  }

  saveRun(run: Run): Run { this.runs.set(run.id, run); return run; }
  getRun(runId: string): Run | undefined { return this.runs.get(runId); }
  listRuns(): Run[] { return [...this.runs.values()]; }
  saveExecutionThread(thread: ExecutionThread): ExecutionThread { this.executionThreads.set(thread.id, thread); return thread; }
  getExecutionThread(threadId: string): ExecutionThread | undefined { return this.executionThreads.get(threadId); }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt">): DomainEvent {
    const saved: DomainEvent = { ...event, id: this.nextId("event"), occurredAt: this.now() };
    this.events.push(saved);
    return saved;
  }

  listEvents(): DomainEvent[] {
    return [...this.events];
  }
}

type SqliteRow = Record<string, unknown>;

export class SqlitePipelineStore implements PipelineStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS explorer_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_thread_id TEXT,
        provider_thread_id TEXT,
        state TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary_ref TEXT,
        last_activity_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explorer_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        error TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        queued_at TEXT,
        run_id TEXT,
        last_event_at TEXT NOT NULL,
        attention_reason TEXT,
        contract_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        branch TEXT NOT NULL,
        workspace_path TEXT,
        base_commit TEXT NOT NULL,
        execution_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_threads (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        journal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETED'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN error TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE explorer_turns SET status = 'FAILED', error = COALESCE(error, '历史记录未包含模型文本') WHERE role = 'assistant' AND trim(content) = '' AND status = 'COMPLETED'");
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN contract_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* Existing databases already have the column. */ }
  }

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string { return `${prefix}-${randomUUID().slice(0, 12)}`; }

  saveThread(input: RegisterThreadInput): ExplorerThread {
    const thread: ExplorerThread = {
      id: input.id,
      projectId: input.projectId,
      parentThreadId: input.parentThreadId,
      providerThreadId: input.providerThreadId ?? null,
      state: "ACTIVE",
      messageCount: 0,
      summaryRef: null,
      lastActivityAt: this.now(),
    };
    this.database.prepare(`
      INSERT INTO explorer_threads (id, project_id, parent_thread_id, provider_thread_id, state, message_count, summary_ref, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, parent_thread_id=excluded.parent_thread_id
    `).run(thread.id, thread.projectId, thread.parentThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.lastActivityAt);
    return this.getThread(thread.id) as ExplorerThread;
  }

  getThread(id: string): ExplorerThread | undefined {
    const row = this.database.prepare("SELECT * FROM explorer_threads WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.threadFromRow(row) : undefined;
  }

  listThreads(): ExplorerThread[] {
    const rows = this.database.prepare("SELECT * FROM explorer_threads ORDER BY last_activity_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  updateThread(thread: ExplorerThread): ExplorerThread {
    this.database.prepare("UPDATE explorer_threads SET provider_thread_id = ?, state = ?, message_count = ?, summary_ref = ?, last_activity_at = ? WHERE id = ?").run(thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.lastActivityAt, thread.id);
    return this.getThread(thread.id) as ExplorerThread;
  }

  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    this.database.prepare("INSERT INTO explorer_turns (id, thread_id, role, content, status, error, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(turn.id, turn.threadId, turn.role, turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.createdAt, turn.sequence);
    return turn;
  }

  listTurns(threadId: string): ExplorerTurn[] {
    const rows = this.database.prepare("SELECT * FROM explorer_turns WHERE thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    return rows.map((row) => ({ id: String(row.id), threadId: String(row.thread_id), role: String(row.role) as ExplorerTurn["role"], content: String(row.content), status: String(row.status ?? "COMPLETED") as NonNullable<ExplorerTurn["status"]>, ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), sequence: Number(row.sequence) }));
  }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.database.prepare(`
      INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, title, revision, status, created_at, confirmed_by, confirmed_at, queued_at, run_id, last_event_at, attention_reason, contract_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, title=excluded.title, revision=excluded.revision, status=excluded.status, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, queued_at=excluded.queued_at, run_id=excluded.run_id, last_event_at=excluded.last_event_at, attention_reason=excluded.attention_reason, contract_json=excluded.contract_json
    `).run(plan.id, plan.projectId, plan.sourceExplorerThreadId, plan.title, plan.revision, plan.status, plan.createdAt, plan.confirmedBy, plan.confirmedAt, plan.queuedAt, plan.runId, plan.lastEventAt, plan.attentionReason, JSON.stringify(plan.contract));
    return this.getPlan(plan.id) as CandidatePlan;
  }

  getPlan(id: string): CandidatePlan | undefined {
    const row = this.database.prepare("SELECT * FROM candidate_plans WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.planFromRow(row) : undefined;
  }

  listPlans(): CandidatePlan[] {
    const rows = this.database.prepare("SELECT * FROM candidate_plans ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.planFromRow(row));
  }

  updatePlan(plan: CandidatePlan): CandidatePlan { return this.savePlan(plan); }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.database.prepare("INSERT OR IGNORE INTO plan_revisions (plan_id, revision, contract_json, artifact_hash, confirmed_by, confirmed_at, source_explorer_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(revision.planId, revision.revision, JSON.stringify(revision.contract), revision.artifactHash, revision.confirmedBy, revision.confirmedAt, revision.sourceExplorerThreadId);
    return this.getRevision(revision.planId, revision.revision) as PlanRevisionV2;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    const row = this.database.prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?").get(planId, revision) as SqliteRow | undefined;
    if (!row) return undefined;
    return freezeRevision({ planId: String(row.plan_id), revision: Number(row.revision), contract: JSON.parse(String(row.contract_json)) as PlanContract, artifactHash: String(row.artifact_hash), confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at), sourceExplorerThreadId: String(row.source_explorer_thread_id) });
  }

  saveRun(run: Run): Run {
    this.database.prepare("INSERT INTO runs (id, project_id, plan_id, plan_revision, status, branch, workspace_path, base_commit, execution_thread_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, workspace_path=excluded.workspace_path, started_at=excluded.started_at").run(run.id, run.projectId, run.planId, run.planRevision, run.status, run.branch, run.workspacePath, run.baseCommit, run.executionThreadId, run.createdAt, run.startedAt);
    return this.getRun(run.id) as Run;
  }

  getRun(runId: string): Run | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as SqliteRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.runFromRow(row));
  }

  saveExecutionThread(thread: ExecutionThread): ExecutionThread {
    this.database.prepare("INSERT INTO execution_threads (id, run_id, state, journal_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, journal_json=excluded.journal_json").run(thread.id, thread.runId, thread.state, JSON.stringify(thread.journal));
    return this.getExecutionThread(thread.id) as ExecutionThread;
  }

  getExecutionThread(threadId: string): ExecutionThread | undefined {
    const row = this.database.prepare("SELECT * FROM execution_threads WHERE id = ?").get(threadId) as SqliteRow | undefined;
    return row ? { id: String(row.id), runId: String(row.run_id), state: String(row.state) as ExecutionThreadState, journal: JSON.parse(String(row.journal_json)) as ExecutionJournalEntry[] } : undefined;
  }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt">): DomainEvent {
    const saved: DomainEvent = { ...event, id: this.nextId("event"), occurredAt: this.now() };
    this.database.prepare("INSERT INTO domain_events (id, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)").run(saved.id, saved.type, saved.aggregateId, saved.occurredAt, JSON.stringify(saved.payload));
    return saved;
  }

  listEvents(): DomainEvent[] {
    const rows = this.database.prepare("SELECT * FROM domain_events ORDER BY occurred_at ASC, id ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as DomainEvent["type"],
      aggregateId: String(row.aggregate_id),
      occurredAt: String(row.occurred_at),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  close(): void { this.database.close(); }

  private threadFromRow(row: SqliteRow): ExplorerThread {
    return { id: String(row.id), projectId: String(row.project_id), parentThreadId: row.parent_thread_id === null ? null : String(row.parent_thread_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), state: String(row.state) as ExplorerThreadState, messageCount: Number(row.message_count), summaryRef: row.summary_ref === null ? null : String(row.summary_ref), lastActivityAt: String(row.last_activity_at) };
  }

  private planFromRow(row: SqliteRow): CandidatePlan {
    return { id: String(row.id), projectId: String(row.project_id), sourceExplorerThreadId: String(row.source_explorer_thread_id), title: String(row.title), revision: Number(row.revision), status: String(row.status) as PlanStatus, createdAt: String(row.created_at), confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at), queuedAt: row.queued_at === null ? null : String(row.queued_at), runId: row.run_id === null ? null : String(row.run_id), lastEventAt: String(row.last_event_at), attentionReason: row.attention_reason === null ? null : String(row.attention_reason), contract: JSON.parse(String(row.contract_json ?? "{}")) as PlanContract };
  }

  private runFromRow(row: SqliteRow): Run {
    return { id: String(row.id), projectId: String(row.project_id), planId: String(row.plan_id), planRevision: Number(row.plan_revision), status: String(row.status) as RunStatus, branch: String(row.branch), workspacePath: row.workspace_path === null ? null : String(row.workspace_path), baseCommit: String(row.base_commit), executionThreadId: String(row.execution_thread_id), createdAt: String(row.created_at), startedAt: row.started_at === null ? null : String(row.started_at) };
  }
}

function defaultPlanContract(title: string): PlanContract {
  return {
    goal: title,
    acceptanceCriteria: ["All approved tasks are executed within the declared scope", "Registered verification commands pass", "A human confirms the target commit before merge"],
    include: ["apps/*", "packages/*"],
    exclude: [".env*", ".git/*", "dist/*"],
    baseBranch: "main",
    baseCommit: "HEAD",
    tasks: [{ id: "task-1", title, dependencies: [], status: "READY" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test", "project.typecheck"],
    maxRepairAttempts: 2,
    mergeStrategy: "manual",
    requireHumanMerge: true,
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function freezeRevision(revision: PlanRevisionV2): PlanRevisionV2 {
  return freezeDeep(revision);
}

export class PlanService {
  constructor(private readonly store: PipelineStore) {}

  registerThread(input: RegisterThreadInput): ExplorerThread {
    const thread = this.store.saveThread(input);
    this.store.appendEvent({
      type: "explorer.thread.created",
      aggregateId: thread.id,
      payload: { projectId: thread.projectId, parentThreadId: thread.parentThreadId },
    });
    return thread;
  }

  createCandidatePlan(input: CreateCandidatePlanInput): CandidatePlan {
    if (!this.store.getThread(input.sourceExplorerThreadId)) {
      this.registerThread({ id: input.sourceExplorerThreadId, projectId: input.projectId, parentThreadId: null });
    }
    const createdAt = this.store.now();
    const plan: CandidatePlan = {
      id: this.store.nextId("plan"),
      projectId: input.projectId,
      sourceExplorerThreadId: input.sourceExplorerThreadId,
      title: input.title,
      revision: 1,
      status: "DRAFT",
      createdAt,
      confirmedBy: null,
      confirmedAt: null,
      queuedAt: null,
      runId: null,
      lastEventAt: createdAt,
      attentionReason: null,
      contract: defaultPlanContract(input.title),
    };
    this.store.savePlan(plan);
    this.store.appendEvent({ type: "plan.candidate.created", aggregateId: plan.id, payload: { title: plan.title } });
    return plan;
  }

  get(planId: string): CandidatePlan {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    return plan;
  }

  confirm(planId: string, confirmedBy: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status === "READY" || plan.status === "QUEUED") return plan;
    if (plan.status !== "DRAFT" && plan.status !== "DESIGNED" && plan.status !== "PLANNED") {
      throw new Error(`Plan ${planId} cannot be confirmed from ${plan.status}`);
    }
    const confirmedAt = this.store.now();
    const revision = freezeRevision({
      planId: plan.id,
      revision: plan.revision,
      contract: plan.contract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify(plan.contract)).digest("hex")}`,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
    });
    this.store.saveRevision(revision);
    const updated = this.store.updatePlan({ ...plan, status: "READY", confirmedBy, confirmedAt, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.confirmed", aggregateId: planId, payload: { confirmedBy } });
    return updated;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 {
    const value = this.store.getRevision(planId, revision);
    if (!value) throw new Error(`Plan revision ${planId}@${revision} not found`);
    return value;
  }

  enqueue(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status === "QUEUED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") {
      return plan;
    }
    if (plan.status !== "READY") throw new Error(`Plan ${planId} must be confirmed before enqueue`);
    const queuedAt = this.store.now();
    const updated = this.store.updatePlan({ ...plan, status: "QUEUED", queuedAt, lastEventAt: queuedAt });
    this.store.appendEvent({ type: "plan.enqueued", aggregateId: planId, payload: { queuedAt } });
    return updated;
  }

  listThreadPlans(threadId: string): PlanIndexRow[] {
    const current = this.store.getThread(threadId);
    if (!current) return [];
    const lineage = new Set<string>([threadId]);
    let parentId = current.parentThreadId;
    while (parentId) {
      lineage.add(parentId);
      parentId = this.store.getThread(parentId)?.parentThreadId ?? null;
    }
    const descendants = this.store.listThreads().filter((thread) => thread.projectId === current.projectId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of descendants) {
        if (thread.parentThreadId && lineage.has(thread.parentThreadId) && !lineage.has(thread.id)) {
          lineage.add(thread.id);
          changed = true;
        }
      }
    }
    return this.store
      .listPlans()
      .filter((plan) => lineage.has(plan.sourceExplorerThreadId) && plan.queuedAt !== null)
      .map((plan) => ({
        planId: plan.id,
        title: plan.title,
        revision: plan.revision,
        status: plan.status,
        projectId: plan.projectId,
        sourceExplorerThreadId: plan.sourceExplorerThreadId,
        queuedAt: plan.queuedAt as string,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
      }))
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  }
}

export class LifecycleHookRunner {
  private readonly cleanupCwd: string;

  constructor(private readonly executor: CommandExecutor, options: { cleanupCwd?: string } = {}) {
    this.cleanupCwd = options.cleanupCwd ?? process.cwd();
  }

  async runStart(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    return this.run("start", hook, context, true);
  }

  async runCleanup(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    return this.run("cleanup", hook, context, false);
  }

  private async run(
    hook: "start" | "cleanup",
    definition: HookDefinition | undefined,
    context: HookContext,
    blocksRun: boolean,
  ): Promise<HookRunResult> {
    if (!definition || definition.enabled === false) {
      return { hook, status: "skipped", blocked: false, needsAttention: false, result: null };
    }
    const result = await this.executor({
      commandId: definition.commandId,
      cwd: hook === "start" ? context.workspacePath : this.cleanupCwd,
      timeoutMs: definition.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      context,
    });
    const failed = result.exitCode !== 0;
    return {
      hook,
      status: failed ? "failed" : "completed",
      blocked: failed && blocksRun,
      needsAttention: failed && !blocksRun,
      result,
    };
  }
}

export type RegisteredCommandDefinition = { commandId: string; argv: readonly [string, ...string[]]; environment?: Readonly<Record<string, string>> | undefined };
export type ProcessRunner = (argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>) => Promise<CommandResult>;

export class RegisteredCommandExecutor {
  private readonly commands = new Map<string, RegisteredCommandDefinition>();
  private readonly runProcess: ProcessRunner;

  constructor(commands: RegisteredCommandDefinition[], runProcess: ProcessRunner = defaultProcessRunner) {
    for (const command of commands) this.commands.set(command.commandId, command);
    this.runProcess = runProcess;
  }

  execute(command: CommandInvocation): Promise<CommandResult> {
    const definition = this.commands.get(command.commandId);
    if (!definition) return Promise.resolve({ exitCode: 127, stdout: "", stderr: `Command ${command.commandId} is not registered` });
    const env: Record<string, string> = { ...(definition.environment ?? {}) };
    Object.assign(env, {
      PIPELINE_PROJECT_ID: command.context.projectId,
      PIPELINE_RUN_ID: command.context.runId,
      PIPELINE_WORKSPACE_PATH: command.context.workspacePath,
      PIPELINE_BRANCH: command.context.branch,
      PIPELINE_BASE_COMMIT: command.context.baseCommit,
      PIPELINE_EXIT_REASON: command.context.exitReason,
    });
    return this.runProcess([...definition.argv], command.cwd, command.timeoutMs, env);
  }

  invoke(command: CommandInvocation): Promise<CommandResult> { return this.execute(command); }
}

function defaultProcessRunner(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(result); } };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => settle({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => settle({ exitCode: code, stdout, stderr }));
    const timer = setTimeout(() => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        setTimeout(() => { if (!settled) { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } } }, 1000);
      }
      settle({ exitCode: 124, stdout, stderr: `${stderr}Command timed out` });
    }, timeoutMs);
  });
}

export type ToolRole = "explorer" | "executor";
export type ToolName = "read_file" | "list_files" | "git_status" | "git_diff" | "git_log" | "search_text" | "write_file" | "apply_patch" | "run_command" | "run_registered_command" | "run_verification" | "git_commit";

export type ToolCall = {
  callId: string;
  tool: ToolName;
  input: Record<string, unknown>;
};

export type ToolCallResult = {
  callId: string;
  allowed: boolean;
  reason: string | null;
  result: unknown | null;
  audited: true;
};

export type ToolGatewayOptions = {
  role: ToolRole;
  workspaceRoot: string;
  registeredCommandIds?: ReadonlySet<string>;
  handler?: (call: ToolCall) => Promise<unknown>;
};

const READ_ONLY_TOOLS = new Set<ToolName>(["read_file", "list_files", "git_status", "git_diff", "git_log", "search_text"]);
const EXECUTOR_TOOLS = new Set<ToolName>([...READ_ONLY_TOOLS, "write_file", "apply_patch", "run_registered_command", "run_verification", "git_commit"]);
const PROTECTED_PATHS = new Set([".env", ".env.local", "package.json", "pnpm-lock.yaml", "tsconfig.json"]);

export class ToolGateway {
  private readonly calls = new Map<string, ToolCallResult>();
  private readonly workspaceRoot: string;
  private readonly registeredCommandIds: ReadonlySet<string>;

  constructor(private readonly options: ToolGatewayOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.registeredCommandIds = options.registeredCommandIds ?? new Set();
  }

  async call(call: ToolCall): Promise<ToolCallResult> {
    const previous = this.calls.get(call.callId);
    if (previous) return previous;
    const denied = this.validate(call);
    if (denied) {
      const result = this.save({ callId: call.callId, allowed: false, reason: denied, result: null, audited: true });
      return result;
    }
    const value = this.options.handler ? await this.options.handler(call) : null;
    return this.save({ callId: call.callId, allowed: true, reason: null, result: value, audited: true });
  }

  private validate(call: ToolCall): string | null {
    const allowedTools = this.options.role === "explorer" ? READ_ONLY_TOOLS : EXECUTOR_TOOLS;
    if (!allowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer is read-only; this tool is disabled" : "Tool is not allowed by Executor policy";
    if (["read_file", "write_file", "apply_patch"].includes(call.tool)) {
      const path = call.input.path;
      if (typeof path !== "string" || !this.isInsideWorkspace(path)) return "Path is outside the workspace boundary";
      if (this.options.role === "executor" && (PROTECTED_PATHS.has(path) || path.startsWith(".git/"))) return "Project configuration and Git internals are protected";
    }
    if (["run_registered_command", "run_verification"].includes(call.tool)) {
      const commandId = call.input.commandId;
      if (typeof commandId !== "string" || !this.registeredCommandIds.has(commandId)) return "Command is not registered for this project";
    }
    return null;
  }

  private isInsideWorkspace(path: string): boolean {
    const target = resolve(this.workspaceRoot, path);
    return target === this.workspaceRoot || target.startsWith(`${this.workspaceRoot}${sep}`) || isAbsolute(path) && target.startsWith(`${this.workspaceRoot}${sep}`);
  }

  private save(result: ToolCallResult): ToolCallResult { this.calls.set(result.callId, result); return result; }
}

export type ModelRole = "explorer" | "executor";
export type ModelRoleConfig = {
  model: string;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
};
export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
export type ModelRequest = {
  role: ModelRole;
  messages: ModelMessage[];
  conversationId?: string | undefined;
  providerThreadId?: string | undefined;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
};
export type ModelEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "text.delta"; text: string }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" };

export interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  configFor(role: ModelRole): ModelRoleConfig;
}

export class StubModelGateway implements ModelGateway {
  constructor(private readonly configs: Record<ModelRole, ModelRoleConfig>) {}

  configFor(role: ModelRole): ModelRoleConfig { return this.configs[role]; }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    yield { type: "text.delta", text: request.role === "explorer" ? "Stub Explorer response" : "Stub Executor response" };
    yield { type: "turn.completed" };
  }
}

export type ModelResult = { text: string; requestId: string | null; model: string };
export type ModelFetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type ModelFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal | undefined }) => Promise<ModelFetchResponse>;
export type OpenAIModelGatewayOptions = { apiKey: string; roles: Record<ModelRole, ModelRoleConfig>; baseUrl?: string | undefined; fetchFn?: ModelFetch | undefined };

export class OpenAIModelGateway implements ModelGateway {
  private readonly fetchFn: ModelFetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIModelGatewayOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";
    this.fetchFn = options.fetchFn ?? (async (url, init) => {
      const requestInit: RequestInit = { method: init.method, headers: init.headers, body: init.body };
      if (init.signal) requestInit.signal = init.signal;
      const response = await fetch(url, requestInit);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });
  }

  configFor(role: ModelRole): ModelRoleConfig { return this.options.roles[role]; }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const config = this.configFor(request.role);
    const body: Record<string, unknown> = { model: config.model, input: request.messages, stream: false };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxOutputTokens !== undefined) body.max_output_tokens = config.maxOutputTokens;
    const response = await this.fetchFn(this.baseUrl, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) throw new Error(`OpenAI Responses API failed with status ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    return { text: typeof payload.output_text === "string" ? payload.output_text : extractResponseText(payload), requestId: typeof payload.id === "string" ? payload.id : null, model: config.model };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) { yield { type: "turn.cancelled" }; return; }
    try {
      const result = await this.complete(request);
      yield { type: "text.delta", text: result.text };
      yield { type: "turn.completed" };
    } catch (error) {
      if (request.signal?.aborted) yield { type: "turn.cancelled" };
      else yield { type: "turn.failed", error: error instanceof Error ? error.message : "Model request failed" };
    }
  }
}

function extractResponseText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
  }).join("");
}

export class ExplorerThreadService {
  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway) {}

  async send(threadId: string, content: string, signal?: AbortSignal): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`ExplorerThread ${threadId} not found`);
    const user: ExplorerTurn = { id: this.store.nextId("turn"), threadId, role: "user", content, createdAt: this.store.now(), sequence: this.store.listTurns(threadId).length + 1 };
    this.store.saveTurn(user);
    this.store.updateThread({ ...thread, messageCount: thread.messageCount + 1, lastActivityAt: user.createdAt });
    const messages = this.store.listTurns(threadId).map((turn) => ({ role: turn.role, content: turn.content }));
    let assistantContent = "";
    let cancelled = false;
    let failure: string | null = null;
    const modelRequest: ModelRequest = {
      role: "explorer",
      messages,
      conversationId: thread.id,
      ...(thread.providerThreadId ? { providerThreadId: thread.providerThreadId } : {}),
      ...(signal ? { signal } : {}),
    };
    for await (const event of this.model.stream(modelRequest)) {
      if (event.type === "thread.started") {
        const current = this.store.getThread(threadId) ?? thread;
        this.store.updateThread({ ...current, providerThreadId: event.threadId });
      }
      if (event.type === "text.delta") assistantContent += event.text;
      if (event.type === "turn.cancelled") cancelled = true;
      if (event.type === "turn.failed") failure = event.error;
    }
    if (!cancelled && !failure && !assistantContent.trim()) failure = "模型未返回内容";
    const status = cancelled ? "CANCELLED" : failure ? "FAILED" : "COMPLETED";
    const assistant: ExplorerTurn = {
      id: this.store.nextId("turn"),
      threadId,
      role: "assistant",
      content: cancelled ? "Turn cancelled" : failure ? `模型调用失败：${failure}` : assistantContent,
      status,
      ...(failure ? { error: failure } : {}),
      createdAt: this.store.now(),
      sequence: user.sequence + 1,
    };
    this.store.saveTurn(assistant);
    const current = this.store.getThread(threadId) ?? thread;
    this.store.updateThread({ ...current, messageCount: current.messageCount + 1, lastActivityAt: assistant.createdAt });
    this.store.appendEvent({ type: failure ? "explorer.turn.failed" : "explorer.turn.completed", aggregateId: threadId, payload: { userTurnId: user.id, assistantTurnId: assistant.id, cancelled, ...(failure ? { error: failure } : {}) } });
    return { user, assistant };
  }
}

export { CodexAppServerClient, CodexAppServerGateway } from "./codex-app-server.js";
export type { CodexAppServerClientOptions, CodexAppServerEvent, CodexAppServerGatewayOptions, CodexAppServerSession, CodexAppServerSessionFactory, CodexSpawnProcess, CodexThreadStartParams, CodexTurnStartParams } from "./codex-app-server.js";

export type RunStatus = "QUEUED" | "STARTING" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "BLOCKED" | "NEEDS_PLAN_CHANGE" | "STALE" | "RECOVERING" | "CANCELLED";
export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";
export type JournalEntryType = "RUN_CREATED" | "HOOK_COMPLETED" | "HOOK_FAILED" | "HOOK_SKIPPED" | "MODEL_OUTPUT" | "TOOL_CALL" | "TASK_PROGRESS" | "USER_GUIDANCE" | "REPAIR" | "VERIFICATION" | "COMMIT" | "RECOVERY";

export type ExecutionJournalEntry = {
  sequence: number;
  type: JournalEntryType;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type ExecutionThread = {
  id: string;
  runId: string;
  state: ExecutionThreadState;
  journal: ExecutionJournalEntry[];
};

export type Run = {
  id: string;
  projectId: string;
  planId: string;
  planRevision: number;
  status: RunStatus;
  branch: string;
  workspacePath: string | null;
  baseCommit: string;
  executionThreadId: string;
  createdAt: string;
  startedAt: string | null;
};

export type Workspace = { path: string; branch: string; baseCommit: string };
export type WorkspaceAdapter = {
  create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace>;
  remove(workspace: Workspace): Promise<void>;
};

export type GitCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
export type LocalGitWorktreeOptions = { projectRoot: string; worktreeRoot: string; runGit?: GitCommandRunner | undefined };

export class LocalGitWorktreeAdapter implements WorkspaceAdapter {
  private readonly runGit: GitCommandRunner;

  constructor(private readonly options: LocalGitWorktreeOptions) {
    this.runGit = options.runGit ?? defaultGitCommand;
  }

  async create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace> {
    const path = resolve(this.options.worktreeRoot, input.runId);
    const verified = await this.runGit(["rev-parse", "--verify", input.baseCommit], this.options.projectRoot);
    if (verified.exitCode !== 0) throw new Error(`Base commit ${input.baseCommit} could not be verified`);
    const created = await this.runGit(["worktree", "add", "-b", input.branch, path, input.baseCommit], this.options.projectRoot);
    if (created.exitCode !== 0) throw new Error(`Git worktree could not be created: ${created.stderr}`);
    return { path, branch: input.branch, baseCommit: input.baseCommit };
  }

  async remove(workspace: Workspace): Promise<void> {
    const removed = await this.runGit(["worktree", "remove", "--force", workspace.path], this.options.projectRoot);
    if (removed.exitCode !== 0) throw new Error(`Git worktree could not be removed: ${removed.stderr}`);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

export type SchedulerOptions = {
  store: PipelineStore;
  workspace: WorkspaceAdapter;
  hooks: LifecycleHookRunner;
};

export class Scheduler {
  private readonly planService: PlanService;
  private readonly runs = new Map<string, Run>();
  private readonly threads = new Map<string, ExecutionThread>();

  constructor(private readonly options: SchedulerOptions) {
    this.planService = new PlanService(options.store);
  }

  async start(planId: string, hooks: { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined } = {}): Promise<Run> {
    const existing = this.options.store.listRuns().find((run) => run.planId === planId && run.status !== "CANCELLED");
    if (existing) {
      this.runs.set(existing.id, existing);
      const savedThread = this.options.store.getExecutionThread(existing.executionThreadId);
      if (savedThread) this.threads.set(savedThread.id, savedThread);
      return existing;
    }
    const plan = this.planService.get(planId);
    if (plan.status !== "QUEUED") throw new Error(`Plan ${planId} must be queued before a run starts`);
    const revision = this.options.store.getRevision(plan.id, plan.revision);
    if (!revision) throw new Error(`Plan revision ${plan.id}@${plan.revision} is missing`);
    const createdAt = this.options.store.now();
    const runId = this.options.store.nextId("run");
    const thread: ExecutionThread = { id: this.options.store.nextId("execution-thread"), runId, state: "ACTIVE", journal: [] };
    const run: Run = { id: runId, projectId: plan.projectId, planId: plan.id, planRevision: revision.revision, status: "STARTING", branch: `factory/${runId}`, workspacePath: null, baseCommit: revision.contract.baseCommit, executionThreadId: thread.id, createdAt, startedAt: null };
    this.runs.set(run.id, run);
    this.threads.set(thread.id, thread);
    this.options.store.saveRun(run);
    this.options.store.saveExecutionThread(thread);
    this.append(thread, "RUN_CREATED", { planId: plan.id, revision: revision.revision });
    const workspace = await this.options.workspace.create({ projectId: plan.projectId, runId, branch: run.branch, baseCommit: run.baseCommit });
    run.workspacePath = workspace.path;
    const startResult = await this.options.hooks.runStart(hooks.start, { projectId: plan.projectId, runId, workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, exitReason: "running" });
    if (startResult.status === "failed") {
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.append(thread, "HOOK_FAILED", { hook: "start", stderr: startResult.result?.stderr ?? "" });
      this.options.store.updatePlan({ ...plan, runId, status: "BLOCKED", attentionReason: "start hook failed", lastEventAt: this.options.store.now() });
      this.options.store.saveRun(run);
      return run;
    }
    run.status = "IN_PROGRESS";
    run.startedAt = this.options.store.now();
    this.append(thread, startResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "start" });
    this.options.store.updatePlan({ ...plan, runId, status: "IN_PROGRESS", lastEventAt: run.startedAt });
    this.options.store.saveRun(run);
    return run;
  }

  async finish(runId: string, exitReason: string, hooks: { cleanup?: HookDefinition | undefined } = {}): Promise<Run> {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (run.workspacePath) {
      await this.options.workspace.remove({ path: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit });
    }
    const cleanupResult = await this.options.hooks.runCleanup(hooks.cleanup, { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath ?? "", branch: run.branch, baseCommit: run.baseCommit, exitReason });
    this.append(thread, cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "cleanup", exitReason });
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, attentionReason: "cleanup hook failed", lastEventAt: this.options.store.now() });
    }
    if (exitReason === "cancelled") run.status = "CANCELLED";
    thread.state = exitReason === "cancelled" ? "CANCELLED" : "COMPLETED";
    this.options.store.saveRun(run);
    this.options.store.saveExecutionThread(thread);
    return run;
  }

  pause(runId: string): Run {
    const run = this.run(runId);
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${runId} cannot be paused from ${run.status}`);
    const thread = this.thread(run.executionThreadId);
    if (thread.state !== "ACTIVE") throw new Error(`ExecutionThread ${thread.id} cannot be paused from ${thread.state}`);
    thread.state = "PAUSED";
    this.append(thread, "TASK_PROGRESS", { action: "paused", runId });
    this.options.store.appendEvent({ type: "run.paused", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  resume(runId: string): Run {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (run.status !== "IN_PROGRESS" || thread.state !== "PAUSED") throw new Error(`Run ${runId} cannot be resumed from ${run.status}/${thread.state}`);
    thread.state = "ACTIVE";
    this.append(thread, "TASK_PROGRESS", { action: "resumed", runId });
    this.options.store.appendEvent({ type: "run.resumed", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  addGuidance(runId: string, content: string): ExecutionThread {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (thread.state === "CANCELLED" || thread.state === "COMPLETED") throw new Error(`Run ${runId} is no longer accepting guidance`);
    this.append(thread, "USER_GUIDANCE", { content, runId });
    this.options.store.appendEvent({ type: "run.guidance.added", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return thread;
  }

  thread(threadId: string): ExecutionThread {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) throw new Error(`ExecutionThread ${threadId} not found`);
    this.threads.set(threadId, thread);
    return thread;
  }

  run(runId: string): Run {
    const run = this.options.store.getRun(runId) ?? this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this.runs.set(runId, run);
    return run;
  }

  private append(thread: ExecutionThread, type: JournalEntryType, payload: Record<string, unknown>): void {
    thread.journal.push({ sequence: thread.journal.length + 1, type, occurredAt: this.options.store.now(), payload });
    this.options.store.saveExecutionThread(thread);
  }
}

export type VerificationStatus = "PASSED" | "FAILED" | "BLOCKED";
export type VerificationRun = {
  id: string;
  runId: string;
  status: VerificationStatus;
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: CommandResult }>;
  completedAt: string;
};
export type VerificationCommandExecutor = (commandId: string, run: Run) => Promise<CommandResult>;
export type RepairExecutor = (run: Run, attempt: number) => Promise<boolean>;

export class VerificationService {
  constructor(private readonly store?: PipelineStore) {}

  async verify(run: Run, revision: PlanRevisionV2, execute: VerificationCommandExecutor, repair?: RepairExecutor): Promise<VerificationRun> {
    run.status = "VERIFYING";
    this.store?.saveRun(run);
    const commandResults: Array<{ commandId: string; result: CommandResult }> = [];
    let repairAttempts = 0;
    for (;;) {
      commandResults.length = 0;
      let failed = false;
      for (const commandId of revision.contract.verificationCommandIds) {
        const result = await execute(commandId, run);
        commandResults.push({ commandId, result });
        if (result.exitCode !== 0) { failed = true; break; }
      }
      if (!failed) {
        run.status = "MERGE_READY";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: "PASSED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
      if (!repair || repairAttempts >= revision.contract.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: repairAttempts >= revision.contract.maxRepairAttempts ? "BLOCKED" as const : "FAILED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
      repairAttempts += 1;
      const repaired = await repair(run, repairAttempts);
      if (!repaired && repairAttempts >= revision.contract.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: "BLOCKED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
    }
  }

  private record(run: Run, verification: VerificationRun): void {
    if (!this.store) return;
    this.store.saveRun(run);
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (thread) {
      thread.journal.push({ sequence: thread.journal.length + 1, type: "VERIFICATION", occurredAt: verification.completedAt, payload: verification });
      this.store.saveExecutionThread(thread);
    }
    this.store.appendEvent({ type: "verification.completed", aggregateId: run.id, payload: verification });
  }
}

export type MergeRequest = {
  id: string;
  runId: string;
  planId: string;
  sourceCommit: string;
  targetBranch: string;
  status: "OPEN" | "MERGED";
  humanConfirmationRequired: true;
  createdAt: string;
  mergedAt: string | null;
};

export class MergeService {
  private readonly requests = new Map<string, MergeRequest>();

  constructor(private readonly store: PipelineStore) {}

  createRequest(run: Run, verification: VerificationRun, sourceCommit: string): MergeRequest {
    if (run.status !== "MERGE_READY" || verification.status !== "PASSED") throw new Error("MergeRequest requires a passed verification");
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const request: MergeRequest = { id: `merge-${randomUUID().slice(0, 12)}`, runId: run.id, planId: run.planId, sourceCommit, targetBranch: revision?.contract.baseBranch ?? "main", status: "OPEN", humanConfirmationRequired: true, createdAt: new Date().toISOString(), mergedAt: null };
    this.requests.set(request.id, request);
    this.store.appendEvent({ type: "merge.request.created", aggregateId: request.id, payload: request });
    return request;
  }

  findByRun(runId: string): MergeRequest | undefined { return [...this.requests.values()].find((request) => request.runId === runId); }
  get(requestId: string): MergeRequest | undefined { return this.requests.get(requestId); }
  list(): MergeRequest[] { return [...this.requests.values()]; }

  confirmMerged(requestId: string, targetCommit: string): MergeRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`MergeRequest ${requestId} not found`);
    if (request.status === "MERGED") return request;
    if (targetCommit !== request.sourceCommit) throw new Error("Target commit does not match the reviewed source commit");
    const merged = { ...request, status: "MERGED" as const, mergedAt: new Date().toISOString() };
    this.requests.set(requestId, merged);
    const plan = this.store.getPlan(request.planId);
    if (plan) this.store.updatePlan({ ...plan, status: "MERGED", lastEventAt: merged.mergedAt ?? plan.lastEventAt });
    this.store.appendEvent({ type: "merge.confirmed", aggregateId: requestId, payload: { targetCommit, planId: request.planId } });
    return merged;
  }
}

export type ToolCallLedgerStatus = "PENDING" | "COMPLETED" | "DENIED" | "UNCERTAIN" | "NEEDS_RECONCILIATION";
export type ToolCallLedgerEntry = { callId: string; tool: ToolName; status: ToolCallLedgerStatus; result: ToolCallResult; replay: boolean };

export class ToolCallLedger {
  private readonly entries = new Map<string, ToolCallLedgerEntry>();

  record(call: ToolCall, result: ToolCallResult, status: ToolCallLedgerStatus): ToolCallLedgerEntry {
    const entry: ToolCallLedgerEntry = { callId: call.callId, tool: call.tool, status, result, replay: false };
    this.entries.set(call.callId, entry);
    return entry;
  }

  recover(): Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> {
    const recovered: Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "UNCERTAIN") {
        entry.status = "NEEDS_RECONCILIATION";
        entry.replay = false;
        recovered.push({ callId: entry.callId, status: "NEEDS_RECONCILIATION", replay: false });
      }
    }
    return recovered;
  }

  list(): ToolCallLedgerEntry[] { return [...this.entries.values()]; }
}
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, resolve, sep } from "node:path";
