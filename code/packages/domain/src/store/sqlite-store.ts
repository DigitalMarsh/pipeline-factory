/**
 * 模块职责：PipelineStore 的 SQLite 实现——进程重启后仍然成立的持久化事实与领域事件。
 *
 * 为什么从 index.ts 抽出来：这是全仓最长的单一代码块（1,428 行，含 86 条建表/索引语句与
 *   228 行 SQL），却因为和 5,000 行的 index.ts 同处一个文件而无法被单独阅读。
 *   搬出来后它只依赖 store/records.ts（记录形状）、store/pipeline-store.ts（端口契约）与
 *   plan/query.ts（查询投影）三个叶子模块，对 index.ts 只剩 `import type`。
 *
 * 维护提示（顺序敏感，改任何一处都要先想清楚启动期的执行次序）：
 *   1) **建表 → 迁移 → 建索引**，三段在同一构造函数里按序执行，幂等（IF NOT EXISTS / 先查
 *      PRAGMA table_info 再 ALTER）。新增列时不要直接改 CREATE TABLE——老库不会重跑建表，
 *      必须补一条迁移分支；否则新列在老库上永远不存在，且错误只会在写入时暴露。
 *   2) 行映射函数（*FromRow）是**唯一**允许出现 snake_case 的地方。它们必须与 store/records.ts
 *      的默认值语义配套：读不出来的行回落默认值而不是抛错，否则一行坏数据会让整张表读崩。
 *   3) `freezeRevision` 在写入 Revision 时调用：Revision 一旦落库就不允许再被原地修改。
 *      去掉它不会让任何现有测试失败，但会让"Revision 不可变"这条领域约束在运行时消失。
 *   4) 事件的 id / 序号由本层生成（appendEvent 的入参是 Omit<..., "id"|"occurredAt"|"sequence">）。
 *      这是"事件序号在聚合内单调连续"的唯一保证，不要把它上移到调用方。
 *      取号**不只看 MAX(sequence)**，还要看 event_sequence_watermark：pruneEvents 会删掉尾部
 *      若干行，只看 MAX 会让序号退回去并复用已被当作游标用过的号。见 pruneEvents 的注释。
 *   5) deleteExplorerCascade 的事件与事实必须在**同一事务**内完成；拆开会让级联删除只能半途
 *      完成，留下指向已删除 Explorer 的孤儿 Plan。runInTransaction 就是为它和启动恢复准备的。
 *   6) normalizeSqliteError 把 SQLITE_BUSY 归一成 "DATABASE_BUSY"：上层（调度器）靠这个字面量
 *      判断"要不要重试"，改文案等于改重试策略。
 *   7) 所有方法体里的 SQL 一律走 `this.statement(sql)`，不要直接 `this.database.prepare(...)`：
 *      后者每次调用都重新编译一遍 SQL 文本。**唯一的例外是构造函数里的迁移区**（`ALTER TABLE`
 *      与紧随其后的 `prepare(...).run()`）——那里每条语句只执行一次，缓存没有收益，却会让句柄
 *      跨越后续的 ALTER 存活，平白引入"schema 变了但语句已编译"的疑问。见 statement() 的注释。
 */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { containsAnyString, defaultExplorerPlan, defaultPlanExploration, defaultThreadContextSummary, isVerificationRun, parsePlanValidationIssues, parseStringArray, parseThreadContextSummary, summarizeExplorerMessage, threadTitleMetadata } from "./records.js";
import { planQueryProjectionFor, type PlanQueryProjection } from "../plan/query.js";
import { stripPlanProtocol } from "../plan/completion.js";
import { updatePlanStatus } from "../plan/status-transition.js";
import { freezeRevision } from "../platform/freeze.js";
import { isRecord } from "../platform/guards.js";
import { REQUIRED_PLAN_AREAS } from "../platform/plan-requirements.js";
import { redactAuditPayload, redactAuditText } from "../platform/redaction.js";
import type { EventQuery, PipelineStore } from "./pipeline-store.js";
import { PRUNABLE_EVENT_TYPES, type EventPruneInput } from "./event-retention.js";
import type { AgentLoop, AgentLoopStep, AgentLoopStepInput } from "../agent/agent-loop.js";
import type { ExplorerTitleSource, ExplorerTitleStatus } from "../explorer/explorer-title.js";
import type { PlanDispatchState } from "../run/dispatch-coordinator.js";
import type { Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings } from "../project/project.js";
import type { GeneratedPlanSpec, ResolvedPlanContract, PlanValidationIssue } from "../plan/plan-spec.js";
import type {
  CandidatePlan,
  ChangeProposal,
  ChangeProposalStatus,
  DomainEvent,
  DurableToolCallStatus,
  ExecutionJournalEntry,
  ExecutionJournalPayload,
  ExecutionTelemetry,
  ExecutionThread,
  ExecutionThreadState,
  ExplorerDeletionInput,
  ExplorerDeletionSummary,
  ExplorerInputRequest,
  ExplorerInputRequestStatus,
  ExplorerPlan,
  ExplorerThread,
  ExplorerThreadState,
  ExplorerTurn,
  HookExecution,
  JournalEntryType,
  MergeRequest,
  ModelInputQuestion,
  PersistedToolCall,
  PlanExplorationStatus,
  PlanRevisionDraft,
  PlanRevisionDraftStatus,
  PlanRevision,
  PlanStatus,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  ProjectExecutionTurnStatus,
  RegisterThreadInput,
  Run,
  RunStatus,
  ToolCallResult,
  ToolName,
  ToolRole,
  VerificationRun,
  VerificationStatus,
} from "../index.js";

type SqliteRow = Record<string, unknown>;

function sqlIn(column: string, values: readonly string[]): { clause: string; values: string[] } | null {
  if (values.length === 0) return null;
  return { clause: `${column} IN (${values.map(() => "?").join(", ")})`, values: [...values] };
}

function parseRequestId(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

function normalizeSqliteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) return new Error("DATABASE_BUSY");
  return error instanceof Error ? error : new Error(message);
}

/**
 * 读已解析契约列。它现在是**必填事实**（`CandidatePlan` / `PlanRevision` / `PlanRevisionDraft` /
 * `ChangeProposal` 都把 `resolvedContract` 定为必填），所以读不到就是库里的行坏了。
 *
 * **抛错而不是回落到一个空形状**：一份"看着像契约、其实什么都没有"的对象会被下游当成真的事实
 * （执行者拿着空任务清单开工、验证按空命令集判 SKIPPED）。`owner` 是唯一能指出是哪一行的线索，
 * 新增调用点时务必写清。
 */
function resolvedContractFromRow(row: SqliteRow, owner: string): ResolvedPlanContract {
  const value = row.resolved_contract_json;
  if (value === null || value === undefined || value === "") throw new Error(`${owner} has no resolved contract`);
  return JSON.parse(String(value)) as ResolvedPlanContract;
}

/** 把已按 (聚合, 段号) 排好序的行切成段；只有一个元素的段不返回——它们没什么可合并的。 */
function groupTextSegments(rows: readonly SqliteRow[], keyOf: (row: SqliteRow) => string): SqliteRow[][] {
  const groups: SqliteRow[][] = [];
  let current: SqliteRow[] = [];
  let currentKey: string | null = null;
  for (const row of rows) {
    const key = keyOf(row);
    if (key !== currentKey) {
      if (current.length > 1) groups.push(current);
      current = [];
      currentKey = key;
    }
    current.push(row);
  }
  if (current.length > 1) groups.push(current);
  return groups;
}

/** 段内第一个非空字符串（读取方对 taskId / providerThreadId 的取法就是「第一个非空」）。 */
function firstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
}

/** 段内最后一个非空字符串（providerItemId 按读取方的取法是「最后一个非空」）。 */
function lastNonEmptyString(values: readonly unknown[]): string | undefined {
  let found: string | undefined;
  for (const value of values) if (typeof value === "string" && value) found = value;
  return found;
}

/** 语句缓存条目上限。取值理由见 SqlitePipelineStore#statement 的注释。 */
const STATEMENT_CACHE_LIMIT = 512;

/**
 * 构造选项。
 *
 * `retention` 缺省**关闭**，这是有意的：回收是**不可逆地删除用户数据**，不该在升级后第一次
 *   启动时悄悄开始。要启用就把 config 的 `storage.eventRetentionDays` 设成正数，
 *   并先看一眼它会删掉什么（白名单与判定规则见 store/event-retention.ts）。
 */
export type SqlitePipelineStoreOptions = {
  retention?: { retentionDays: number; minPerAggregate: number } | undefined;
};

/** SQLite Store；启动时负责幂等 migration，并保留事件、快照和运行历史。 */
export class SqlitePipelineStore implements PipelineStore {
  private readonly database: DatabaseSync;
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
  /**
   * SQL 文本 → 已编译语句。`DatabaseSync.prepare` 每次调用都会把 SQL 重新编译一遍，
   * 而本类 130 余处调用点里的绝大多数是"同一条 SQL 反复执行"（appendEvent、getProject、
   * listRuns……），重编译是纯粹的重复劳动。
   */
  private readonly statements = new Map<string, StatementSync>();
  /** 启动期事件回收策略；`undefined` 表示不回收。见 SqlitePipelineStoreOptions。 */
  private readonly retention: { retentionDays: number; minPerAggregate: number } | undefined;

  constructor(databasePath: string, options: SqlitePipelineStoreOptions = {}) {
    this.retention = options.retention;
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS factory_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        repo_root TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        status TEXT NOT NULL,
        current_explorer_thread_id TEXT,
        config_version INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS project_execution_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES factory_projects(id) ON DELETE CASCADE,
        provider_thread_id TEXT,
        model_override TEXT,
        reasoning_effort_override TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_execution_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES project_execution_threads(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        client_turn_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        loop_id TEXT,
        model TEXT,
        reasoning_effort TEXT,
        UNIQUE(thread_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS project_execution_client_turn_id ON project_execution_messages(thread_id, client_turn_id) WHERE client_turn_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS project_execution_messages_order ON project_execution_messages(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS project_config_revisions (
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, version)
      );
      CREATE TABLE IF NOT EXISTS explorer_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Explorer',
        created_at TEXT,
        title_source TEXT NOT NULL DEFAULT 'AUTO',
        title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER',
        context_mode TEXT NOT NULL DEFAULT 'FRESH',
        origin_thread_id TEXT,
        parent_thread_id TEXT,
        provider_thread_id TEXT,
        state TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary_ref TEXT,
        active_explorer_plan_id TEXT,
        context_summary_json TEXT,
        last_activity_at TEXT NOT NULL,
        exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE',
        exploration_missing_json TEXT NOT NULL DEFAULT '[]',
        exploration_completed_json TEXT NOT NULL DEFAULT '[]',
        exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]',
        candidate_plan_id TEXT,
        last_assessed_turn_id TEXT,
        active_revision_draft_id TEXT
      );
      CREATE TABLE IF NOT EXISTS explorer_plans (
        id TEXT PRIMARY KEY,
        explorer_thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'AUTO',
        title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER',
        message_count INTEGER NOT NULL DEFAULT 0,
        latest_user_message_summary TEXT,
        exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE',
        exploration_missing_json TEXT NOT NULL DEFAULT '[]',
        exploration_completed_json TEXT NOT NULL DEFAULT '[]',
        exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]',
        candidate_plan_id TEXT,
        new_plan_requested INTEGER NOT NULL DEFAULT 0,
        provider_thread_id TEXT,
        repository_context_key TEXT,
        last_assessed_turn_id TEXT,
        runtime_status TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        UNIQUE(explorer_thread_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS explorer_plans_thread_idx ON explorer_plans(explorer_thread_id, ordinal);
      CREATE TABLE IF NOT EXISTS explorer_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        error TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        explorer_plan_id TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        source_turn_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        queued_at TEXT,
        dispatched_at TEXT,
        run_id TEXT,
        last_event_at TEXT NOT NULL,
        attention_reason TEXT,
        generated_spec_json TEXT,
        resolved_contract_json TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_dispatch_states (
        plan_id TEXT PRIMARY KEY,
        revision INTEGER,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        wait_reason TEXT,
        queued_at TEXT NOT NULL,
        run_id TEXT,
        attempt INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        phase TEXT,
        automatic INTEGER NOT NULL DEFAULT 0,
        confirmed_by TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_plan_versions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        artifact_hash TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        project_config_version INTEGER,
        project_config_hash TEXT,
        project_config_snapshot_json TEXT,
        resolved_contract_json TEXT,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS plan_revision_drafts (
        draft_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        based_on_revision INTEGER NOT NULL,
        target_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        generated_spec_json TEXT,
        resolved_contract_json TEXT,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        source_turn_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        UNIQUE(plan_id, target_revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS plan_revision_drafts_active_uq
        ON plan_revision_drafts(plan_id)
        WHERE status IN ('EDITING', 'READY_TO_CONFIRM', 'BASE_CHANGED');
      CREATE TABLE IF NOT EXISTS change_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_changes_json TEXT NOT NULL,
        resolved_contract_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        revision INTEGER
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
        telemetry_json TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_journal (
        execution_thread_id TEXT NOT NULL REFERENCES execution_threads(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (execution_thread_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS hook_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        hook_type TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        command_id TEXT,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE (run_id, hook_type, attempt)
      );
      CREATE TABLE IF NOT EXISTS plan_query_projection (
        plan_id TEXT PRIMARY KEY REFERENCES candidate_plans(id),
        project_id TEXT NOT NULL REFERENCES factory_projects(id),
        source_explorer_thread_id TEXT NOT NULL REFERENCES explorer_threads(id),
        source_turn_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        queued_at TEXT,
        dispatched_at TEXT,
        last_event_at TEXT NOT NULL,
        run_id TEXT,
        attention_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS plan_query_projection_project_idx ON plan_query_projection(project_id, status, queued_at, last_event_at);
      CREATE INDEX IF NOT EXISTS plan_query_projection_source_idx ON plan_query_projection(source_explorer_thread_id, queued_at, last_event_at);
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        repair_attempts INTEGER NOT NULL,
        command_results_json TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS merge_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        status TEXT NOT NULL,
        human_confirmation_required INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        merged_at TEXT,
        detected_target_commit TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_loops (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        role TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        max_steps INTEGER NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        checkpoint_json TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_loop_steps (
        loop_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        status TEXT NOT NULL,
        call_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY(loop_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        call_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        role TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS domain_events_aggregate_idx ON domain_events(aggregate_id, sequence);
      -- 事件序号的高水位。**只有 pruneEvents 会写它**，用来记住"已经发到哪个号"。
      -- 没有它的话，回收删掉尾部若干行之后 appendEvent 的 MAX(sequence)+1 会**退回去**，
      -- 于是新事件复用了一个已经被客户端当作游标用过的号——已连接的客户端会用它去过滤
      -- （sequence > cursor），把那批新事件整段静默跳过。单行表，id 恒为 1。
      CREATE TABLE IF NOT EXISTS event_sequence_watermark (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explorer_input_requests (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        local_turn_id TEXT NOT NULL,
        provider_request_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        is_blocking INTEGER NOT NULL,
        auto_resolution_ms INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        answered_by TEXT,
        redacted_answer_summary_json TEXT,
        UNIQUE(provider_thread_id, provider_turn_id, provider_request_id)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      );
    `);
    try { this.database.exec("ALTER TABLE factory_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE factory_projects SET short_name = name WHERE short_name = ''").run();
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title TEXT NOT NULL DEFAULT 'New Explorer'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN created_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'AUTO'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER'"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET created_at = COALESCE(created_at, (SELECT MIN(created_at) FROM explorer_turns WHERE explorer_turns.thread_id = explorer_threads.id), last_activity_at) WHERE created_at IS NULL").run();
    this.database.prepare("UPDATE explorer_threads SET title_source = 'MANUAL', title_status = 'GENERATED' WHERE title NOT IN ('New Explorer', 'Previous exploration', 'ExplorerThread') AND title_source = 'AUTO' AND title_status = 'PLACEHOLDER'").run();
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'FRESH'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN origin_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET context_mode = 'LEGACY' WHERE title = 'New Explorer' AND id NOT LIKE 'explorer-%' AND (message_count > 0 OR provider_thread_id IS NOT NULL)").run();
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_missing_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_completed_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN candidate_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN last_assessed_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN active_revision_draft_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN active_explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN context_summary_json TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET exploration_missing_json = ? WHERE exploration_status = 'INCOMPLETE' AND last_assessed_turn_id IS NULL AND exploration_missing_json IN ('[]', '')").run(JSON.stringify(REQUIRED_PLAN_AREAS));
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETED'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN error TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_input_requests ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revision_drafts ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN runtime_status TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN new_plan_requested INTEGER NOT NULL DEFAULT 0"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN repository_context_key TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE explorer_turns SET status = 'FAILED', error = COALESCE(error, '历史记录未包含模型文本') WHERE role = 'assistant' AND trim(content) = '' AND status = 'COMPLETED'");
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN generated_spec_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN resolved_contract_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN source_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_item_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN dispatched_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN resolved_contract_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_query_projection ADD COLUMN dispatched_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN phase TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN confirmed_by TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN revision INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE merge_requests ADD COLUMN detected_target_commit TEXT"); } catch { /* Existing databases already have the column. */ }
    // reason 自 VerificationRun 类型引入时就存在，但建表语句一直漏了它，于是 SQLite 上
    // 该字段永远读不出来（内存实现却一直保留着）——同一个字段在两种存储下语义不同。
    // 补列而不是删字段：NO_PROJECT_VERIFICATION_COMMANDS 是"没配验证命令"的唯一凭据。
    try { this.database.exec("ALTER TABLE verification_runs ADD COLUMN reason TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec(`
      UPDATE candidate_plans
      SET dispatched_at = COALESCE(dispatched_at, queued_at)
      WHERE dispatched_at IS NULL
        AND queued_at IS NOT NULL
        AND status IN ('QUEUED', 'DISPATCHED', 'IN_PROGRESS', 'VERIFYING', 'MERGE_READY', 'MERGED', 'BLOCKED', 'NEEDS_PLAN_CHANGE');
      UPDATE candidate_plans
      SET status = 'DISPATCHED'
      WHERE status = 'QUEUED';
    `);
    try { this.database.exec("ALTER TABLE domain_events ADD COLUMN sequence INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE execution_threads ADD COLUMN telemetry_json TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE domain_events SET sequence = rowid WHERE sequence IS NULL");
    try { this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS domain_events_sequence_uq ON domain_events(sequence)"); } catch { /* Existing databases already have the index. */ }
    try { this.database.exec("ALTER TABLE change_proposals ADD COLUMN revision INTEGER"); } catch { /* Existing databases already have the column. */ }
    // ChangeProposal 的契约此前存在 `contract_json`（V1 镜像）里。镜像是那份**有损投影**，
    // 而提案要的是"提案人交上来的那份契约"——形状不同，没有迁移路径，只能另开一列。
    // 老库里这一列是空的（本机 0 行提案），真读到时会由 `resolvedContractFromRow` 点名报错。
    try { this.database.exec("ALTER TABLE change_proposals ADD COLUMN resolved_contract_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_version INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_hash TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_snapshot_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN source_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_item_id TEXT"); } catch { /* Existing databases already have the column. */ }
    // Plan 落盘副本的路径（确认时写入受管工程的计划目录）。存下来而不是运行时推算：推算值会随
    // planDirectory 配置漂移，"文件在哪"就成了一条会变的事实。
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN plan_document_path TEXT"); } catch { /* Existing databases already have the column. */ }
    // 老库的清理：这两样东西代码里已经不读不写了，留着只会让"历史遗留"在库里继续存在。
    // `revision_lifecycle_projection` 曾经是只写不读的表（连消费方都没有），
    // `provenance` 只区分"启动回填的只读修订"，而回填本身也删了（它会把正常确认的 Plan 标成 LEGACY）。
    // 两条都吞异常：新库上它们本来就不存在。
    try { this.database.exec("DROP TABLE IF EXISTS revision_lifecycle_projection"); } catch { /* 新库没有这张表。 */ }
    try { this.database.exec("ALTER TABLE plan_revisions DROP COLUMN provenance"); } catch { /* 新库没有这一列。 */ }
    // V1 扁平合同（`contract` 镜像）的四列一并丢掉：类型、读写点与落盘都删了，留着只等于把
    // "历史遗留"继续存在库里。镜像本身完全可推导，删列不丢事实。
    // 同族的 `pruneLegacyV1Plans` 也一并删除：它靠 `json_extract(contract_json, ...)` 找 V1 计划，
    // 列一没就没有识别依据，而盘点结果本来就是 0 份（见 docs 的 §6 附）。
    for (const table of ["candidate_plans", "plan_revisions", "plan_revision_drafts", "change_proposals"]) {
      try { this.database.exec(`ALTER TABLE ${table} DROP COLUMN contract_json`); } catch { /* 新库没有这一列。 */ }
    }
    // `execution_threads.journal_json` 是 journal 的**整体快照**，与 `execution_journal` 表是同一份
    // 事实的两份副本。它两个毛病都占全了：写侧每次 saveExecutionThread 都要把整份 journal 序列化
    // 一遍（实测最大 579 KB），而它只在 saveExecutionThread 时更新、appendExecutionJournal 不碰它，
    // 于是实测本机 18 个线程里 **13 个的快照与表已经对不上**——读路径早就改读表了（也只有表是对的）。
    // 先把"只有快照、表里没有"的历史线程搬进表，再丢列。
    this.backfillJournalRowsFromSnapshot();
    try { this.database.exec("ALTER TABLE execution_threads DROP COLUMN journal_json"); } catch { /* 新库没有这一列。 */ }
    this.backfillPlanDependencyIds();
    this.compactTextStreams();
    this.repairUnconfirmedProgressedPlans();
    this.repairOrphanedPlans();
    this.backfillExplorerPlans();
    this.backfillCandidateVersions();
    this.backfillLegacyVerificationRuns();
    this.backfillPlanQueryProjection();
    // 回收放在**所有修复与回填之后**：那几步要读历史事件（或至少要和历史状态对齐），
    // 先删再修会让它们看到一份被削过的历史。
    if (this.retention && this.retention.retentionDays > 0) this.pruneOnStartup(this.retention);
  }

  /**
   * 取一条已编译语句，没有就编译并记住。**方法体里的 SQL 一律走这里。**
   *
   * 为什么需要：`prepare` 把 SQL 文本解析成字节码，本类 130 余处调用点里绝大多数每次执行
   *   的都是同一条 SQL（`appendEvent` 在流式期间每秒被调几十次），不缓存等于反复编译同一段文本。
   *
   * 键是 SQL 文本本身，所以只有"文本确实不同"的调用才会各占一条——这一点是有意为之：
   *   带 `IN (?, ?, …)` 的语句（`sqlIn` 的返回值、`listEvents` 的 aggregateIds/types）文本随参数
   *   个数变化，参数个数有多少种就占多少条。`deleteExplorerCascade` 是唯一可能让它显著增长的
   *   调用方（一次删除会按被删 ID 个数生成十几条不同元数的 DELETE）。因此这里设了上限：
   *   超出即整体清空重建。清空是安全但粗暴的——它只是让下一轮调用重新编译一次，不会影响
   *   正确性；之所以不做 LRU，是因为触发它的场景本身很罕见，而为它维护访问序会让这个
   *   纯加速层变得比它加速的东西更复杂。
   *
   * 不缓存的三类调用（都直接写 `this.database.prepare`，见模块头提示 7）：
   *   构造函数的迁移区、`PRAGMA`/事务控制、以及 `exec` 系列——它们要么只跑一次，
   *   要么不是"语句"。
   *
   * 生命周期：node:sqlite 的 StatementSync 没有显式 finalize，持引用即在连接存活期内有效；
   *   `close()` 先清空本表再关连接，避免把句柄的释放交给 GC 去和连接关闭赛跑。
   */
  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    if (this.statements.size >= STATEMENT_CACHE_LIMIT) this.statements.clear();
    const prepared = this.database.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string { return `${prefix}-${randomUUID().slice(0, 12)}`; }

  runInTransaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original failure. */ }
      throw normalizeSqliteError(error);
    }
  }

  saveProject(project: Project): Project {
    this.statement(`
      INSERT INTO factory_projects (id, name, short_name, repo_root, default_branch, worktree_root, status, current_explorer_thread_id, config_version, config_hash, settings_json, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name, repo_root=excluded.repo_root, default_branch=excluded.default_branch, worktree_root=excluded.worktree_root, status=excluded.status, current_explorer_thread_id=excluded.current_explorer_thread_id, config_version=excluded.config_version, config_hash=excluded.config_hash, settings_json=excluded.settings_json, created_at=excluded.created_at, updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `).run(project.id, project.name, project.shortName, project.repoRoot, project.defaultBranch, project.worktreeRoot, project.status, project.currentExplorerThreadId, project.configVersion, project.configHash, JSON.stringify(project.settings), project.createdAt, project.updatedAt, project.archivedAt);
    return this.getProject(project.id) as Project;
  }

  getProject(projectId: string): Project | undefined {
    const row = this.statement("SELECT * FROM factory_projects WHERE id = ?").get(projectId) as SqliteRow | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  listProjects(): Project[] {
    const rows = this.statement("SELECT * FROM factory_projects ORDER BY name ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  updateProject(project: Project): Project {
    if (!this.getProject(project.id)) throw new Error(`Project ${project.id} does not exist`);
    return this.saveProject(project);
  }

  saveProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread {
    this.statement("INSERT OR IGNORE INTO project_execution_threads (id, project_id, provider_thread_id, model_override, reasoning_effort_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(thread.id, thread.projectId, thread.providerThreadId, thread.modelOverride, thread.reasoningEffortOverride, thread.createdAt, thread.updatedAt);
    return this.getProjectExecutionThread(thread.projectId) as ProjectExecutionThread;
  }

  getProjectExecutionThread(projectId: string): ProjectExecutionThread | undefined {
    const row = this.statement("SELECT * FROM project_execution_threads WHERE project_id = ?").get(projectId) as SqliteRow | undefined;
    return row ? { id: String(row.id), projectId: String(row.project_id), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), modelOverride: row.model_override === null ? null : String(row.model_override), reasoningEffortOverride: row.reasoning_effort_override === null ? null : String(row.reasoning_effort_override), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : undefined;
  }

  updateProjectExecutionThread(thread: ProjectExecutionThread): ProjectExecutionThread {
    this.statement("UPDATE project_execution_threads SET provider_thread_id = ?, model_override = ?, reasoning_effort_override = ?, updated_at = ? WHERE project_id = ?").run(thread.providerThreadId, thread.modelOverride, thread.reasoningEffortOverride, thread.updatedAt, thread.projectId);
    return this.getProjectExecutionThread(thread.projectId) as ProjectExecutionThread;
  }

  saveProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage {
    this.statement("INSERT OR IGNORE INTO project_execution_messages (id, thread_id, turn_id, client_turn_id, role, content, status, error, created_at, sequence, loop_id, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(message.id, message.threadId, message.turnId, message.clientTurnId, message.role, message.content, message.status, message.error, message.createdAt, message.sequence, message.loopId, message.model, message.reasoningEffort);
    if (message.clientTurnId) return this.getProjectExecutionMessageByClientTurnId(message.threadId, message.clientTurnId) as ProjectExecutionMessage;
    return this.listProjectExecutionMessages(message.threadId).find((item) => item.id === message.id) as ProjectExecutionMessage;
  }

  getProjectExecutionMessageByClientTurnId(threadId: string, clientTurnId: string): ProjectExecutionMessage | undefined {
    const row = this.statement("SELECT * FROM project_execution_messages WHERE thread_id = ? AND client_turn_id = ? AND role = 'user'").get(threadId, clientTurnId) as SqliteRow | undefined;
    return row ? this.projectExecutionMessageFromRow(row) : undefined;
  }

  listProjectExecutionMessages(threadId: string): ProjectExecutionMessage[] {
    const rows = this.statement("SELECT * FROM project_execution_messages WHERE thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    return rows.map((row) => this.projectExecutionMessageFromRow(row));
  }

  updateProjectExecutionMessage(message: ProjectExecutionMessage): ProjectExecutionMessage {
    this.statement("UPDATE project_execution_messages SET content = ?, status = ?, error = ?, loop_id = ?, model = ?, reasoning_effort = ? WHERE id = ? AND thread_id = ?").run(message.content, message.status, message.error, message.loopId, message.model, message.reasoningEffort, message.id, message.threadId);
    return this.listProjectExecutionMessages(message.threadId).find((item) => item.id === message.id) as ProjectExecutionMessage;
  }

  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision {
    this.statement("INSERT OR IGNORE INTO project_config_revisions (project_id, version, hash, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)").run(revision.projectId, revision.version, revision.hash, JSON.stringify(revision.snapshot), revision.createdAt);
    return this.listProjectConfigRevisions(revision.projectId).find((item) => item.version === revision.version) as ProjectConfigRevision;
  }

  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[] {
    const rows = this.statement("SELECT * FROM project_config_revisions WHERE project_id = ? ORDER BY version ASC").all(projectId) as unknown as SqliteRow[];
    return rows.map((row) => ({ projectId: String(row.project_id), version: Number(row.version), hash: String(row.hash), snapshot: JSON.parse(String(row.snapshot_json)) as ProjectExecutionSnapshot, createdAt: String(row.created_at) }));
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
    this.statement(`
      INSERT INTO explorer_threads (id, project_id, title, created_at, title_source, title_status, context_mode, origin_thread_id, parent_thread_id, provider_thread_id, state, message_count, summary_ref, active_explorer_plan_id, context_summary_json, last_activity_at, exploration_status, exploration_missing_json, exploration_completed_json, exploration_diagnostics_json, candidate_plan_id, last_assessed_turn_id, active_revision_draft_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, created_at=excluded.created_at, title_source=excluded.title_source, title_status=excluded.title_status, context_mode=excluded.context_mode, origin_thread_id=excluded.origin_thread_id, parent_thread_id=excluded.parent_thread_id
    `).run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.parentThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.activeExplorerPlanId, thread.contextSummary ? JSON.stringify(thread.contextSummary) : null, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), JSON.stringify(thread.exploration.diagnostics), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId, thread.activeRevisionDraftId);
    this.ensureExplorerPlansForThread(thread.id);
    return this.getThread(thread.id) as ExplorerThread;
  }

  getThread(id: string): ExplorerThread | undefined {
    const row = this.statement("SELECT * FROM explorer_threads WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.threadFromRow(row) : undefined;
  }

  listThreads(): ExplorerThread[] {
    const rows = this.statement("SELECT * FROM explorer_threads ORDER BY last_activity_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  updateThread(thread: ExplorerThread): ExplorerThread {
    this.statement("UPDATE explorer_threads SET title = ?, created_at = ?, title_source = ?, title_status = ?, context_mode = ?, origin_thread_id = ?, provider_thread_id = ?, state = ?, message_count = ?, summary_ref = ?, active_explorer_plan_id = ?, context_summary_json = ?, last_activity_at = ?, exploration_status = ?, exploration_missing_json = ?, exploration_completed_json = ?, exploration_diagnostics_json = ?, candidate_plan_id = ?, last_assessed_turn_id = ?, active_revision_draft_id = ? WHERE id = ?").run(thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.activeExplorerPlanId, thread.contextSummary ? JSON.stringify(thread.contextSummary) : null, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), JSON.stringify(thread.exploration.diagnostics), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId, thread.activeRevisionDraftId, thread.id);
    return this.getThread(thread.id) as ExplorerThread;
  }

  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    this.statement(`
      INSERT INTO explorer_plans (id, explorer_thread_id, project_id, ordinal, title, title_source, title_status, message_count, latest_user_message_summary, exploration_status, exploration_missing_json, exploration_completed_json, exploration_diagnostics_json, candidate_plan_id, new_plan_requested, provider_thread_id, repository_context_key, last_assessed_turn_id, runtime_status, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, title_source=excluded.title_source, title_status=excluded.title_status, message_count=excluded.message_count, latest_user_message_summary=excluded.latest_user_message_summary, exploration_status=excluded.exploration_status, exploration_missing_json=excluded.exploration_missing_json, exploration_completed_json=excluded.exploration_completed_json, exploration_diagnostics_json=excluded.exploration_diagnostics_json, candidate_plan_id=excluded.candidate_plan_id, new_plan_requested=excluded.new_plan_requested, provider_thread_id=excluded.provider_thread_id, repository_context_key=excluded.repository_context_key, last_assessed_turn_id=excluded.last_assessed_turn_id, runtime_status=excluded.runtime_status, last_activity_at=excluded.last_activity_at
    `).run(plan.id, plan.explorerThreadId, plan.projectId, plan.ordinal, plan.title, plan.titleSource, plan.titleStatus, plan.messageCount, plan.latestUserMessageSummary, plan.exploration.status, JSON.stringify(plan.exploration.missing), JSON.stringify(plan.exploration.completed), JSON.stringify(plan.exploration.diagnostics), plan.candidatePlanId, plan.newPlanRequested ? 1 : 0, plan.providerThreadId ?? null, plan.repositoryContextKey ?? null, plan.lastAssessedTurnId, plan.runtimeStatus ?? null, plan.createdAt, plan.lastActivityAt);
    return this.getExplorerPlan(plan.id) as ExplorerPlan;
  }

  getExplorerPlan(id: string): ExplorerPlan | undefined {
    const row = this.statement("SELECT * FROM explorer_plans WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.explorerPlanFromRow(row) : undefined;
  }

  listExplorerPlans(threadId?: string): ExplorerPlan[] {
    const rows = this.statement(`SELECT * FROM explorer_plans ${threadId ? "WHERE explorer_thread_id = ?" : ""} ORDER BY ordinal ASC, created_at ASC`).all(...(threadId ? [threadId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.explorerPlanFromRow(row));
  }

  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    if (!this.getExplorerPlan(plan.id)) throw new Error(`ExplorerPlan ${plan.id} does not exist`);
    return this.saveExplorerPlan(plan);
  }

  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    this.statement("INSERT INTO explorer_turns (id, thread_id, role, content, status, error, created_at, sequence, explorer_plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(turn.id, turn.threadId, turn.role, turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.createdAt, turn.sequence, turn.explorerPlanId ?? null);
    return turn;
  }

  updateTurn(turn: ExplorerTurn): ExplorerTurn {
    this.statement("UPDATE explorer_turns SET content = ?, status = ?, error = ? WHERE id = ?").run(turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.id);
    return this.listTurns(turn.threadId).find((item) => item.id === turn.id) as ExplorerTurn;
  }

  listTurns(threadId: string): ExplorerTurn[] {
    const rows = this.statement("SELECT * FROM explorer_turns WHERE thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    return rows.map((row) => ({ id: String(row.id), threadId: String(row.thread_id), role: String(row.role) as ExplorerTurn["role"], content: String(row.content), status: String(row.status ?? "COMPLETED") as NonNullable<ExplorerTurn["status"]>, ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), sequence: Number(row.sequence), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}) }));
  }

  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    const existing = this.statement("SELECT * FROM explorer_input_requests WHERE provider_thread_id = ? AND provider_turn_id = ? AND provider_request_id = ?").get(request.providerThreadId, request.providerTurnId, String(request.providerRequestId)) as SqliteRow | undefined;
    if (existing) return this.inputRequestFromRow(existing);
    if (request.isBlocking && this.statement("SELECT 1 FROM explorer_input_requests WHERE local_turn_id = ? AND is_blocking = 1 AND status = 'OPEN' LIMIT 1").get(request.localTurnId)) throw new Error(`Explorer turn ${request.localTurnId} already has an open blocking input request`);
    this.statement("INSERT INTO explorer_input_requests (id, thread_id, explorer_plan_id, local_turn_id, provider_request_id, provider_thread_id, provider_turn_id, item_id, questions_json, is_blocking, auto_resolution_ms, status, created_at, answered_at, answered_by, redacted_answer_summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.threadId, request.explorerPlanId ?? null, request.localTurnId, String(request.providerRequestId), request.providerThreadId, request.providerTurnId, request.itemId, JSON.stringify(request.questions), request.isBlocking ? 1 : 0, request.autoResolutionMs, request.status, request.createdAt, request.answeredAt, request.answeredBy, request.redactedAnswerSummary ? JSON.stringify(request.redactedAnswerSummary) : null);
    return this.getInputRequest(request.id) as ExplorerInputRequest;
  }

  getInputRequest(id: string): ExplorerInputRequest | undefined {
    const row = this.statement("SELECT * FROM explorer_input_requests WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.inputRequestFromRow(row) : undefined;
  }

  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[] {
    const rows = this.statement(`SELECT * FROM explorer_input_requests WHERE thread_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at ASC`).all(...(status ? [threadId, status] : [threadId])) as unknown as SqliteRow[];
    return rows.map((row) => this.inputRequestFromRow(row));
  }

  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    this.statement("UPDATE explorer_input_requests SET status = ?, answered_at = ?, answered_by = ?, redacted_answer_summary_json = ? WHERE id = ?").run(request.status, request.answeredAt, request.answeredBy, request.redactedAnswerSummary ? JSON.stringify(request.redactedAnswerSummary) : null, request.id);
    return this.getInputRequest(request.id) as ExplorerInputRequest;
  }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.statement(`
      INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, explorer_plan_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, title, revision, status, created_at, confirmed_by, confirmed_at, queued_at, dispatched_at, run_id, last_event_at, attention_reason, generated_spec_json, resolved_contract_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, explorer_plan_id=excluded.explorer_plan_id, source_turn_id=excluded.source_turn_id, provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id, provider_item_id=excluded.provider_item_id, title=excluded.title, revision=excluded.revision, status=excluded.status, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, queued_at=excluded.queued_at, dispatched_at=excluded.dispatched_at, run_id=excluded.run_id, last_event_at=excluded.last_event_at, attention_reason=excluded.attention_reason, generated_spec_json=excluded.generated_spec_json, resolved_contract_json=excluded.resolved_contract_json
    `).run(plan.id, plan.projectId, plan.sourceExplorerThreadId, plan.explorerPlanId ?? null, plan.sourceTurnId, plan.providerThreadId, plan.providerTurnId, plan.providerItemId, plan.title, plan.revision, plan.status, plan.createdAt, plan.confirmedBy, plan.confirmedAt, plan.queuedAt, plan.dispatchedAt ?? null, plan.runId, plan.lastEventAt, plan.attentionReason, plan.generatedSpec ? JSON.stringify(plan.generatedSpec) : null, JSON.stringify(plan.resolvedContract));
    // 这道守卫是**外键驱动**的，不是业务规则：plan_query_projection 对 project_id 与
    // source_explorer_thread_id 都建了 REFERENCES，而它所索引的 candidate_plans 自己**没有**这两条外键。
    // 索引表比事实表更严，于是只能靠守卫避免写投影时违反外键。
    // 因此**不要**把它"简化"成无条件写入：那会把 savePlan 从不抛错的 UPSERT 变成
    // project/thread 缺失时抛错的方法，而内存实现没有外键会静默成功——等于制造一个新的双实现分歧。
    // 守卫跳过的孤儿 Plan 由启动期的 repairOrphanedPlans 显式标记为 BLOCKED，不再静默消失。
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    return this.getPlan(plan.id) as CandidatePlan;
  }

  getPlan(id: string): CandidatePlan | undefined {
    const row = this.statement("SELECT * FROM candidate_plans WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.planFromRow(row) : undefined;
  }

  listPlans(): CandidatePlan[] {
    const rows = this.statement("SELECT * FROM candidate_plans ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.planFromRow(row));
  }

  updatePlan(plan: CandidatePlan): CandidatePlan { return this.savePlan(plan); }

  saveCandidateVersion(plan: CandidatePlan): CandidatePlan {
    this.statement("INSERT OR IGNORE INTO candidate_plan_versions (plan_id, revision, plan_json) VALUES (?, ?, ?)").run(plan.id, plan.revision, JSON.stringify(plan));
    return this.listCandidateVersions(plan.id).find((item) => item.revision === plan.revision)!;
  }

  listCandidateVersions(planId: string): CandidatePlan[] {
    const rows = this.statement("SELECT plan_json FROM candidate_plan_versions WHERE plan_id = ? ORDER BY revision ASC").all(planId) as unknown as SqliteRow[];
    return rows.map((row) => JSON.parse(String(row.plan_json)) as CandidatePlan);
  }

  saveDispatchState(state: PlanDispatchState): PlanDispatchState {
    this.statement(`
      INSERT INTO plan_dispatch_states (plan_id, revision, project_id, status, wait_reason, queued_at, run_id, attempt, updated_at, last_error, phase, automatic, confirmed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET revision=excluded.revision, project_id=excluded.project_id, status=excluded.status, wait_reason=excluded.wait_reason, queued_at=excluded.queued_at, run_id=excluded.run_id, attempt=excluded.attempt, updated_at=excluded.updated_at, last_error=excluded.last_error, phase=excluded.phase, automatic=excluded.automatic, confirmed_by=excluded.confirmed_by
    `).run(state.planId, state.revision ?? null, state.projectId, state.status, state.waitReason, state.queuedAt, state.runId, state.attempt, state.updatedAt, state.lastError, state.phase ?? null, state.automatic ? 1 : 0, state.confirmedBy ?? null);
    return this.getDispatchState(state.planId) as PlanDispatchState;
  }

  deleteDispatchState(planId: string): void {
    this.statement("DELETE FROM plan_dispatch_states WHERE plan_id = ?").run(planId);
  }

  getDispatchState(planId: string): PlanDispatchState | undefined {
    const row = this.statement("SELECT * FROM plan_dispatch_states WHERE plan_id = ?").get(planId) as SqliteRow | undefined;
    return row ? this.dispatchStateFromRow(row) : undefined;
  }

  listDispatchStates(projectId?: string): PlanDispatchState[] {
    const rows = this.statement(`SELECT * FROM plan_dispatch_states ${projectId ? "WHERE project_id = ?" : ""} ORDER BY queued_at ASC, plan_id ASC`).all(...(projectId ? [projectId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.dispatchStateFromRow(row));
  }

  saveRevision(revision: PlanRevision): PlanRevision {
    this.statement("INSERT OR IGNORE INTO plan_revisions (plan_id, revision, artifact_hash, confirmed_by, confirmed_at, source_explorer_thread_id, explorer_plan_id, project_config_version, project_config_hash, project_config_snapshot_json, resolved_contract_json, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, plan_document_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revision.planId, revision.revision, revision.artifactHash, revision.confirmedBy, revision.confirmedAt, revision.sourceExplorerThreadId, revision.explorerPlanId ?? null, revision.projectConfigVersion ?? null, revision.projectConfigHash ?? null, revision.projectConfigSnapshot ? JSON.stringify(revision.projectConfigSnapshot) : null, JSON.stringify(revision.resolvedContract), revision.sourceTurnId ?? null, revision.providerThreadId ?? null, revision.providerTurnId ?? null, revision.providerItemId ?? null, revision.planDocumentPath ?? null);
    return this.getRevision(revision.planId, revision.revision) as PlanRevision;
  }

  getRevision(planId: string, revision: number): PlanRevision | undefined {
    const row = this.statement("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?").get(planId, revision) as SqliteRow | undefined;
    if (!row) return undefined;
    return freezeRevision({ planId: String(row.plan_id), revision: Number(row.revision), resolvedContract: resolvedContractFromRow(row, `Plan revision ${planId}@${revision}`), artifactHash: String(row.artifact_hash), ...(row.plan_document_path === null || row.plan_document_path === undefined ? {} : { planDocumentPath: String(row.plan_document_path) }), confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at), sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id === null || row.explorer_plan_id === undefined ? {} : { explorerPlanId: String(row.explorer_plan_id) }), sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null || row.provider_turn_id === undefined ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null || row.provider_item_id === undefined ? null : String(row.provider_item_id), ...(row.project_config_version === null || row.project_config_version === undefined ? {} : { projectConfigVersion: Number(row.project_config_version) }), ...(row.project_config_hash === null || row.project_config_hash === undefined ? {} : { projectConfigHash: String(row.project_config_hash) }), ...(row.project_config_snapshot_json === null || row.project_config_snapshot_json === undefined ? {} : { projectConfigSnapshot: JSON.parse(String(row.project_config_snapshot_json)) as ProjectExecutionSnapshot }) });
  }

  listRevisions(planId: string): PlanRevision[] {
    const rows = this.statement("SELECT revision FROM plan_revisions WHERE plan_id = ? ORDER BY revision ASC").all(planId) as unknown as SqliteRow[];
    return rows.map((row) => this.getRevision(planId, Number(row.revision))!).filter(Boolean);
  }

  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    this.statement("INSERT INTO plan_revision_drafts (draft_id, plan_id, project_id, based_on_revision, target_revision, status, title, generated_spec_json, resolved_contract_json, source_explorer_thread_id, explorer_plan_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, base_branch, base_commit, created_at, updated_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(draft.draftId, draft.planId, draft.projectId, draft.basedOnRevision, draft.targetRevision, draft.status, draft.title, draft.generatedSpec ? JSON.stringify(draft.generatedSpec) : null, JSON.stringify(draft.resolvedContract), draft.sourceExplorerThreadId, draft.explorerPlanId ?? null, draft.sourceTurnId, draft.providerThreadId, draft.providerTurnId, draft.providerItemId, draft.baseBranch, draft.baseCommit, draft.createdAt, draft.updatedAt, draft.confirmedAt);
    return this.getRevisionDraft(draft.draftId)!;
  }
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined {
    const row = this.statement("SELECT * FROM plan_revision_drafts WHERE draft_id = ?").get(draftId) as SqliteRow | undefined;
    return row ? this.revisionDraftFromRow(row) : undefined;
  }
  listRevisionDrafts(planId?: string): PlanRevisionDraft[] {
    const rows = this.statement(`SELECT * FROM plan_revision_drafts ${planId ? "WHERE plan_id = ?" : ""} ORDER BY target_revision ASC, created_at ASC`).all(...(planId ? [planId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.revisionDraftFromRow(row));
  }
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    this.statement("UPDATE plan_revision_drafts SET status = ?, title = ?, generated_spec_json = ?, resolved_contract_json = ?, source_explorer_thread_id = ?, explorer_plan_id = ?, source_turn_id = ?, provider_thread_id = ?, provider_turn_id = ?, provider_item_id = ?, base_branch = ?, base_commit = ?, updated_at = ?, confirmed_at = ? WHERE draft_id = ?").run(draft.status, draft.title, draft.generatedSpec ? JSON.stringify(draft.generatedSpec) : null, JSON.stringify(draft.resolvedContract), draft.sourceExplorerThreadId, draft.explorerPlanId ?? null, draft.sourceTurnId, draft.providerThreadId, draft.providerTurnId, draft.providerItemId, draft.baseBranch, draft.baseCommit, draft.updatedAt, draft.confirmedAt, draft.draftId);
    return this.getRevisionDraft(draft.draftId)!;
  }

  saveChangeProposal(proposal: ChangeProposal): ChangeProposal {
    this.statement("INSERT OR IGNORE INTO change_proposals (id, run_id, plan_id, reason, requested_changes_json, resolved_contract_json, status, created_at, created_by, decided_at, decided_by, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(proposal.id, proposal.runId, proposal.planId, proposal.reason, JSON.stringify(proposal.requestedChanges), JSON.stringify(proposal.resolvedContract), proposal.status, proposal.createdAt, proposal.createdBy, proposal.decidedAt, proposal.decidedBy, proposal.revision);
    return this.getChangeProposal(proposal.id) as ChangeProposal;
  }

  getChangeProposal(id: string): ChangeProposal | undefined {
    const row = this.statement("SELECT * FROM change_proposals WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.changeProposalFromRow(row) : undefined;
  }

  listChangeProposals(runId?: string): ChangeProposal[] {
    const rows = this.statement(`SELECT * FROM change_proposals ${runId ? "WHERE run_id = ?" : ""} ORDER BY created_at ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.changeProposalFromRow(row));
  }

  updateChangeProposal(proposal: ChangeProposal): ChangeProposal {
    this.statement("UPDATE change_proposals SET status = ?, decided_at = ?, decided_by = ?, revision = ? WHERE id = ?").run(proposal.status, proposal.decidedAt, proposal.decidedBy, proposal.revision, proposal.id);
    return this.getChangeProposal(proposal.id) as ChangeProposal;
  }

  saveRun(run: Run): Run {
    this.statement("INSERT INTO runs (id, project_id, plan_id, plan_revision, status, branch, workspace_path, base_commit, execution_thread_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, workspace_path=excluded.workspace_path, started_at=excluded.started_at").run(run.id, run.projectId, run.planId, run.planRevision, run.status, run.branch, run.workspacePath, run.baseCommit, run.executionThreadId, run.createdAt, run.startedAt);
    return this.getRun(run.id) as Run;
  }

  getRun(runId: string): Run | undefined {
    const row = this.statement("SELECT * FROM runs WHERE id = ?").get(runId) as SqliteRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.statement("SELECT * FROM runs ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.runFromRow(row));
  }

  saveExecutionThread(thread: ExecutionThread): ExecutionThread {
    const safe = { ...thread, journal: thread.journal.map((entry) => ({ ...entry, payload: redactAuditPayload(entry.payload) as ExecutionJournalPayload })) };
    this.statement("INSERT INTO execution_threads (id, run_id, state, telemetry_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, telemetry_json=excluded.telemetry_json").run(safe.id, safe.runId, safe.state, safe.telemetry ? JSON.stringify(safe.telemetry) : null);
    for (const entry of safe.journal) {
      this.statement("INSERT OR IGNORE INTO execution_journal (execution_thread_id, run_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(safe.id, safe.runId, entry.sequence, entry.type, entry.occurredAt, JSON.stringify(entry.payload));
    }
    return this.getExecutionThread(safe.id) as ExecutionThread;
  }

  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry {
    // 归属校验只查一次主键。**不要改成 getExecutionThread**：那条路会把这 1,600+ 行的 journal
    // 全读出来解析一遍，而它是逐条追加调用的（每追加一条就读一次全部 → O(n²)）。
    const owner = this.statement("SELECT run_id FROM execution_threads WHERE id = ?").get(input.executionThreadId) as SqliteRow | undefined;
    if (!owner || String(owner.run_id) !== input.runId) throw new Error(`ExecutionThread ${input.executionThreadId} does not belong to Run ${input.runId}`);
    const sequence = Number((this.statement("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM execution_journal WHERE run_id = ?").get(input.runId) as SqliteRow).next_sequence);
    const entry: ExecutionJournalEntry = { sequence, type: input.type, occurredAt: input.occurredAt ?? this.now(), payload: redactAuditPayload(input.payload) as ExecutionJournalPayload };
    this.statement("INSERT INTO execution_journal (execution_thread_id, run_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(input.executionThreadId, input.runId, entry.sequence, entry.type, entry.occurredAt, JSON.stringify(entry.payload));
    return entry;
  }

  saveHookExecution(execution: HookExecution): HookExecution {
    const safe = { ...execution, stdout: redactAuditText(execution.stdout), stderr: redactAuditText(execution.stderr) };
    this.statement("INSERT OR IGNORE INTO hook_executions (id, run_id, hook_type, attempt, command_id, cwd, timeout_ms, status, exit_code, stdout, stderr, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(safe.id, safe.runId, safe.hookType, safe.attempt, safe.commandId, safe.cwd, safe.timeoutMs, safe.status, safe.exitCode, safe.stdout, safe.stderr, safe.startedAt, safe.completedAt);
    return this.getHookExecution(safe.runId, safe.hookType, safe.attempt) as HookExecution;
  }

  getHookExecution(runId: string, hookType: HookExecution["hookType"], attempt: number): HookExecution | undefined {
    const row = this.statement("SELECT * FROM hook_executions WHERE run_id = ? AND hook_type = ? AND attempt = ?").get(runId, hookType, attempt) as SqliteRow | undefined;
    return row ? this.hookExecutionFromRow(row) : undefined;
  }

  listHookExecutions(runId?: string): HookExecution[] {
    const rows = this.statement(`SELECT * FROM hook_executions ${runId ? "WHERE run_id = ?" : ""} ORDER BY started_at ASC, attempt ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.hookExecutionFromRow(row));
  }

  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection {
    this.statement("INSERT INTO plan_query_projection (plan_id, project_id, source_explorer_thread_id, source_turn_id, title, goal, revision, status, priority, created_at, queued_at, dispatched_at, last_event_at, run_id, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, source_turn_id=excluded.source_turn_id, title=excluded.title, goal=excluded.goal, revision=excluded.revision, status=excluded.status, priority=excluded.priority, created_at=excluded.created_at, queued_at=excluded.queued_at, dispatched_at=excluded.dispatched_at, last_event_at=excluded.last_event_at, run_id=excluded.run_id, attention_reason=excluded.attention_reason").run(projection.planId, projection.projectId, projection.sourceExplorerThreadId, projection.sourceTurnId, projection.title, projection.goal, projection.revision, projection.status, projection.priority, projection.createdAt, projection.queuedAt, projection.dispatchedAt ?? null, projection.lastEventAt, projection.runId, projection.attentionReason);
    return this.getPlanQueryProjection(projection.planId) as PlanQueryProjection;
  }

  getPlanQueryProjection(planId: string): PlanQueryProjection | undefined {
    const row = this.statement("SELECT * FROM plan_query_projection WHERE plan_id = ?").get(planId) as SqliteRow | undefined;
    return row ? this.planQueryProjectionFromRow(row) : undefined;
  }

  listPlanQueryProjection(projectId?: string): PlanQueryProjection[] {
    const rows = this.statement(`SELECT * FROM plan_query_projection ${projectId ? "WHERE project_id = ?" : ""} ORDER BY created_at ASC, plan_id ASC`).all(...(projectId ? [projectId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.planQueryProjectionFromRow(row));
  }

  saveVerificationRun(verification: VerificationRun): VerificationRun {
    this.statement("INSERT OR IGNORE INTO verification_runs (id, run_id, status, repair_attempts, command_results_json, completed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(verification.id, verification.runId, verification.status, verification.repairAttempts, JSON.stringify(verification.commandResults), verification.completedAt, verification.reason ?? null);
    return this.getVerificationById(verification.id) as VerificationRun;
  }

  getVerificationRun(runId: string): VerificationRun | undefined {
    const row = this.statement("SELECT * FROM verification_runs WHERE run_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(runId) as SqliteRow | undefined;
    return row ? this.verificationFromRow(row) : undefined;
  }

  listVerificationRuns(runId?: string): VerificationRun[] {
    const rows = this.statement(`SELECT * FROM verification_runs ${runId ? "WHERE run_id = ?" : ""} ORDER BY completed_at ASC, rowid ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.verificationFromRow(row));
  }

  private backfillLegacyVerificationRuns(): void {
    const insert = this.statement("INSERT OR IGNORE INTO verification_runs (id, run_id, status, repair_attempts, command_results_json, completed_at) VALUES (?, ?, ?, ?, ?, ?)");
    // 读**执行日志表**而不是那个整体快照：快照只在 saveExecutionThread 时更新，而 journal 是逐条
    // 追加的，两者实测已经对不上（本机 18 个线程里 13 个不一致）——拿它当修复依据会漏掉最近的条目。
    const rows = this.statement("SELECT payload_json FROM execution_journal WHERE type = 'VERIFICATION'").all() as unknown as SqliteRow[];
    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(String(row.payload_json)); } catch { continue; }
      if (!isVerificationRun(payload)) continue;
      insert.run(payload.id, payload.runId, payload.status, payload.repairAttempts, JSON.stringify(payload.commandResults), payload.completedAt);
    }
  }

  saveMergeRequest(request: MergeRequest): MergeRequest {
    this.statement("INSERT OR IGNORE INTO merge_requests (id, run_id, plan_id, source_commit, target_branch, status, human_confirmation_required, created_at, merged_at, detected_target_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.runId, request.planId, request.sourceCommit, request.targetBranch, request.status, request.humanConfirmationRequired ? 1 : 0, request.createdAt, request.mergedAt, request.detectedTargetCommit ?? null);
    return this.getMergeRequest(request.id) as MergeRequest;
  }

  getMergeRequest(requestId: string): MergeRequest | undefined {
    const row = this.statement("SELECT * FROM merge_requests WHERE id = ?").get(requestId) as SqliteRow | undefined;
    return row ? this.mergeRequestFromRow(row) : undefined;
  }

  findMergeRequestByRun(runId: string): MergeRequest | undefined {
    const row = this.statement("SELECT * FROM merge_requests WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as SqliteRow | undefined;
    return row ? this.mergeRequestFromRow(row) : undefined;
  }

  listMergeRequests(): MergeRequest[] {
    const rows = this.statement("SELECT * FROM merge_requests ORDER BY created_at ASC, rowid ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.mergeRequestFromRow(row));
  }

  updateMergeRequest(request: MergeRequest): MergeRequest {
    this.statement("UPDATE merge_requests SET status = ?, merged_at = ?, detected_target_commit = ? WHERE id = ?").run(request.status, request.mergedAt, request.detectedTargetCommit ?? null, request.id);
    return this.getMergeRequest(request.id) as MergeRequest;
  }

  saveAgentLoop(loop: AgentLoop): AgentLoop {
    this.statement(`
      INSERT INTO agent_loops (id, owner_type, owner_id, role, mode, state, step_count, max_steps, started_at, completed_at, provider_thread_id, provider_turn_id, checkpoint_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_type=excluded.owner_type, owner_id=excluded.owner_id, role=excluded.role, mode=excluded.mode, state=excluded.state, step_count=excluded.step_count, max_steps=excluded.max_steps, started_at=excluded.started_at, completed_at=excluded.completed_at, provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id, checkpoint_json=excluded.checkpoint_json
    `).run(loop.id, loop.ownerType, loop.ownerId, loop.role, loop.mode, loop.state, loop.stepCount, loop.maxSteps, loop.startedAt, loop.completedAt, loop.providerThreadId, loop.providerTurnId, loop.checkpointJson);
    return this.getAgentLoop(loop.id) as AgentLoop;
  }

  getAgentLoop(loopId: string): AgentLoop | undefined {
    const row = this.statement("SELECT * FROM agent_loops WHERE id = ?").get(loopId) as SqliteRow | undefined;
    return row ? this.agentLoopFromRow(row) : undefined;
  }

  listAgentLoops(ownerId?: string): AgentLoop[] {
    const rows = this.statement(`SELECT * FROM agent_loops ${ownerId ? "WHERE owner_id = ?" : ""} ORDER BY rowid ASC`).all(...(ownerId ? [ownerId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.agentLoopFromRow(row));
  }

  updateAgentLoop(loop: AgentLoop): AgentLoop {
    if (!this.getAgentLoop(loop.id)) throw new Error(`AgentLoop ${loop.id} does not exist`);
    return this.saveAgentLoop(loop);
  }

  appendAgentLoopStep(input: AgentLoopStepInput): AgentLoopStep {
    const nextSequence = Number((this.statement("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_loop_steps WHERE loop_id = ?").get(input.loopId) as SqliteRow).next_sequence);
    const step: AgentLoopStep = { ...input, callId: input.callId ?? null, providerThreadId: input.providerThreadId ?? null, providerTurnId: input.providerTurnId ?? null, sequence: nextSequence, occurredAt: input.occurredAt ?? this.now() };
    this.statement("INSERT INTO agent_loop_steps (loop_id, sequence, step_type, status, call_id, provider_thread_id, provider_turn_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(step.loopId, step.sequence, step.stepType, step.status, step.callId, step.providerThreadId, step.providerTurnId, JSON.stringify(step.payload), step.occurredAt);
    return step;
  }

  listAgentLoopSteps(loopId: string, options: { stepTypes?: readonly string[] } = {}): AgentLoopStep[] {
    const stepTypes = options.stepTypes;
    if (stepTypes && stepTypes.length === 0) return [];
    const filter = stepTypes ? ` AND step_type IN (${stepTypes.map(() => "?").join(", ")})` : "";
    const params: string[] = stepTypes ? [loopId, ...stepTypes] : [loopId];
    const rows = this.statement(`SELECT * FROM agent_loop_steps WHERE loop_id = ?${filter} ORDER BY sequence ASC`).all(...params) as unknown as SqliteRow[];
    return rows.map((row) => this.agentLoopStepFromRow(row));
  }

  getLastAgentLoopStepSequence(loopId: string): number {
    const row = this.statement("SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM agent_loop_steps WHERE loop_id = ?").get(loopId) as SqliteRow;
    return Number(row.last_sequence ?? 0);
  }

  recoverAgentLoops(): AgentLoop[] { return this.listAgentLoops().filter((loop) => loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED"); }

  saveToolCall(call: PersistedToolCall): PersistedToolCall {
    this.statement("INSERT OR IGNORE INTO tool_calls (call_id, loop_id, role, tool, status, input_hash, result_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(call.callId, call.loopId, call.role, call.tool, call.status, call.inputHash, call.result ? JSON.stringify(call.result) : null, call.startedAt, call.completedAt);
    return this.getToolCall(call.callId) as PersistedToolCall;
  }

  getToolCall(callId: string): PersistedToolCall | undefined {
    const row = this.statement("SELECT * FROM tool_calls WHERE call_id = ?").get(callId) as SqliteRow | undefined;
    return row ? this.toolCallFromRow(row) : undefined;
  }

  listToolCalls(loopId?: string): PersistedToolCall[] {
    const rows = this.statement(`SELECT * FROM tool_calls ${loopId ? "WHERE loop_id = ?" : ""} ORDER BY started_at ASC`).all(...(loopId ? [loopId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.toolCallFromRow(row));
  }

  updateToolCall(call: PersistedToolCall): PersistedToolCall {
    if (!this.getToolCall(call.callId)) throw new Error(`Tool call ${call.callId} does not exist`);
    this.statement("UPDATE tool_calls SET status = ?, result_json = ?, completed_at = ? WHERE call_id = ?").run(call.status, call.result ? JSON.stringify(call.result) : null, call.completedAt, call.callId);
    return this.getToolCall(call.callId) as PersistedToolCall;
  }

  getExecutionThread(threadId: string): ExecutionThread | undefined {
    const row = this.statement("SELECT * FROM execution_threads WHERE id = ?").get(threadId) as SqliteRow | undefined;
    if (!row) return undefined;
    const journalRows = this.statement("SELECT sequence, type, occurred_at, payload_json FROM execution_journal WHERE execution_thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    const journal = journalRows.map((entry) => ({ sequence: Number(entry.sequence), type: String(entry.type) as JournalEntryType, occurredAt: String(entry.occurred_at), payload: JSON.parse(String(entry.payload_json)) as ExecutionJournalPayload }));
    const telemetry = typeof row.telemetry_json === "string" && row.telemetry_json.length > 0 ? JSON.parse(row.telemetry_json) as ExecutionTelemetry : null;
    return { id: String(row.id), runId: String(row.run_id), state: String(row.state) as ExecutionThreadState, journal, telemetry };
  }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent {
    const saved: DomainEvent = { ...event, payload: redactAuditPayload(event.payload), id: this.nextId("event"), sequence: Number((this.statement("SELECT MAX(COALESCE((SELECT MAX(sequence) FROM domain_events), 0), COALESCE((SELECT last_sequence FROM event_sequence_watermark WHERE id = 1), 0)) + 1 AS next_sequence").get() as SqliteRow).next_sequence), occurredAt: this.now() };
    this.statement("INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(saved.id, saved.sequence, saved.type, saved.aggregateId, saved.occurredAt, JSON.stringify(saved.payload));
    for (const listener of this.eventListeners) listener(saved);
    return saved;
  }

  subscribeEvents(listener: (event: DomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listEvents(options: EventQuery = {}): DomainEvent[] {
    // aggregateIds 用于"一次取多个聚合的事件"，走 domain_events_aggregate_idx；
    // 它替代的是"读全表再在内存里筛"，对十万级事件表是数量级的差别。
    const aggregateIds = options.aggregateIds?.length ? options.aggregateIds : null;
    const types = options.types?.length ? options.types : null;
    if (aggregateIds && options.aggregateId) throw new Error("listEvents accepts either aggregateId or aggregateIds, not both");
    const clauses: string[] = ["sequence > ?"];
    const params: Array<string | number> = [options.afterSequence ?? 0];
    if (options.aggregateId) {
      clauses.push("aggregate_id = ?");
      params.push(options.aggregateId);
    } else if (aggregateIds) {
      clauses.push(`aggregate_id IN (${aggregateIds.map(() => "?").join(", ")})`);
      params.push(...aggregateIds);
    }
    // 事件类型的取值集合很小且集中，按类型过滤能再砍掉大量与调用方无关的行。
    if (types) {
      clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
    const where = clauses.join(" AND ");
    // limit 语义分两端，由 limitFrom 决定：
    //   tail（缺省）= "最新的 N 条"：先倒序截断再恢复升序，避免为了取尾部而加载全部历史。
    //   head        = "游标之后最早的 N 条"：游标式增量读取用这个，直接 LIMIT 即可。
    const sql = options.limit === undefined
      ? `SELECT * FROM domain_events WHERE ${where} ORDER BY sequence ASC`
      : options.limitFrom === "head"
        ? `SELECT * FROM domain_events WHERE ${where} ORDER BY sequence ASC LIMIT ?`
        : `SELECT * FROM (SELECT * FROM domain_events WHERE ${where} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC`;
    if (options.limit !== undefined) params.push(options.limit);
    const rows = this.statement(sql).all(...params) as unknown as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      type: String(row.type) as DomainEvent["type"],
      aggregateId: String(row.aggregate_id),
      occurredAt: String(row.occurred_at),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  getLastEventSequence(aggregateId?: string): number {
    const row = this.statement(`SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM domain_events ${aggregateId ? "WHERE aggregate_id = ?" : ""}`).get(...(aggregateId ? [aggregateId] : [])) as SqliteRow;
    return Number(row.last_sequence ?? 0);
  }

  pruneEvents(input: EventPruneInput): { deleted: number } {
    // 这条 SQL 是 store/event-retention.ts 那套规则的**规格翻译**——两处必须逐条对应，
    // 改那边就要改这里（C2 的契约套件会在同一份数据上跑两个实现来兜住这件事）：
    //   可回收 = type 在白名单里（`run.executor.event` 曾按 MODEL_OUTPUT 载荷进过白名单，
    //   已在真实数据上验证不成立后移除——见 event-retention.ts 的说明）
    //   每个聚合的**可回收事件**里最近的 minPerAggregate 条无条件留下
    //   其余里 occurred_at 早于 cutoff 的才删
    // minPerAggregate <= 0 时 `rank <= 0` 恒假、子查询为空、NOT IN (空) 恒真，等价于"不保底"，
    // 所以这里不需要为它写分支。
    const prunable = `(type IN (${PRUNABLE_EVENT_TYPES.map(() => "?").join(", ")}))`;
    const scope = [...PRUNABLE_EVENT_TYPES];
    // **先记高水位，再删行**。顺序不能反：万一在中间崩了，"记了高水位但没删"只是下次启动
    // 重删一遍（MAX 是幂等的），而"删了但没记"会让序号退回去。也正因为顺序本身就保证了安全，
    // 这里**不依赖事务**——启动期的调用方虽然会把它包进 runInTransaction，但直接调用
    // （契约测试就是这么调的）同样不会造成序号回退。
    this.statement(`
      INSERT INTO event_sequence_watermark (id, last_sequence)
      VALUES (1, COALESCE((SELECT MAX(sequence) FROM domain_events), 0))
      ON CONFLICT(id) DO UPDATE SET last_sequence = MAX(event_sequence_watermark.last_sequence, excluded.last_sequence)
    `).run();
    const info = this.statement(`
      DELETE FROM domain_events
      WHERE ${prunable}
        AND occurred_at < ?
        AND sequence NOT IN (
          SELECT sequence FROM (
            SELECT sequence, ROW_NUMBER() OVER (PARTITION BY aggregate_id ORDER BY sequence DESC) AS rank
            FROM domain_events
            WHERE ${prunable}
          ) WHERE rank <= ?
        )
    `).run(...scope, input.cutoff, ...scope, input.minPerAggregate);
    return { deleted: Number(info.changes) };
  }

  /**
   * 启动期回收一次。把配置里的"保留多少天"换算成时间点放在这里做——配置说的是策略，
   * 换算成具体时间点是存储层的职责（也让 pruneEvents 本身保持"入参决定一切"）。
   */
  private pruneOnStartup(policy: { retentionDays: number; minPerAggregate: number }): void {
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    try {
      const { deleted } = this.runInTransaction(() => this.pruneEvents({ cutoff, minPerAggregate: policy.minPerAggregate }));
      // VACUUM 不在这里做：它会重写整个数据库文件，对几十兆的库是秒级阻塞。WAL 截断足够
      // 让回收后的空间在进程退出时被归还，真正的体积回收交给运维在停机窗口执行 VACUUM。
      if (deleted > 0) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // 回收失败**不能挡住启动**：它只是清理，库本身仍然可用，下次启动再试。
      // 这里没有更细的上报通道（domain 层不写日志），所以明确吞掉——留着这条注释，
      // 免得后来者以为这里漏了错误处理。
    }
  }

  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary {
    const project = this.getProject(input.projectId);
    const replacement = this.getThread(input.replacementExplorerId);
    if (!project || !replacement || replacement.projectId !== input.projectId || replacement.id === input.explorerId) throw new Error("Explorer deletion replacement is invalid");
    if (project.currentExplorerThreadId === input.explorerId) this.statement("UPDATE factory_projects SET current_explorer_thread_id = ?, updated_at = ? WHERE id = ?").run(replacement.id, this.now(), input.projectId);

    const explorerPlanIds = sqlIn("id", input.explorerPlanIds);
    const planIds = sqlIn("plan_id", input.planIds);
    const planEntityIds = sqlIn("id", input.planIds);
    const runIds = sqlIn("run_id", input.runIds);
    const runEntityIds = sqlIn("id", input.runIds);
    const loopIds = sqlIn("loop_id", input.agentLoopIds);
    const loopEntityIds = sqlIn("id", input.agentLoopIds);
    const executionThreadEntityIds = sqlIn("id", input.executionThreadIds);

    if (runIds) {
      this.statement(`DELETE FROM execution_journal WHERE ${runIds.clause}`).run(...runIds.values);
      this.statement(`DELETE FROM hook_executions WHERE ${runIds.clause}`).run(...runIds.values);
      this.statement(`DELETE FROM verification_runs WHERE ${runIds.clause}`).run(...runIds.values);
      this.statement(`DELETE FROM merge_requests WHERE ${runIds.clause}`).run(...runIds.values);
    }
    if (loopIds) {
      this.statement(`DELETE FROM agent_loop_steps WHERE ${loopIds.clause}`).run(...loopIds.values);
      this.statement(`DELETE FROM tool_calls WHERE ${loopIds.clause}`).run(...loopIds.values);
      if (loopEntityIds) this.statement(`DELETE FROM agent_loops WHERE ${loopEntityIds.clause}`).run(...loopEntityIds.values);
    }
    if (executionThreadEntityIds) this.statement(`DELETE FROM execution_threads WHERE ${executionThreadEntityIds.clause}`).run(...executionThreadEntityIds.values);
    if (runEntityIds) this.statement(`DELETE FROM runs WHERE ${runEntityIds.clause}`).run(...runEntityIds.values);
    if (planIds) {
      this.statement(`DELETE FROM change_proposals WHERE ${planIds.clause}`).run(...planIds.values);
      this.statement(`DELETE FROM plan_dispatch_states WHERE ${planIds.clause}`).run(...planIds.values);
      this.statement(`DELETE FROM plan_revisions WHERE ${planIds.clause}`).run(...planIds.values);
      this.statement(`DELETE FROM plan_revision_drafts WHERE ${planIds.clause}`).run(...planIds.values);
      this.statement(`DELETE FROM candidate_plan_versions WHERE ${planIds.clause}`).run(...planIds.values);
      this.statement(`DELETE FROM plan_query_projection WHERE ${planIds.clause}`).run(...planIds.values);
      if (planEntityIds) this.statement(`DELETE FROM candidate_plans WHERE ${planEntityIds.clause}`).run(...planEntityIds.values);
    }
    if (explorerPlanIds) this.statement(`DELETE FROM explorer_plans WHERE ${explorerPlanIds.clause}`).run(...explorerPlanIds.values);
    const inputRequestIds = sqlIn("id", input.inputRequestIds);
    if (inputRequestIds) this.statement(`DELETE FROM explorer_input_requests WHERE thread_id = ? OR ${inputRequestIds.clause}`).run(input.explorerId, ...inputRequestIds.values);
    else this.statement("DELETE FROM explorer_input_requests WHERE thread_id = ?").run(input.explorerId);
    this.statement("DELETE FROM explorer_turns WHERE thread_id = ?").run(input.explorerId);

    const deletedIds = new Set([input.explorerId, ...input.explorerPlanIds, ...input.turnIds, ...input.planIds, ...input.runIds, ...input.executionThreadIds, ...input.agentLoopIds, ...input.inputRequestIds]);
    const idempotencyRows = this.statement("SELECT scope, key, result_json FROM idempotency_keys").all() as unknown as SqliteRow[];
    for (const row of idempotencyRows) {
      let result: unknown;
      try { result = JSON.parse(String(row.result_json)); } catch { continue; }
      if (containsAnyString(result, deletedIds)) this.statement("DELETE FROM idempotency_keys WHERE scope = ? AND key = ?").run(String(row.scope), String(row.key));
    }
    this.statement("DELETE FROM explorer_threads WHERE id = ? AND project_id = ?").run(input.explorerId, input.projectId);
    return { taskCount: input.explorerPlanIds.length, planCount: input.planIds.length, runCount: input.runIds.length };
  }

  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined {
    const row = this.statement("SELECT result_json FROM idempotency_keys WHERE scope = ? AND key = ?").get(scope, key) as SqliteRow | undefined;
    return row ? JSON.parse(String(row.result_json)) as Record<string, unknown> : undefined;
  }

  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void {
    this.statement("INSERT OR IGNORE INTO idempotency_keys (scope, key, result_json, created_at) VALUES (?, ?, ?, ?)").run(scope, key, JSON.stringify(result), this.now());
  }

  close(): void {
    this.statements.clear();
    this.database.close();
  }

  private projectFromRow(row: SqliteRow): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      shortName: String(row.short_name ?? row.name),
      repoRoot: String(row.repo_root),
      defaultBranch: String(row.default_branch),
      worktreeRoot: String(row.worktree_root),
      status: String(row.status) as Project["status"],
      currentExplorerThreadId: row.current_explorer_thread_id === null || row.current_explorer_thread_id === undefined ? null : String(row.current_explorer_thread_id),
      configVersion: Number(row.config_version),
      configHash: String(row.config_hash),
      settings: JSON.parse(String(row.settings_json)) as ProjectSettings,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
    };
  }

  private projectExecutionMessageFromRow(row: SqliteRow): ProjectExecutionMessage {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      clientTurnId: row.client_turn_id === null ? null : String(row.client_turn_id),
      role: String(row.role) as ProjectExecutionMessage["role"],
      content: String(row.content),
      status: String(row.status) as ProjectExecutionTurnStatus,
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      sequence: Number(row.sequence),
      loopId: row.loop_id === null ? null : String(row.loop_id),
      model: row.model === null ? null : String(row.model),
      reasoningEffort: row.reasoning_effort === null ? null : String(row.reasoning_effort),
    };
  }

  private threadFromRow(row: SqliteRow): ExplorerThread {
    const lastActivityAt = String(row.last_activity_at);
    return {
      id: String(row.id), projectId: String(row.project_id), title: String(row.title ?? "New Explorer"), createdAt: String(row.created_at ?? lastActivityAt),
      titleSource: String(row.title_source ?? "AUTO") as ExplorerTitleSource, titleStatus: String(row.title_status ?? "PLACEHOLDER") as ExplorerTitleStatus,
      contextMode: String(row.context_mode ?? "FRESH") as ExplorerThread["contextMode"],
      originThreadId: row.origin_thread_id === null || row.origin_thread_id === undefined ? null : String(row.origin_thread_id),
      parentThreadId: row.parent_thread_id === null ? null : String(row.parent_thread_id),
      providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id),
      state: String(row.state) as ExplorerThreadState, messageCount: Number(row.message_count),
      summaryRef: row.summary_ref === null ? null : String(row.summary_ref),
      activeExplorerPlanId: row.active_explorer_plan_id === null || row.active_explorer_plan_id === undefined ? null : String(row.active_explorer_plan_id),
      contextSummary: parseThreadContextSummary(row.context_summary_json, lastActivityAt), lastActivityAt,
      exploration: { status: String(row.exploration_status ?? "INCOMPLETE") as PlanExplorationStatus, missing: parseStringArray(row.exploration_missing_json, [...REQUIRED_PLAN_AREAS]), completed: parseStringArray(row.exploration_completed_json, []), diagnostics: parsePlanValidationIssues(row.exploration_diagnostics_json), candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id) },
      activeRevisionDraftId: row.active_revision_draft_id === null || row.active_revision_draft_id === undefined ? null : String(row.active_revision_draft_id),
    };
  }

  private explorerPlanFromRow(row: SqliteRow): ExplorerPlan {
    return {
      id: String(row.id), explorerThreadId: String(row.explorer_thread_id), projectId: String(row.project_id), ordinal: Number(row.ordinal),
      title: String(row.title), titleSource: String(row.title_source ?? "AUTO") as ExplorerTitleSource, titleStatus: String(row.title_status ?? "PLACEHOLDER") as ExplorerTitleStatus,
      messageCount: Number(row.message_count ?? 0), latestUserMessageSummary: row.latest_user_message_summary === null || row.latest_user_message_summary === undefined ? null : String(row.latest_user_message_summary),
      exploration: { status: String(row.exploration_status ?? "INCOMPLETE") as PlanExplorationStatus, missing: parseStringArray(row.exploration_missing_json, [...REQUIRED_PLAN_AREAS]), completed: parseStringArray(row.exploration_completed_json, []), diagnostics: parsePlanValidationIssues(row.exploration_diagnostics_json), candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id) },
      newPlanRequested: Number(row.new_plan_requested ?? 0) === 1,
      providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id),
      repositoryContextKey: row.repository_context_key === null || row.repository_context_key === undefined ? null : String(row.repository_context_key),
      candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id), ...(row.runtime_status === null || row.runtime_status === undefined ? {} : { runtimeStatus: String(row.runtime_status) as NonNullable<ExplorerTurn["status"]> }), createdAt: String(row.created_at), lastActivityAt: String(row.last_activity_at),
    };
  }

  private inputRequestFromRow(row: SqliteRow): ExplorerInputRequest {
    return {
      id: String(row.id), threadId: String(row.thread_id), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}), localTurnId: String(row.local_turn_id),
      providerRequestId: parseRequestId(String(row.provider_request_id)), providerThreadId: String(row.provider_thread_id), providerTurnId: String(row.provider_turn_id), itemId: String(row.item_id),
      questions: JSON.parse(String(row.questions_json)) as ModelInputQuestion[], isBlocking: Number(row.is_blocking) === 1, autoResolutionMs: row.auto_resolution_ms === null ? null : Number(row.auto_resolution_ms), status: String(row.status) as ExplorerInputRequestStatus,
      createdAt: String(row.created_at), answeredAt: row.answered_at === null ? null : String(row.answered_at), answeredBy: row.answered_by === null ? null : String(row.answered_by), redactedAnswerSummary: row.redacted_answer_summary_json === null ? null : JSON.parse(String(row.redacted_answer_summary_json)) as Record<string, unknown>,
    };
  }

  private getVerificationById(id: string): VerificationRun | undefined {
    const row = this.statement("SELECT * FROM verification_runs WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.verificationFromRow(row) : undefined;
  }

  private verificationFromRow(row: SqliteRow): VerificationRun {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      status: String(row.status) as VerificationStatus,
      repairAttempts: Number(row.repair_attempts),
      commandResults: JSON.parse(String(row.command_results_json)) as VerificationRun["commandResults"],
      completedAt: String(row.completed_at),
      // 老库与历史回填的行没有 reason（列为 NULL），此时不补默认值：
      // "未记录"与"已记录为未配置验证命令"是两件事，界面要能区分。
      ...(row.reason === "NO_PROJECT_VERIFICATION_COMMANDS" ? { reason: "NO_PROJECT_VERIFICATION_COMMANDS" as const } : {}),
    };
  }

  private hookExecutionFromRow(row: SqliteRow): HookExecution {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      hookType: String(row.hook_type) as HookExecution["hookType"],
      attempt: Number(row.attempt),
      commandId: row.command_id === null || row.command_id === undefined ? null : String(row.command_id),
      cwd: String(row.cwd),
      timeoutMs: Number(row.timeout_ms),
      status: String(row.status) as HookExecution["status"],
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      stdout: String(row.stdout),
      stderr: String(row.stderr),
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
    };
  }

  private planQueryProjectionFromRow(row: SqliteRow): PlanQueryProjection {
    return {
      planId: String(row.plan_id),
      projectId: String(row.project_id),
      sourceExplorerThreadId: String(row.source_explorer_thread_id),
      sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id),
      title: String(row.title),
      goal: String(row.goal),
      revision: Number(row.revision),
      status: String(row.status) as PlanStatus,
      priority: Number(row.priority),
      createdAt: String(row.created_at),
      queuedAt: row.queued_at === null || row.queued_at === undefined ? null : String(row.queued_at),
      dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined ? null : String(row.dispatched_at),
      lastEventAt: String(row.last_event_at),
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      attentionReason: row.attention_reason === null || row.attention_reason === undefined ? null : String(row.attention_reason),
    };
  }

  private revisionDraftFromRow(row: SqliteRow): PlanRevisionDraft {
    return Object.freeze({
      draftId: String(row.draft_id), planId: String(row.plan_id), projectId: String(row.project_id), basedOnRevision: Number(row.based_on_revision), targetRevision: Number(row.target_revision), status: String(row.status) as PlanRevisionDraftStatus,
      title: String(row.title), resolvedContract: resolvedContractFromRow(row, `Revision draft ${String(row.draft_id)}`),
      ...(row.generated_spec_json ? { generatedSpec: JSON.parse(String(row.generated_spec_json)) as GeneratedPlanSpec } : {}),
      sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id === null || row.explorer_plan_id === undefined ? {} : { explorerPlanId: String(row.explorer_plan_id) }), sourceTurnId: row.source_turn_id === null ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null ? null : String(row.provider_item_id),
      baseBranch: String(row.base_branch), baseCommit: String(row.base_commit), createdAt: String(row.created_at), updatedAt: String(row.updated_at), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    });
  }

  /** 为新旧线程确保至少存在一个 Plan，并把历史事实归入默认 Plan。 */
  private ensureExplorerPlansForThread(threadId: string): void {
    const thread = this.getThread(threadId);
    if (!thread) return;
    let plans = this.listExplorerPlans(threadId);
    if (plans.length === 0) {
      const plan = defaultExplorerPlan(thread, this.nextId("explorer-plan"), 1, thread.lastActivityAt);
      this.saveExplorerPlan(plan);
      plans = [plan];
    }
    const activePlan = plans.find((plan) => plan.id === thread.activeExplorerPlanId) ?? plans[0];
    if (!activePlan) return;
    for (const turn of this.listTurns(threadId)) {
      if (!turn.explorerPlanId) this.statement("UPDATE explorer_turns SET explorer_plan_id = ? WHERE id = ?").run(activePlan.id, turn.id);
    }
    for (const plan of this.listPlans().filter((item) => item.sourceExplorerThreadId === threadId)) {
      if (plan.explorerPlanId) continue;
      const owner = plan.sourceTurnId ? this.listTurns(threadId).find((turn) => turn.id === plan.sourceTurnId) : undefined;
      this.statement("UPDATE candidate_plans SET explorer_plan_id = ? WHERE id = ?").run(owner?.explorerPlanId ?? activePlan.id, plan.id);
    }
    for (const request of this.listInputRequests(threadId)) {
      if (!request.explorerPlanId) this.statement("UPDATE explorer_input_requests SET explorer_plan_id = ? WHERE id = ?").run(activePlan.id, request.id);
    }
    const current = this.getThread(threadId)!;
    const associatedPlans = this.listPlans().filter((plan) => plan.sourceExplorerThreadId === threadId);
    for (const plan of plans) {
      const planTurns = this.listTurns(threadId).filter((turn) => turn.explorerPlanId === plan.id);
      const latestUser = [...planTurns].reverse().find((turn) => turn.role === "user");
      const latestAssistant = [...planTurns].reverse().find((turn) => turn.role === "assistant");
      const associatedCandidate = associatedPlans.filter((item) => item.explorerPlanId === plan.id && item.status === "DRAFT").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const legacyProjection = plans.length === 1 && plan.id === activePlan.id && planTurns.length > 0 ? current.exploration : plan.exploration;
      const selectedCandidateId = plan.newPlanRequested ? null : plan.candidatePlanId ?? associatedCandidate?.id ?? legacyProjection.candidatePlanId;
      this.saveExplorerPlan({
        ...plan,
        messageCount: planTurns.length || plan.messageCount,
        latestUserMessageSummary: latestUser ? summarizeExplorerMessage(latestUser.content) : plan.latestUserMessageSummary,
        exploration: { ...legacyProjection, candidatePlanId: selectedCandidateId },
        candidatePlanId: selectedCandidateId,
        newPlanRequested: Boolean(plan.newPlanRequested),
        lastAssessedTurnId: legacyProjection.lastAssessedTurnId ?? plan.lastAssessedTurnId,
        ...(latestAssistant?.status ? { runtimeStatus: latestAssistant.status } : {}),
      });
    }
    const refreshedPlans = this.listExplorerPlans(threadId);
    const contextSummary = current.contextSummary ?? defaultThreadContextSummary(current.lastActivityAt);
    const completedPlans = refreshedPlans.filter((plan) => plan.exploration.status === "READY").map((plan) => {
      const candidate = plan.candidatePlanId ? this.getPlan(plan.candidatePlanId) : undefined;
      return { explorerPlanId: plan.id, title: plan.title, status: plan.exploration.status, goal: candidate?.resolvedContract.objective.goal ?? null, keyConstraints: [...(candidate?.generatedSpec?.design?.technicalConstraints ?? [])], latestUserMessageSummary: plan.latestUserMessageSummary };
    });
    const updatedSummary = { ...contextSummary, completedPlans, openPlanIds: refreshedPlans.filter((plan) => plan.exploration.status !== "READY").map((plan) => plan.id) };
    this.statement("UPDATE explorer_threads SET active_explorer_plan_id = ?, context_summary_json = ? WHERE id = ?").run(activePlan.id, JSON.stringify(updatedSummary), threadId);
  }

  private backfillExplorerPlans(): void {
    for (const thread of this.listThreads()) this.ensureExplorerPlansForThread(thread.id);
  }

  /**
   * 旧版本可能只保存了 queued/dispatched 事实，没有保存确认事实。
   * 这类记录不能继续被当作可执行 Plan，保留历史时间但转入 BLOCKED，等待重新确认。
   */
  private repairUnconfirmedProgressedPlans(): void {
    const rows = this.statement("SELECT * FROM candidate_plans WHERE confirmed_at IS NULL AND status IN (?, ?, ?, ?, ?, ?, ?, ?)").all("READY", "QUEUED", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED") as unknown as SqliteRow[];
    const hasConfirmationEvent = this.statement("SELECT 1 AS present FROM domain_events WHERE aggregate_id = ? AND type IN (?, ?, ?) LIMIT 1");
    for (const row of rows) {
      const planId = String(row.id);
      if (hasConfirmationEvent.get(planId, "plan.confirmed", "plan.revision.confirmed", "plan.configuration.revised")) continue;
      const plan = this.planFromRow(row);
      const reason = "Plan lifecycle is invalid: it reached a later state without a confirmation record.";
      const repairedAt = this.now();
      updatePlanStatus(this, plan, { status: "BLOCKED", attentionReason: reason, lastEventAt: repairedAt }, reason);
    }
  }

  private backfillPlanQueryProjection(): void {
    // 守卫与 savePlan 里的是同一条、同样是**外键驱动**的（见 savePlan 的说明）。
    // 被它挡下的孤儿 Plan 由 repairOrphanedPlans 标成 BLOCKED，所以"每次重启再漏一次"不再无声。
    for (const plan of this.listPlans()) {
      if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    }
  }

  /**
   * 把"已确认之后、却指向已不存在的 ExplorerThread"的 Plan 标成 BLOCKED。
   *
   * 为什么需要它：savePlan 的投影守卫会跳过这类 Plan，于是它们既不进 Plan Center（投影没写），
   *   状态又停留在 READY/QUEUED 之类**看起来可执行**的值上——用户只看到计划"不见了"，
   *   没有任何可追查的线索。改成 BLOCKED + attentionReason 之后走的是既有展示链路
   *   （attentionReason 已在前端"需要关注"里），孤儿事实变得可见。
   *
   * **只查 source_explorer_thread_id，不查 project_id**：领域层允许"有 Plan 却没有 Project 行"
   *   （PlanService.registerThread + createCandidatePlan 不需要先建 Project，多个领域测试正是这么用的），
   *   所以"项目不存在"不是损坏信号，把它当孤儿会把正常数据误判成 BLOCKED。
   *   来源线程则相反：它由 ExplorerService 与 Plan 成对创建、由 deleteExplorerCascade 成对删除，
   *   缺失只可能来自历史脏数据或漏删路径。
   *
   * 与 repairUnconfirmedProgressedPlans 的分工：那条管"没有确认记录却已推进"，本条管"确认了但来源线程没了"。
   * 幂等：修完后状态不再落在下面的集合里，重启不会重复处理。
   */
  private repairOrphanedPlans(): void {
    const rows = this.statement(`
      SELECT * FROM candidate_plans
      WHERE status IN (?, ?, ?, ?, ?, ?, ?, ?)
        AND source_explorer_thread_id NOT IN (SELECT id FROM explorer_threads)
    `).all("READY", "QUEUED", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED") as unknown as SqliteRow[];
    for (const row of rows) {
      const plan = this.planFromRow(row);
      const reason = "Plan source is missing: its source ExplorerThread no longer exists.";
      updatePlanStatus(this, plan, { status: "BLOCKED", attentionReason: reason, lastEventAt: this.now() }, reason);
    }
  }

  /**
   * 删除两簇"另有副本"的正文事件。**与压实不同**：它们不能合并——合并会把正文挪到别的活动事件之后，
   * 打乱事件流的时序——只能**确认副本存在后删除**。
   *
   * 判据**逐个聚合验证，不抽样**（这是 event-retention.ts 用 9,408 条真实垃圾换来的教训）：
   *   - `agent.model.text.delta`（步骤镜像的逐字重复）：该 loop 的重复正文总量 ≤ 步骤行正文总量。
   *   - `explorer.turn.text.delta`：剥掉计划协议块之后**逐字等于** `explorer_turns.content`。
   * 不满足的行一律保留。实测本机 33 个回合里有 3 个不满足：两个**被取消**的回合
   * （content 被替换成"本轮已取消"，模型的原始输出只在这批事件里）与一个 content 被后续覆盖的回合。
   *
   * **自验证**：每次启动重新判一遍。所以"当时验不过"的行不会被误删，将来副本补齐了也还会被清掉。
   * 删完这两簇之后剩下的是几十行到几百行，稳态下这一步几乎不花时间。
   */
  private deleteDuplicatedTextEvents(): void {
    // 簇一：同一 loop 的重复正文不得超过该 loop 步骤行里的正文。求和与顺序无关，可以直接用 SQL。
    const duplicated = this.statement(`
      SELECT d.aggregate_id AS loop_id,
             SUM(LENGTH(json_extract(d.payload_json, '$.text'))) AS duplicate_bytes,
             COALESCE((SELECT SUM(LENGTH(json_extract(s.payload_json, '$.text')))
                       FROM agent_loop_steps s
                       WHERE s.loop_id = d.aggregate_id AND s.step_type = 'MODEL_TEXT_DELTA'), 0) AS step_bytes
      FROM domain_events d
      WHERE d.type = 'agent.model.text.delta'
      GROUP BY d.aggregate_id
    `).all() as unknown as SqliteRow[];
    for (const row of duplicated) {
      const duplicateBytes = Number(row.duplicate_bytes ?? 0);
      if (duplicateBytes === 0 || duplicateBytes > Number(row.step_bytes ?? 0)) continue;
      this.statement("DELETE FROM domain_events WHERE type = 'agent.model.text.delta' AND aggregate_id = ?").run(String(row.loop_id));
    }

    // 簇二：按 (线程, 回合) 分组，逐条按发生顺序拼回原文再比对——GROUP_CONCAT 的拼接顺序在 SQLite 里
    // 是未定义的，而这里的一致性判断是删除的唯一依据，不能建立在"实践中好像是插入顺序"上。
    const turnEvents = this.statement("SELECT aggregate_id, json_extract(payload_json, '$.turnId') AS turn_id, json_extract(payload_json, '$.text') AS text FROM domain_events WHERE type = 'explorer.turn.text.delta' ORDER BY aggregate_id, turn_id, sequence").all() as unknown as SqliteRow[];
    const byTurn = new Map<string, { threadId: string; turnId: unknown; text: string }>();
    for (const row of turnEvents) {
      const key = `${String(row.aggregate_id)}\u0000${String(row.turn_id)}`;
      const current = byTurn.get(key) ?? { threadId: String(row.aggregate_id), turnId: row.turn_id, text: "" };
      current.text += String(row.text ?? "");
      byTurn.set(key, current);
    }
    for (const group of byTurn.values()) {
      if (group.turnId === null || group.turnId === undefined) continue;
      const turn = this.statement("SELECT content FROM explorer_turns WHERE id = ?").get(String(group.turnId)) as SqliteRow | undefined;
      if (!turn) continue;
      if (stripPlanProtocol(group.text) !== String(turn.content ?? "")) continue;
      this.statement("DELETE FROM domain_events WHERE type = 'explorer.turn.text.delta' AND aggregate_id = ? AND json_extract(payload_json, '$.turnId') = ?").run(group.threadId, String(group.turnId));
    }
  }

  /**
   * 启动期收缩历史的正文碎片：能合并的按段合并，能证明「另有副本」的直接删除。
   *
   * 这些碎片是写侧的旧节奏留下的：正文刷新曾是 160 字符阈值**或 40ms 定时器**，低速率输出下
   * 定时器主导——实测本机 `agent_loop_steps` 60,161 行里 57,445 行是 `MODEL_TEXT_DELTA`、
   * 文本长度**中位数 2 个字符**，`execution_journal`、`domain_events` 里同形。
   *
   * **合并**（规则与读取方逐字相同，所以读数不变）：
   *   - `agent_loop_steps`：同 loop 内**连续**的 `MODEL_TEXT_DELTA`——中间夹任何别的步骤就断开
   *     （explorer-activity 合并 ASSISTANT_MESSAGE 的边界就是它）。
   *   - `execution_journal`：同 run 内连续、且 `modelStep` 与 `providerItemId` 都不变的 `MODEL_OUTPUT`
   *     （web 的 projectExecutionJournal 用的就是这套 key）。
   *   - `domain_events`：带内层序号的两簇（步骤镜像、journal 镜像），见 `compactTextEventSegments`。
   *   每段保留**首行**的 sequence 与 occurred_at，正文拼接、`providerItemId` 取段内最后一个非空、
   *   `taskId` / `providerThreadId` / `providerTurnId` 取段内第一个非空——这正是读取方会算出来的值。
   *   丢掉的是每个碎片各自的毫秒级时间戳，而读取方从不用它。
   *
   * **删除**：`agent.model.text.delta` 与 `explorer.turn.text.delta` 两簇不能合并（合并会把正文挪到
   * 别的活动事件之后，打乱事件流时序），只能逐个聚合验过副本存在后删除，见 `deleteDuplicatedTextEvents`。
   *
   * **不可逆**（经确认后加入）。幂等：合并过的段不再有相邻同类行，验过副本的簇也已删除，再跑是空操作。
   */
  private compactTextStreams(): void {
    this.database.exec("BEGIN");
    try {
      // **先记高水位，再删行**（与 pruneEvents 同一条规矩，理由见那里的注释）：压实会删掉某些聚合的
      // 尾部事件，删完 MAX(sequence) 会退回去，而事件序号正是客户端重连时的游标。
      this.statement(`
        INSERT INTO event_sequence_watermark (id, last_sequence)
        VALUES (1, COALESCE((SELECT MAX(sequence) FROM domain_events), 0))
        ON CONFLICT(id) DO UPDATE SET last_sequence = MAX(event_sequence_watermark.last_sequence, excluded.last_sequence)
      `).run();
      this.compactStepsTextSegments();
      this.compactJournalTextSegments();
      this.compactTextEventSegments();
      this.deleteDuplicatedTextEvents();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 事件表里**带内层序号**的正文碎片。
   *
   * 这一版只处理两类：`agent.step.model_text_delta`（`agent_loop_steps` 那一行的事件镜像）
   * 与 `run.executor.event` 里带 `payload.sequence` 的 MODEL_OUTPUT（`execution_journal` 的镜像）。
   *
   * 段的判据是**载荷里的内层序号**相邻，不是事件序号相邻——实测本机：同 type + 同 aggregate
   * 且事件序号相邻的行是 **0**。事件流本身是交错的：每 40ms 一次刷新会同时写步骤镜像与那条遗留重复
   * （`agent.model.text.delta`），两者把对方的序号隔开。内层序号才是"它对应哪一行步骤 / journal"，
   * 所以合并出来的段与两张表压实后的段一一对应。
   *
   * **没有内层序号的两簇（`agent.model.text.delta`、`explorer.turn.text.delta`）不在这里处理**：
   * 前者是步骤镜像的历史重复、后者是探索回合正文的历史重复，都属于"另有副本"的中间态，
   * 该按回收策略删除而不是合并——但删之前要逐个聚合验证副本确实存在，那是另一件事。
   */
  private compactTextEventSegments(): void {
    const rows = this.statement(`
      WITH text_events AS (
        SELECT id, sequence, aggregate_id, type, payload_json,
               LAG(json_extract(payload_json, '$.sequence')) OVER (PARTITION BY aggregate_id, type ORDER BY sequence) AS prev_inner,
               LAG(json_extract(payload_json, '$.modelStep')) OVER (PARTITION BY aggregate_id, type ORDER BY sequence) AS prev_step,
               LAG(json_extract(payload_json, '$.providerItemId')) OVER (PARTITION BY aggregate_id, type ORDER BY sequence) AS prev_item
        FROM domain_events
        WHERE type = 'agent.step.model_text_delta'
           OR (type = 'run.executor.event' AND json_extract(payload_json, '$.type') = 'MODEL_OUTPUT' AND json_extract(payload_json, '$.sequence') IS NOT NULL)
      ), grouped AS (
        SELECT id, sequence, aggregate_id, type, payload_json,
               SUM(CASE WHEN prev_inner = json_extract(payload_json, '$.sequence') - 1
                         AND (json_extract(payload_json, '$.providerItemId') IS prev_item)
                         AND (json_extract(payload_json, '$.modelStep') IS prev_step)
                   THEN 0 ELSE 1 END)
                 OVER (PARTITION BY aggregate_id, type ORDER BY sequence) AS segment
        FROM text_events
      )
      SELECT aggregate_id, type, segment, id, sequence, payload_json
      FROM grouped
      ORDER BY aggregate_id, type, segment, sequence
    `).all() as unknown as SqliteRow[];
    for (const group of groupTextSegments(rows, (row) => `${String(row.aggregate_id)}\u0000${String(row.type)}\u0000${String(row.segment)}`)) {
      const first = group[0]!;
      const payloads = group.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
      const merged: Record<string, unknown> = { ...payloads[0], text: payloads.map((payload) => String(payload.text ?? "")).join("") };
      const itemId = lastNonEmptyString(payloads.map((payload) => payload.providerItemId));
      if (itemId) merged.providerItemId = itemId;
      const taskId = firstNonEmptyString(payloads.map((payload) => payload.taskId));
      if (taskId) merged.taskId = taskId;
      const threadId = firstNonEmptyString(payloads.map((payload) => payload.providerThreadId));
      if (threadId) merged.providerThreadId = threadId;
      const turnId = firstNonEmptyString(payloads.map((payload) => payload.providerTurnId));
      if (turnId) merged.providerTurnId = turnId;
      this.statement("UPDATE domain_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(merged), String(first.id));
      for (const row of group.slice(1)) this.statement("DELETE FROM domain_events WHERE id = ?").run(String(row.id));
    }
  }

  /** 步骤表：同 loop 内连续的 MODEL_TEXT_DELTA 合成一条（seq 相邻 = 中间没有别的步骤）。 */
  private compactStepsTextSegments(): void {
    const rows = this.statement(`
      WITH text_steps AS (
        SELECT loop_id, sequence, payload_json,
               LAG(sequence) OVER (PARTITION BY loop_id ORDER BY sequence) AS prev_sequence
        FROM agent_loop_steps WHERE step_type = 'MODEL_TEXT_DELTA'
      ), grouped AS (
        SELECT loop_id, sequence, payload_json,
               SUM(CASE WHEN prev_sequence = sequence - 1 THEN 0 ELSE 1 END)
                 OVER (PARTITION BY loop_id ORDER BY sequence) AS segment
        FROM text_steps
      )
      SELECT loop_id, segment, sequence, payload_json FROM grouped ORDER BY loop_id, segment, sequence
    `).all() as unknown as SqliteRow[];
    for (const group of groupTextSegments(rows, (row) => `${String(row.loop_id)}\u0000${String(row.segment)}`)) {
      const first = group[0]!;
      const payloads = group.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
      const itemId = lastNonEmptyString(payloads.map((payload) => payload.providerItemId));
      const merged = { ...payloads[0], text: payloads.map((payload) => String(payload.text ?? "")).join(""), ...(itemId ? { providerItemId: itemId } : {}) };
      this.statement("UPDATE agent_loop_steps SET payload_json = ? WHERE loop_id = ? AND sequence = ?").run(JSON.stringify(merged), String(first.loop_id), Number(first.sequence));
      for (const row of group.slice(1)) this.statement("DELETE FROM agent_loop_steps WHERE loop_id = ? AND sequence = ?").run(String(row.loop_id), Number(row.sequence));
    }
  }

  /** journal：同 run 内连续、且 modelStep 与 providerItemId 都不变的 MODEL_OUTPUT 合成一条。 */
  private compactJournalTextSegments(): void {
    const rows = this.statement(`
      WITH text_rows AS (
        SELECT run_id, sequence, payload_json,
               LAG(sequence) OVER (PARTITION BY run_id ORDER BY sequence) AS prev_sequence,
               LAG(json_extract(payload_json, '$.modelStep')) OVER (PARTITION BY run_id ORDER BY sequence) AS prev_step,
               LAG(json_extract(payload_json, '$.providerItemId')) OVER (PARTITION BY run_id ORDER BY sequence) AS prev_item
        FROM execution_journal WHERE type = 'MODEL_OUTPUT'
      ), grouped AS (
        SELECT run_id, sequence, payload_json,
               SUM(CASE WHEN prev_sequence = sequence - 1
                         AND json_extract(payload_json, '$.modelStep') IS prev_step
                         AND json_extract(payload_json, '$.providerItemId') IS prev_item
                   THEN 0 ELSE 1 END)
                 OVER (PARTITION BY run_id ORDER BY sequence) AS segment
        FROM text_rows
      )
      SELECT run_id, segment, sequence, payload_json FROM grouped ORDER BY run_id, segment, sequence
    `).all() as unknown as SqliteRow[];
    for (const group of groupTextSegments(rows, (row) => `${String(row.run_id)}\u0000${String(row.segment)}`)) {
      const first = group[0]!;
      const payloads = group.map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
      const merged: Record<string, unknown> = { ...payloads[0], text: payloads.map((payload) => String(payload.text ?? "")).join("") };
      const taskId = firstNonEmptyString(payloads.map((payload) => payload.taskId));
      if (taskId) merged.taskId = taskId;
      const threadId = firstNonEmptyString(payloads.map((payload) => payload.providerThreadId));
      if (threadId) merged.providerThreadId = threadId;
      const turnId = firstNonEmptyString(payloads.map((payload) => payload.providerTurnId));
      if (turnId) merged.providerTurnId = turnId;
      this.statement("UPDATE execution_journal SET payload_json = ? WHERE run_id = ? AND sequence = ?").run(JSON.stringify(merged), String(first.run_id), Number(first.sequence));
      for (const row of group.slice(1)) this.statement("DELETE FROM execution_journal WHERE run_id = ? AND sequence = ?").run(String(row.run_id), Number(row.sequence));
    }
  }

  /**
   * 老库回填：`resolvedContract.dependsOnPlanIds` 是新增的必填字段（见 plan-spec.ts 的说明），
   * 本轮之前落库的契约里没有这个键。
   *
   * 读点都写了 `?? []`，所以不补也能跑；但类型说它必填，而"21 行数据里少一个字段"这种
   * 类型与数据的漂移迟早会在某个没写兜底的新读点上炸掉（`?.map()` 之类）。
   * 让库里的数据也对得上，比要求每个读点都记得兜底可靠。
   *
   * 只补缺这个键的行：已有值的不动——**包括非空的依赖**，那是人设置的调度事实。
   */
  private backfillPlanDependencyIds(): void {
    for (const table of ["candidate_plans", "plan_revisions", "plan_revision_drafts", "change_proposals"]) {
      this.database.exec(`UPDATE ${table} SET resolved_contract_json = json_set(resolved_contract_json, '$.dependsOnPlanIds', json('[]'))
        WHERE resolved_contract_json IS NOT NULL AND json_extract(resolved_contract_json, '$.dependsOnPlanIds') IS NULL`);
    }
  }

  /**
   * 把"只存在整体快照里"的历史 journal 行搬进 `execution_journal`，然后那条快照列才能丢。
   *
   * 只处理表里一行都没有的线程——表里有行的，快照一定是旧的（见调用点的说明），拿它去补只会把
   * 已经正确的事实换成过期的。新库上这条 SELECT 会因为列不存在而抛错，那就是"没有可搬的"。
   */
  private backfillJournalRowsFromSnapshot(): void {
    let threads: SqliteRow[];
    try {
      threads = this.statement("SELECT t.id, t.run_id, t.journal_json FROM execution_threads t WHERE EXISTS (SELECT 1 FROM runs r WHERE r.id = t.run_id) AND NOT EXISTS (SELECT 1 FROM execution_journal j WHERE j.execution_thread_id = t.id)").all() as unknown as SqliteRow[];
    } catch { return; /* 列已经不存在（本迁移跑过了）。 */ }
    const insert = this.statement("INSERT OR IGNORE INTO execution_journal (execution_thread_id, run_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)");
    for (const thread of threads) {
      let journal: unknown;
      try { journal = JSON.parse(String(thread.journal_json)); } catch { continue; }
      if (!Array.isArray(journal)) continue;
      for (const entry of journal) {
        if (!isRecord(entry) || typeof entry.sequence !== "number" || typeof entry.type !== "string" || typeof entry.occurredAt !== "string") continue;
        insert.run(String(thread.id), String(thread.run_id), entry.sequence, entry.type, entry.occurredAt, JSON.stringify(isRecord(entry.payload) ? entry.payload : {}));
      }
    }
  }

  /** 历史未确认内容被覆盖时只剩当前快照；保留它为可查看版本，不伪造丢失的旧内容。 */
  private backfillCandidateVersions(): void {
    for (const plan of this.listPlans()) {
      if (plan.status === "DRAFT") this.saveCandidateVersion(plan);
    }
  }

  private mergeRequestFromRow(row: SqliteRow): MergeRequest {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      planId: String(row.plan_id),
      sourceCommit: String(row.source_commit),
      targetBranch: String(row.target_branch),
      status: String(row.status) as MergeRequest["status"],
      humanConfirmationRequired: true,
      createdAt: String(row.created_at),
      mergedAt: row.merged_at === null ? null : String(row.merged_at),
      ...(row.detected_target_commit === null || row.detected_target_commit === undefined ? {} : { detectedTargetCommit: String(row.detected_target_commit) }),
    };
  }

  private planFromRow(row: SqliteRow): CandidatePlan {
    return { id: String(row.id), projectId: String(row.project_id), sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}), sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null || row.provider_turn_id === undefined ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null || row.provider_item_id === undefined ? null : String(row.provider_item_id), title: String(row.title), revision: Number(row.revision), status: String(row.status) as PlanStatus, createdAt: String(row.created_at), confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at), queuedAt: row.queued_at === null ? null : String(row.queued_at), dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined ? null : String(row.dispatched_at), runId: row.run_id === null ? null : String(row.run_id), lastEventAt: String(row.last_event_at), attentionReason: row.attention_reason === null ? null : String(row.attention_reason), resolvedContract: resolvedContractFromRow(row, `CandidatePlan ${String(row.id)}`), ...(row.generated_spec_json ? { generatedSpec: JSON.parse(String(row.generated_spec_json)) as GeneratedPlanSpec } : {}) };
  }

  private dispatchStateFromRow(row: SqliteRow): PlanDispatchState {
    return {
      planId: String(row.plan_id),
      ...(row.revision === null || row.revision === undefined ? {} : { revision: Number(row.revision) }),
      projectId: String(row.project_id),
      status: String(row.status) as PlanDispatchState["status"],
      waitReason: row.wait_reason === null || row.wait_reason === undefined ? null : String(row.wait_reason) as PlanDispatchState["waitReason"],
      queuedAt: String(row.queued_at),
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      attempt: Number(row.attempt),
      updatedAt: String(row.updated_at),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      ...(row.phase ? { phase: String(row.phase) as NonNullable<PlanDispatchState["phase"]> } : {}),
      automatic: Number(row.automatic ?? 0) === 1,
      confirmedBy: row.confirmed_by === null || row.confirmed_by === undefined ? null : String(row.confirmed_by),
    };
  }

  private changeProposalFromRow(row: SqliteRow): ChangeProposal {
    return {
      id: String(row.id), runId: String(row.run_id), planId: String(row.plan_id), reason: String(row.reason),
      requestedChanges: JSON.parse(String(row.requested_changes_json)) as string[], resolvedContract: resolvedContractFromRow(row, `ChangeProposal ${String(row.id)}`),
      status: String(row.status) as ChangeProposalStatus, createdAt: String(row.created_at), createdBy: String(row.created_by),
      decidedAt: row.decided_at === null ? null : String(row.decided_at), decidedBy: row.decided_by === null ? null : String(row.decided_by), revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
    };
  }

  private runFromRow(row: SqliteRow): Run {
    return { id: String(row.id), projectId: String(row.project_id), planId: String(row.plan_id), planRevision: Number(row.plan_revision), status: String(row.status) as RunStatus, branch: String(row.branch), workspacePath: row.workspace_path === null ? null : String(row.workspace_path), baseCommit: String(row.base_commit), executionThreadId: String(row.execution_thread_id), createdAt: String(row.created_at), startedAt: row.started_at === null ? null : String(row.started_at) };
  }

  private agentLoopFromRow(row: SqliteRow): AgentLoop {
    return {
      id: String(row.id), ownerType: String(row.owner_type) as AgentLoop["ownerType"], ownerId: String(row.owner_id), role: String(row.role) as AgentLoop["role"], mode: String(row.mode) as AgentLoop["mode"], state: String(row.state) as AgentLoop["state"], stepCount: Number(row.step_count), maxSteps: Number(row.max_steps), startedAt: row.started_at === null ? null : String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), checkpointJson: row.checkpoint_json === null ? null : String(row.checkpoint_json),
    };
  }

  private agentLoopStepFromRow(row: SqliteRow): AgentLoopStep {
    return {
      loopId: String(row.loop_id), sequence: Number(row.sequence), stepType: String(row.step_type) as AgentLoopStep["stepType"], status: String(row.status) as AgentLoopStep["status"], callId: row.call_id === null ? null : String(row.call_id), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, occurredAt: String(row.occurred_at),
    };
  }

  private toolCallFromRow(row: SqliteRow): PersistedToolCall {
    return { callId: String(row.call_id), loopId: String(row.loop_id), role: String(row.role) as ToolRole, tool: String(row.tool) as ToolName, status: String(row.status) as DurableToolCallStatus, inputHash: String(row.input_hash), result: row.result_json === null ? null : JSON.parse(String(row.result_json)) as ToolCallResult, startedAt: String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at) };
  }
}
