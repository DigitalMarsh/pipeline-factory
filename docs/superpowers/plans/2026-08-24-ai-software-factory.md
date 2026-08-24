# AI Software Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在当前文档基线之上，实现一个以 SQLite 为事实来源、支持不可变 Plan Revision、确定性调度、Run/Lease 恢复和 Codex/Superpowers Adapter 的本地 AI Software Factory MVP。

**Architecture:** 领域层只负责实体、状态转换和不变量；应用层负责发布、调度、恢复和合并确认；基础设施层负责 SQLite、Git、进程和文件；Adapter 层隔离 Codex Runtime 与 Superpowers。Plan 是长期对象，Run 是执行尝试，Thread、Worktree 和 Branch 是 Run 的资源引用。

**Tech Stack:** Python 3.14、SQLite WAL、Git Worktree、Codex App Server/SDK capability adapter、pytest、类型检查工具；HTTP/MCP 与前端只在领域闭环通过测试后接入。

**Spec:** docs/ai-software-factory-design.md

## Global Constraints

- Factory 不研究、不连接、不写入 Codex Desktop 私有 ipc.sock。
- SQLite 是 Factory 的唯一事实来源；Codex Desktop 的可见性只保存为观测字段。
- Plan Revision 发布后不可变；执行结果不得回写计划正文。
- 所有验证命令必须来自项目预登记白名单；Artifact 不得携带任意 Shell。
- Executor 不得 merge、push、deploy、删除 Worktree 或修改项目配置。
- Scheduler V1 必须是确定性的：priority DESC、queued_at ASC、plan_id ASC。
- 依赖 Plan 必须达到 MERGED 后，下游 Plan 才能调度。
- 冲突锁从 Assignment 创建保持到 Run 终止或人工确认合并。
- 自动修复最多使用 Plan executor.max_fix_attempts，默认 2 次；达到上限进入 BLOCKED。
- 本仓库当前只有设计文档，本计划中的 backend/ 与 frontend/ 路径是实施阶段要创建的目标结构。

---

### Task 1: 建立后端包与领域类型

**Files:**
- Create: backend/pyproject.toml
- Create: backend/src/codex_workflow/__init__.py
- Create: backend/src/codex_workflow/domain/__init__.py
- Create: backend/src/codex_workflow/domain/models.py
- Create: backend/src/codex_workflow/domain/enums.py
- Create: backend/tests/domain/test_models.py

**Interfaces:**
- Produces enums PlanState、RunState、AssignmentState、SlotState、LockState、Visibility。
- Produces immutable value types PlanId、PlanRevisionId、RunId、ConflictKey、CommitSha。
- Produces entities FactoryProject、Plan、PlanRevision、PlanTask、Run、ExecutorSlot、Assignment、Workspace、CodexThreadRef。
- Every entity exposes an explicit id and timestamps; PlanRevision exposes artifact_sha256 and base_commit.

- [ ] **Step 1: Write the failing domain tests**

~~~python
def test_plan_revision_is_immutable_after_publish():
    revision = make_published_revision()
    with pytest.raises(TypeError):
        revision.title = "changed"

def test_run_keeps_revision_and_attempt_identity():
    run = Run.create(plan_revision_id="REV-1", attempt=2, base_commit="abc123")
    assert run.plan_revision_id == "REV-1"
    assert run.attempt == 2
    assert run.base_commit == "abc123"
~~~

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/domain/test_models.py -q  
Expected: FAIL because the domain package does not exist.

- [ ] **Step 3: Implement the minimal typed domain model**

Implement frozen value objects for identifiers, frozen PlanRevision data, mutable Run/Assignment lifecycle records, and enum values matching docs/ai-software-factory-design.md. Do not add database, Codex, Git, or Shell imports to domain files.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: cd backend && python3.14 -m pytest tests/domain/test_models.py -q  
Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add backend/pyproject.toml backend/src/codex_workflow backend/tests/domain/test_models.py
git commit -m "feat: establish factory domain types"
~~~

### Task 2: Implement state transitions and domain invariants

**Files:**
- Create: backend/src/codex_workflow/domain/state_machine.py
- Create: backend/src/codex_workflow/domain/errors.py
- Modify: backend/src/codex_workflow/domain/enums.py
- Test: backend/tests/domain/test_state_machine.py

**Interfaces:**
- Produces transition_plan(current: PlanState, event: PlanEvent) -> PlanState.
- Produces transition_run(current: RunState, event: RunEvent) -> RunState.
- Produces assert_merge_ready(run: Run, verification: VerificationSummary, commit_sha: str) -> None.
- Illegal transitions raise InvalidTransition; merge preconditions raise InvariantViolation.

- [ ] **Step 1: Write failing transition tests**

~~~python
def test_plan_can_only_enter_queued_after_approval():
    assert transition_plan(PlanState.READY, PlanEvent.APPROVE) is PlanState.QUEUED

def test_plan_cannot_be_merged_without_merge_confirmation():
    with pytest.raises(InvariantViolation):
        assert_merge_ready(run_with_failed_verification(), verification=None, commit_sha=None)

def test_running_plan_revision_cannot_be_edited():
    with pytest.raises(InvariantViolation):
        transition_plan(PlanState.IN_PROGRESS, PlanEvent.EDIT)
~~~

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/domain/test_state_machine.py -q  
Expected: FAIL because transition functions are not defined.

- [ ] **Step 3: Implement explicit transition tables**

Define a finite transition table for Plan and Run. Reject every event not listed in the table. Keep WAITING_DEPENDENCY and WAITING_CONFLICT as scheduler projections that can return to QUEUED when their blocking condition clears. Keep MERGED reachable only through a separate merge-confirmation application service.

- [ ] **Step 4: Run domain tests and type checks**

Run: cd backend && python3.14 -m pytest tests/domain -q  
Expected: PASS.  
Run: cd backend && python3.14 -m compileall -q src  
Expected: exit 0.

- [ ] **Step 5: Commit**

~~~bash
git add backend/src/codex_workflow/domain backend/tests/domain
git commit -m "feat: enforce factory lifecycle transitions"
~~~

### Task 3: Add Plan Artifact parsing, validation, and idempotent Registry

**Files:**
- Create: backend/src/codex_workflow/domain/plan_contract.py
- Create: backend/src/codex_workflow/infrastructure/plan_parser.py
- Create: backend/src/codex_workflow/infrastructure/sqlite.py
- Create: backend/src/codex_workflow/application/plan_service.py
- Create: backend/tests/application/test_plan_service.py
- Create: backend/tests/infrastructure/test_plan_parser.py

**Interfaces:**
- Produces parse_plan_artifact(markdown: str) -> PlanArtifact.
- Produces validate_plan_artifact(artifact: PlanArtifact, project: FactoryProject) -> ValidationReport.
- Produces PlanService.publish(artifact: str, idempotency_key: str, approved_by: str) -> PublishedPlan.
- Produces PlanService.approve(plan_id: str) -> Plan.
- Duplicate idempotency keys return the original Plan; same key with a different artifact raises IdempotencyConflict.

- [ ] **Step 1: Write parser and publish failure tests**

~~~python
def test_parser_extracts_tasks_dependencies_conflicts_and_commands():
    artifact = parse_plan_artifact(SAMPLE_PLAN_MARKDOWN)
    assert artifact.plan_id == "PLN-20260824-001"
    assert artifact.tasks[0].id == "task-01"
    assert artifact.conflict_keys == {"module:permission"}

def test_unregistered_verification_command_is_rejected():
    report = validate_plan_artifact(artifact_with_command("shell.rm"), project)
    assert report.errors == ["verification command shell.rm is not registered"]

def test_repeated_publish_is_idempotent():
    first = service.publish(SAMPLE_PLAN_MARKDOWN, "publish-1", "bill")
    second = service.publish(SAMPLE_PLAN_MARKDOWN, "publish-1", "bill")
    assert second.plan_id == first.plan_id
    assert repository.count_plans() == 1
~~~

- [ ] **Step 2: Run the tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/infrastructure/test_plan_parser.py tests/application/test_plan_service.py -q  
Expected: FAIL because parser, schema, database, and service are not implemented.

- [ ] **Step 3: Implement the contract and parser**

Parse YAML Front Matter and Markdown body, calculate artifact_sha256, require schema_version, plan_id, title, goal, project, base.commit, scope, implementation, verification, executor, and acceptance. Reject duplicate task IDs, dependency cycles, empty acceptance, scope paths outside the project, and commands outside the project allowlist.

- [ ] **Step 4: Implement the first SQLite schema and service transaction**

Create factory_projects, plans, plan_revisions, plan_dependencies, plan_tasks, factory_events, and idempotency_keys. Enable foreign_keys and WAL. Publish must insert the immutable revision, normalized task/dependency/conflict records, an idempotency record, and a plan.published event in one transaction.

- [ ] **Step 5: Run tests, including rollback behavior**

Run: cd backend && python3.14 -m pytest tests/infrastructure tests/application -q  
Expected: PASS, including a test proving validation failure leaves no partial Plan, Revision, or Event.

- [ ] **Step 6: Commit**

~~~bash
git add backend/src/codex_workflow backend/tests/application backend/tests/infrastructure
git commit -m "feat: register immutable plan revisions"
~~~

### Task 4: Implement deterministic Scheduler, Assignment, Lease, and locks

**Files:**
- Create: backend/src/codex_workflow/application/scheduler_service.py
- Create: backend/src/codex_workflow/application/recovery_service.py
- Create: backend/src/codex_workflow/infrastructure/clock.py
- Modify: backend/src/codex_workflow/infrastructure/sqlite.py
- Create: backend/tests/application/test_scheduler_service.py
- Create: backend/tests/application/test_recovery_service.py

**Interfaces:**
- Produces SchedulerService.schedule_once(now: datetime) -> list[DispatchDecision].
- Produces SchedulerService.release_blocked_plans(now: datetime) -> list[str].
- Produces RecoveryService.reconcile(now: datetime) -> list[RecoveryDecision].
- SQLite adds executor_slots, runs, run_tasks, assignments, resource_locks.
- A successful dispatch creates exactly one Run, one Assignment, and one lock set.

- [ ] **Step 1: Write failing scheduler tests**

~~~python
def test_unmerged_dependency_keeps_plan_waiting():
    decision = scheduler.schedule_once(clock.now())
    assert decision[0].state == PlanState.WAITING_DEPENDENCY
    assert repository.active_runs() == []

def test_conflicting_plans_are_serialized():
    first = scheduler.schedule_once(clock.now())
    second = scheduler.schedule_once(clock.now())
    assert first[0].run_id is not None
    assert second[0].state == PlanState.WAITING_CONFLICT

def test_two_scheduler_calls_do_not_double_allocate_a_slot():
    scheduler.schedule_once(clock.now())
    scheduler.schedule_once(clock.now())
    assert repository.count_active_assignments() == 1
~~~

- [ ] **Step 2: Run focused tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/application/test_scheduler_service.py -q  
Expected: FAIL because scheduler, lease tables, and lock acquisition do not exist.

- [ ] **Step 3: Implement SQLite immediate transaction and deterministic ordering**

Use one short immediate transaction for dependency checks, capacity checks, conflict-lock acquisition, Run creation, Assignment creation, and Plan projection. Sort by priority descending, queued_at ascending, and plan_id ascending. Never call Codex or Git while the transaction is open.

- [ ] **Step 4: Implement Lease heartbeat and expiry**

Add heartbeat(run_id, assignment_id, now, lease_until) and expire_leases(now). Expiry changes Run to STALE, Assignment to EXPIRED, releases resource locks, and changes the Slot to RECOVERING. A heartbeat for a terminal or mismatched Assignment must be rejected.

- [ ] **Step 5: Implement restart reconciliation**

On startup, find DISPATCHED, RUNNING, VERIFYING, and RECOVERING Runs. Match registered Workspaces and ThreadRefs; missing resources become BLOCKED with a recovery event. Existing healthy resources receive a new Assignment Lease without creating a duplicate Run.

- [ ] **Step 6: Run scheduler and recovery tests**

Run: cd backend && python3.14 -m pytest tests/application/test_scheduler_service.py tests/application/test_recovery_service.py -q  
Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add backend/src/codex_workflow backend/tests/application
git commit -m "feat: add deterministic scheduling and lease recovery"
~~~

### Task 5: Add Git Workspace Adapter and safe command runner

**Files:**
- Create: backend/src/codex_workflow/adapters/git_runtime.py
- Create: backend/src/codex_workflow/infrastructure/command_runner.py
- Create: backend/src/codex_workflow/application/workspace_service.py
- Modify: backend/src/codex_workflow/infrastructure/sqlite.py
- Create: backend/tests/adapters/test_git_runtime.py
- Create: backend/tests/infrastructure/test_command_runner.py
- Create: backend/tests/application/test_workspace_service.py

**Interfaces:**
- GitRuntimeAdapter.create_workspace(project: FactoryProject, run: Run) -> WorkspaceSnapshot.
- GitRuntimeAdapter.inspect_workspace(workspace_id: str) -> WorkspaceSnapshot.
- GitRuntimeAdapter.commit(workspace: Workspace, message: str) -> CommitSha.
- CommandRunner.run(command_id: str, project: FactoryProject, cwd: str) -> CommandResult.
- WorkspaceService.prepare(run_id: str) -> Workspace.
- WorkspaceService.record_commit(run_id: str, commit_sha: str) -> None.

- [ ] **Step 1: Write failing safety tests**

~~~python
def test_unregistered_command_id_is_rejected():
    with pytest.raises(CommandNotAllowed):
        runner.run("rm_workspace", project, project.root)

def test_workspace_is_created_from_recorded_base_commit():
    workspace = service.prepare("RUN-1")
    assert workspace.base_commit == "abc123"
    assert workspace.branch == "factory/PLN-1/RUN-1"

def test_executor_cannot_commit_outside_workspace():
    with pytest.raises(WorkspaceBoundaryViolation):
        git_runtime.commit(workspace_for("/tmp/other"), "feat: invalid")
~~~

- [ ] **Step 2: Run tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/adapters/test_git_runtime.py tests/infrastructure/test_command_runner.py tests/application/test_workspace_service.py -q  
Expected: FAIL because adapters and workspace service are absent.

- [ ] **Step 3: Implement allowlisted command execution**

Store command definitions as structured argv, cwd policy, timeout, environment allowlist, and output limits. Use subprocess with a process-group/session so cancellation can terminate the full child tree. Do not accept shell=True or a command string from a Plan.

- [ ] **Step 4: Implement Git Worktree lifecycle**

Create a Worktree and Branch from the recorded base Commit; verify the resulting path and HEAD; register the Workspace before dispatch. Commit only inside the registered Workspace and return the exact Commit SHA. Do not merge, push, delete, or clean automatically.

- [ ] **Step 5: Run adapter and workspace tests**

Run: cd backend && python3.14 -m pytest tests/adapters tests/infrastructure tests/application/test_workspace_service.py -q  
Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add backend/src/codex_workflow backend/tests/adapters backend/tests/infrastructure backend/tests/application
git commit -m "feat: isolate runs with safe workspaces"
~~~

### Task 6: Implement Codex Runtime and Superpowers Adapters

**Files:**
- Create: backend/src/codex_workflow/adapters/codex_runtime.py
- Create: backend/src/codex_workflow/adapters/superpowers.py
- Create: backend/src/codex_workflow/application/dispatcher.py
- Create: backend/tests/adapters/test_codex_runtime.py
- Create: backend/tests/adapters/test_superpowers.py
- Create: backend/tests/application/test_dispatcher.py

**Interfaces:**
- CodexRuntimeAdapter.capabilities() -> RuntimeCapabilities.
- CodexRuntimeAdapter.discover_threads(query: ThreadQuery) -> list[ThreadSnapshot].
- CodexRuntimeAdapter.inspect_thread(thread_id: str) -> ThreadSnapshot.
- CodexRuntimeAdapter.observe_execution(thread_id: str) -> Iterator[RuntimeEvent].
- CodexRuntimeAdapter.bind_thread(run_id: str, ref: ThreadRef) -> None.
- SuperpowersAdapter.write_plan(design: ApprovedDesign) -> PlanArtifact.
- SuperpowersAdapter.validate_plan(artifact: PlanArtifact) -> ValidationReport.
- SuperpowersAdapter.execution_prompt(artifact: PlanArtifact, run: Run) -> str.

- [ ] **Step 1: Write failing capability and fallback tests**

~~~python
def test_desktop_visibility_is_observation_only():
    snapshot = ThreadSnapshot(thread_id="th-1", visibility=Visibility.HEADLESS)
    assert runtime_policy.can_complete_run(snapshot) is True

def test_native_control_is_disabled_when_capability_is_missing():
    adapter = CodexRuntimeAdapterStub(capabilities=RuntimeCapabilities())
    assert dispatcher.mode_for(adapter) == "observe"

def test_factory_write_plan_does_not_trigger_brainstorming():
    prompt = superpowers.execution_prompt(approved_artifact, run)
    assert "brainstorming" not in prompt
    assert "writing-plans" in prompt
~~~

- [ ] **Step 2: Run tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/adapters tests/application/test_dispatcher.py -q  
Expected: FAIL because adapters and dispatcher are absent.

- [ ] **Step 3: Implement capability gates and the V1 Observe adapter**

Define capability discovery, Thread/Workspace snapshots, binding, and event observation without writing Codex Desktop state or private IPC. Native actions must return UnsupportedCapability. A headless or unknown Thread is persisted as a visibility observation and never changes Run success criteria. Dispatcher may send prompts only when capabilities include Assist or Native Control; Observe-only runtimes transition the Run to BLOCKED with reason RUNTIME_CONTROL_UNAVAILABLE.

- [ ] **Step 4: Implement the Superpowers adapter contract**

Accept only an ApprovedDesign from Codex Plan Mode, generate the writing-plans-compatible artifact, validate its schema, and produce direct or reviewed execution prompts. Preserve scope, dependency, verification, and max-fix fields verbatim.

- [ ] **Step 5: Implement dispatch orchestration**

Dispatcher prepares the Workspace, binds or observes the Thread, writes the execution prompt, updates Run heartbeats, and emits runtime events. Adapter failures move Run to STALE or BLOCKED according to whether recovery is possible.

- [ ] **Step 6: Run tests and static checks**

Run: cd backend && python3.14 -m pytest tests/adapters tests/application/test_dispatcher.py -q  
Expected: PASS.  
Run: cd backend && python3.14 -m compileall -q src  
Expected: exit 0.

- [ ] **Step 7: Commit**

~~~bash
git add backend/src/codex_workflow backend/tests/adapters backend/tests/application/test_dispatcher.py
git commit -m "feat: isolate codex and superpowers adapters"
~~~

### Task 7: Add verification, review evidence, and merge confirmation

**Files:**
- Create: backend/src/codex_workflow/application/verification_service.py
- Create: backend/src/codex_workflow/application/merge_service.py
- Modify: backend/src/codex_workflow/infrastructure/sqlite.py
- Create: backend/tests/application/test_verification_service.py
- Create: backend/tests/application/test_merge_service.py

**Interfaces:**
- VerificationService.verify(run_id: str) -> VerificationSummary.
- VerificationService.retry_or_block(run_id: str, failure: VerificationFailure) -> RunState.
- MergeService.create_merge_request(run_id: str) -> MergeRequest.
- MergeService.confirm_merged(merge_request_id: str, target_commit: str, actor: str) -> Plan.
- confirm_merged must reject a target Commit that does not contain the recorded Run commit.

- [ ] **Step 1: Write failing verification and merge tests**

~~~python
def test_failed_verification_retries_until_limit_then_blocks():
    assert service.retry_or_block("RUN-1", failure) is RunState.RUNNING
    assert service.retry_or_block("RUN-1", failure) is RunState.BLOCKED

def test_merge_ready_contains_command_outputs_and_commit():
    request = merge_service.create_merge_request("RUN-1")
    assert request.commit_sha == "abc123"
    assert request.verifications[0].command_id == "backend.test"

def test_merge_confirmation_checks_target_commit():
    with pytest.raises(MergeNotContainingRunCommit):
        merge_service.confirm_merged("MR-1", "wrong-target", "bill")
~~~

- [ ] **Step 2: Run tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/application/test_verification_service.py tests/application/test_merge_service.py -q  
Expected: FAIL because verification and merge services are absent.

- [ ] **Step 3: Implement bounded verification and retry**

Run only registered command IDs in order, persist argv metadata, exit code, stdout/stderr truncation, duration, and timeout status. A failure creates a verification event. Retry in the same Run/Thread until max_fix_attempts, then transition to BLOCKED and release the Assignment.

- [ ] **Step 4: Implement MERGE_READY evidence**

Require all acceptance references and verification commands to pass, require a recorded Commit SHA, and create a MergeRequest containing base commit, head commit, changed files, verification summaries, and event IDs. Move Plan to MERGE_READY in the same transaction.

- [ ] **Step 5: Implement human merge confirmation**

Confirm only when Git proves the target branch contains the Run commit. Store target branch and target commit, release locks, finish the Assignment, and transition Plan to MERGED. Do not run the merge operation itself.

- [ ] **Step 6: Run tests**

Run: cd backend && python3.14 -m pytest tests/application/test_verification_service.py tests/application/test_merge_service.py -q  
Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add backend/src/codex_workflow backend/tests/application
git commit -m "feat: produce review evidence and confirm merges"
~~~

### Task 8: Expose API, dashboard projections, and end-to-end acceptance tests

**Files:**
- Create: backend/src/codex_workflow/api/app.py
- Create: backend/src/codex_workflow/api/schemas.py
- Create: backend/src/codex_workflow/api/routes/plans.py
- Create: backend/src/codex_workflow/api/routes/runs.py
- Create: backend/src/codex_workflow/api/routes/reviews.py
- Create: backend/tests/api/test_plan_routes.py
- Create: backend/tests/e2e/test_factory_flow.py
- Create: frontend/src/features/plans/PlanBoard.tsx
- Create: frontend/src/features/executors/ExecutorBoard.tsx
- Create: frontend/src/features/reviews/MergeQueue.tsx
- Create: frontend/src/features/attention/NeedsAttention.tsx

**Interfaces:**
- POST /plans/validate returns a ValidationReport without writing state.
- POST /plans/publish accepts artifact and idempotency key, returning Plan and Revision IDs.
- POST /plans/{plan_id}/approve moves READY to QUEUED.
- GET /plans and GET /runs return Registry projections, not raw adapter state.
- POST /merge-requests/{id}/confirm requires target_commit and actor.
- UI uses the API projections and never writes SQLite directly.

- [ ] **Step 1: Write API and end-to-end failure tests**

~~~python
def test_publish_requires_idempotency_key(client):
    response = client.post("/plans/publish", json={"artifact": SAMPLE_PLAN_MARKDOWN})
    assert response.status_code == 422

def test_full_flow_stops_at_merge_ready_until_human_confirmation(client):
    plan = publish_and_run(client, SAMPLE_PLAN_MARKDOWN)
    assert plan["status"] == "MERGE_READY"
    assert client.post(f"/merge-requests/{plan['merge_request_id']}/confirm",
                       json={"target_commit": "wrong", "actor": "bill"}).status_code == 409
~~~

- [ ] **Step 2: Run tests and verify they fail**

Run: cd backend && python3.14 -m pytest tests/api tests/e2e -q  
Expected: FAIL because API, projections, and UI source do not exist.

- [ ] **Step 3: Implement thin API routes**

Routes call Application Services only. Return stable error codes for validation failure, idempotency conflict, invalid transition, capacity wait, lease conflict, and merge confirmation failure. Do not expose adapter internals as the primary state model.

- [ ] **Step 4: Implement dashboard projections**

Plan Board shows plan status, revision, dependency/conflict reason, progress, latest Run, and review evidence. Executor Board shows Slot, Run, Thread, Worktree, phase, heartbeat, and duration. Needs Attention aggregates BLOCKED, FAILED, STALE, recovery failures, and rejected reviews.

- [ ] **Step 5: Implement end-to-end test fixtures**

Use a temporary Git repository, fake Codex Runtime Adapter, fake Superpowers Adapter, deterministic clock, and allowlisted test commands. Exercise publish, approve, dependency wait, conflict wait, dispatch, heartbeat expiry, retry, MERGE_READY, and confirm_merged.

- [ ] **Step 6: Run the complete verification set**

Run: cd backend && python3.14 -m pytest -q  
Expected: PASS.  
Run: cd backend && python3.14 -m compileall -q src  
Expected: exit 0.  
Run: git diff --check  
Expected: no output.

- [ ] **Step 7: Commit**

~~~bash
git add backend frontend
git commit -m "feat: expose factory operations and review boards"
~~~

## Verification Matrix

| 目标 | 验证方式 | 通过条件 |
|---|---|---|
| Plan Revision 不可变 | domain tests + SQLite constraint test | 发布后正文、哈希和基线不能被更新 |
| 发布幂等 | application test | 同一 key 只返回一个 Plan |
| 依赖与冲突 | scheduler tests | 阻塞可解释，条件解除后可继续 |
| Lease 恢复 | recovery tests | 失联 Run 进入 STALE/RECOVERING/BLOCKED，不能产生重复 Run |
| 安全命令 | command runner tests | 未登记命令、越界 cwd、shell 注入全部拒绝 |
| Thread 降级 | adapter tests | HEADLESS/UNKNOWN 不阻止成功闭环 |
| 验证与修复 | verification tests | 重试次数受限，最终结果可审计 |
| 人工合并边界 | merge tests | 未包含 Run commit 的目标分支不能确认 |
| 端到端工厂流程 | e2e test | publish → approve → schedule → run → verify → merge-ready → confirm-merged 完成 |
