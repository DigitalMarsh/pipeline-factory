# Original Requirement Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the confirmed gaps between the current Pipeline Factory v4 implementation and the original v3 acceptance requirements without changing the TypeScript/Vue/Fastify/SQLite WAL architecture.

**Architecture:** Keep the existing domain services and SQLite store, adding narrow relational audit/query projections instead of replacing the runtime. Make the dispatch coordinator the single automatic Run entry, preserve immutable PlanRevision facts, expose explicit Needs Attention state, and keep the Workbench as the shared project execution surface while restoring a reachable Plan Center route.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, SQLite WAL, Vue 3, Vite, Element Plus, Vitest, vue-tsc.

**Spec:** `docs/spec/ai-software- pipeline-factory-design-v3.0.md` and `docs/superpowers/plans/2026-08-30-ui-completeness.md`.

## Global Constraints

- Keep the existing Project boundary and never fall back to an implicit default Project.
- Explorer remains `sandbox: read-only`, `approvalPolicy: never`, and Plan mode; Executor remains Worktree-scoped and command-allowlisted.
- Confirm and Enqueue remain separate operations; PlanRevision, ExecutionJournal, and domain events remain append-only facts.
- Do not push, merge, deploy, overwrite user files, or delete user-owned data; Worktree cleanup is explicit and recoverable.
- Every behavior change receives a failing regression test before production code changes.
- Final verification requires fresh tests, typecheck, build, diff-check, and browser checks at desktop/tablet/narrow widths.

---

### Task 1: SQLite integrity, audit facts, and Plan query projection

**Files:**
- Modify: `code/packages/domain/src/index.ts`
- Modify: `code/packages/domain/src/project.ts`
- Create: `code/packages/domain/src/audit-projection.test.ts`
- Modify: `code/packages/domain/src/index.test.ts`

**Interfaces:**
- Add store-level append-only `execution_journal` and `hook_executions` facts with stable `(run_id, sequence)` and `(run_id, hook_type, attempt)` keys.
- Add `plan_query_projection` read model fields for project, source Explorer, status, queued/last-event timestamps, priority, and searchable goal/title.
- Enable SQLite foreign keys on every connection and make migrations idempotent.

- [ ] Write tests that assert `PRAGMA foreign_keys` is enabled, journal rows append without update/delete APIs, HookExecution stores command result metadata, and the query projection survives a new SQLite connection.
- [ ] Run the focused domain tests and observe the expected failures against the current schema.
- [ ] Add the migration tables, indexes, foreign-key pragma, append/read store methods, and projection refresh at Plan state changes.
- [ ] Run the focused tests, then the complete domain suite.

### Task 2: Complete PlanQuery and unify automatic dispatch entry points

**Files:**
- Modify: `code/apps/api/src/server.ts`
- Modify: `code/apps/web/src/api.ts`
- Modify: `code/apps/web/src/router.ts`
- Modify: `code/apps/web/src/views/PlanCenterView.vue`
- Modify: `code/packages/domain/src/index.ts`
- Modify: `code/packages/domain/src/dispatch-coordinator.ts`
- Modify: `code/packages/domain/src/dispatch-coordinator.test.ts`
- Modify: `code/apps/api/src/server.test.ts`

**Interfaces:**
- Extend `threadPlanQuery` with `explorerThreadId`, `includeLineage`, `from`, `to`, `cursor`, `priority`, and `status` sorting.
- Return a stable opaque cursor and apply the same filtering/sorting semantics to project and Explorer plan endpoints.
- Route `/projects/:projectId/plans` to `PlanCenterView`; keep `/workbench` and a project Execute route available separately.
- Make `POST /api/v4/plans/:planId/run` enqueue through `PlanDispatchCoordinator` and return WAITING state instead of bypassing it.

- [ ] Add API/domain tests for source-thread filtering, lineage inclusion, time bounds, cursor pagination, priority ordering, and repeated Run requests.
- [ ] Run the focused tests and observe failures for unsupported query parameters, null cursors, and direct Scheduler calls.
- [ ] Implement one query function used by both endpoints, stable cursor encoding, reachable Plan Center routing, and coordinator-backed Run dispatch.
- [ ] Run API, domain, and web tests.

### Task 3: Enforce Explorer and recovery state invariants

**Files:**
- Modify: `code/packages/domain/src/index.ts`
- Modify: `code/packages/domain/src/project.ts`
- Modify: `code/packages/domain/src/dispatch-coordinator.ts`
- Modify: `code/packages/domain/src/recovery-coordinator.ts`
- Modify: `code/packages/domain/src/explorer-service.test.ts`
- Modify: `code/packages/domain/src/recovery-coordinator.test.ts`

**Interfaces:**
- Creating or activating an Explorer archives the prior active Explorer for the same Project and updates `currentExplorerThreadId` atomically.
- Queue order is `priority DESC`, `queued_at ASC`, `plan_id ASC`.
- `RECOVERING`, `NEEDS_RECONCILIATION`, and capability failures project to dispatch `BLOCKED`/Needs Attention with a reason, never ordinary `RUNNING`.

- [ ] Add failing tests for two active Explorers, priority ordering, and recovery state projection.
- [ ] Run focused tests to verify the failures are caused by missing invariants.
- [ ] Implement the smallest domain/coordinator changes and preserve existing recovery facts.
- [ ] Run the focused and complete domain suites.

### Task 4: Hook evidence, Git merge validation, settings validation, and redaction

**Files:**
- Modify: `code/packages/domain/src/index.ts`
- Modify: `code/packages/domain/src/project.ts`
- Modify: `code/apps/api/src/server.ts`
- Modify: `code/packages/domain/src/m3-hooks.test.ts`
- Modify: `code/packages/domain/src/m4-verify-merge.test.ts`
- Modify: `code/packages/domain/src/project.test.ts`
- Create: `code/packages/domain/src/redaction.test.ts`

**Interfaces:**
- Persist complete HookExecution data: command ID, cwd/context, attempt, stdout, stderr, exit code, timeout, and status.
- Validate source and target Git commits through an injected Git inspector; only an actual target relation can produce MERGED.
- Validate Project settings with Zod-compatible runtime checks before normalization.
- Apply a shared redactor before event payloads and journal/audit payloads are persisted; preserve only secret metadata and counts for sensitive input answers.

- [ ] Add failing tests for hook result persistence, invalid commit/target relation, malformed settings, and secret/token/cookie redaction.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement the injected Git inspector, audit persistence, settings schema, and redactor without changing the existing tool boundary.
- [ ] Run domain/API tests and inspect persisted SQLite rows in a disposable test database.

### Task 5: Responsive Workbench and final browser acceptance

**Files:**
- Modify: `code/apps/web/src/views/WorkbenchView.vue`
- Modify: `code/apps/web/src/views/PlanCenterView.vue`
- Modify: `code/apps/web/src/styles.css`
- Create or modify: `code/apps/web/src/utils/workbenchLayout.test.ts`

**Interfaces:**
- Desktop keeps the three-column Workbench; tablet collapses the context panel; narrow screens switch between history, inspector, and context sections without horizontal overflow.
- Workbench Inspector shows the complete contract fields or links to the full drawer: Include, Exclude, base branch/commit, dependencies, verification, repair limit, source turn, and artifact hash.
- Every empty/error/recovery state has explanatory text and a valid next action; status uses text, icon, and color.

- [ ] Add a failing layout helper test for narrow/tablet panel selection and complete inspector field projection.
- [ ] Run the focused web test and observe the expected failure.
- [ ] Implement responsive CSS and accessible panel controls without adding execution side effects.
- [ ] Run web tests, typecheck, build, and the browser matrix for `/workbench`, `/projects/:id/plans`, `/projects/:id/explorer`, `/projects/new`, settings, and Run detail at desktop/tablet/narrow widths.
- [ ] Run `git diff --check`, inspect status, and report any environment-only browser limitation separately.
