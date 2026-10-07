/**
 * 测试职责：锁住 Web 与 domain 公共 DTO 的**双向类型 parity**。
 *
 * 这不是运行时测试：每个 `Expect<Equal<...>>` 都必须通过 `vue-tsc`，否则两边的手抄
 * 类型已经漂移。运行时只放一个无意义的断言，让 Vitest 把本文件纳入测试文件清单。
 * domain 通过 workspace devDependency 提供类型入口；`pnpm verify` 先 build domain，
 * 所以这里消费的是 `packages/domain/dist/index.d.ts`，不是把 domain 源码拖进 Web。
 *
 * 维护提示：Plan / Run 的页面投影类型（例如 Web 独有的 `Plan`）不在这里硬凑 parity；
 * 只加入 domain 与 Web 都公开、且语义上应保持同一份契约的 23 个类型。新增共享 DTO 时
 * 先在 domain 建权威类型，再把它加入这张清单。
 */
import { describe, expect, it } from "vitest";
import type {
  AgentLoopDiagnostics as DomainAgentLoopDiagnostics,
  AgentLoopState as DomainAgentLoopState,
  ExecutionJournalPayload as DomainExecutionJournalPayload,
  ExecutionTelemetry as DomainExecutionTelemetry,
  ExecutionThreadSummary as DomainExecutionThreadSummary,
  ExplorerActivityItem as DomainExplorerActivityItem,
  ExplorerActivityKind as DomainExplorerActivityKind,
  ExplorerInputRequest as DomainExplorerInputRequest,
  ExplorerThreadContextSummary as DomainExplorerThreadContextSummary,
  ExplorerTurn as DomainExplorerTurn,
  MergeRequest as DomainMergeRequest,
  RunGuidance as DomainRunGuidance,
  ModelInputQuestion as DomainModelInputQuestion,
  ModelMessagePhase as DomainModelMessagePhase,
  ModelUsage as DomainModelUsage,
  PlanDispatchState as DomainPlanDispatchState,
  PlanDispatchStatus as DomainPlanDispatchStatus,
  PlanDispatchWaitReason as DomainPlanDispatchWaitReason,
  PlanLifecycleEntry as DomainPlanLifecycleEntry,
  PlanLifecycleStatus as DomainPlanLifecycleStatus,
  PlanStatus as DomainPlanStatus,
  ProjectExecutionMessage as DomainProjectExecutionMessage,
  ProjectExecutionThread as DomainProjectExecutionThread,
  ProjectExecutionTurnStatus as DomainProjectExecutionTurnStatus,
  VerificationRun as DomainVerificationRun,
} from "@pipeline-factory/domain";
import type { SharedMessageType } from "./utils/conversationTypes";
import type { ExecutionSharedMessageType } from "./utils/executionStream";
import type { ExplorerSharedMessageType } from "./utils/explorerPresentation";
import type {
  AgentLoopDiagnostics,
  AgentLoopState,
  ExecutionJournalPayload,
  ExecutionTelemetry,
  ExecutionThreadSummary,
  ExplorerActivityItem,
  ExplorerActivityKind,
  ExplorerInputRequest,
  ExplorerThreadContextSummary,
  ExplorerTurn,
  MergeRequest,
  RunGuidance,
  ModelInputQuestion,
  ModelMessagePhase,
  ModelUsage,
  PlanDispatchState,
  PlanDispatchStatus,
  PlanDispatchWaitReason,
  PlanLifecycleEntry,
  PlanLifecycleStatus,
  PlanStatus,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  ProjectExecutionTurnStatus,
  VerificationRun,
} from "./types";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;
type Expect<T extends true> = T;

/**
 * 两条对话线共用的消息词表也是 parity 的一部分：`Extract<…, SharedMessageType>` 等于全表，
 * 就说明这一侧把每一项都列出来了（少一项这里就不是 `SharedMessageType` 了）。
 */
type SharedVocabularyParity = [
  Expect<Equal<ExplorerSharedMessageType, SharedMessageType>>,
  Expect<Equal<ExecutionSharedMessageType, SharedMessageType>>,
];

type SharedTypeParity = [
  Expect<Equal<DomainPlanStatus, PlanStatus>>,
  Expect<Equal<DomainPlanLifecycleStatus, PlanLifecycleStatus>>,
  Expect<Equal<DomainPlanLifecycleEntry, PlanLifecycleEntry>>,
  Expect<Equal<DomainExplorerThreadContextSummary, ExplorerThreadContextSummary>>,
  Expect<Equal<DomainExplorerTurn, ExplorerTurn>>,
  Expect<Equal<DomainExplorerActivityItem, ExplorerActivityItem>>,
  Expect<Equal<DomainExplorerActivityKind, ExplorerActivityKind>>,
  Expect<Equal<DomainExplorerInputRequest, ExplorerInputRequest>>,
  Expect<Equal<DomainModelInputQuestion, ModelInputQuestion>>,
  Expect<Equal<DomainModelMessagePhase, ModelMessagePhase>>,
  Expect<Equal<DomainAgentLoopState, AgentLoopState>>,
  Expect<Equal<DomainAgentLoopDiagnostics, AgentLoopDiagnostics>>,
  Expect<Equal<DomainProjectExecutionTurnStatus, ProjectExecutionTurnStatus>>,
  Expect<Equal<DomainProjectExecutionThread, ProjectExecutionThread>>,
  Expect<Equal<DomainProjectExecutionMessage, ProjectExecutionMessage>>,
  Expect<Equal<DomainModelUsage, ModelUsage>>,
  Expect<Equal<DomainExecutionTelemetry, ExecutionTelemetry>>,
  Expect<Equal<DomainExecutionJournalPayload, ExecutionJournalPayload>>,
  Expect<Equal<DomainExecutionThreadSummary, ExecutionThreadSummary>>,
  Expect<Equal<DomainVerificationRun, VerificationRun>>,
  Expect<Equal<DomainMergeRequest, MergeRequest>>,
  Expect<Equal<DomainRunGuidance, RunGuidance>>,
  Expect<Equal<DomainPlanDispatchStatus, PlanDispatchStatus>>,
  Expect<Equal<DomainPlanDispatchWaitReason, PlanDispatchWaitReason>>,
  Expect<Equal<DomainPlanDispatchState, PlanDispatchState>>,
];

// Keep the alias referenced so future compiler configurations cannot elide the checks as unused.
const sharedVocabularyChecks: SharedVocabularyParity | null = null;
void sharedVocabularyChecks;
const parityChecks: SharedTypeParity | null = null;
void parityChecks;

describe("domain / web type parity", () => {
  it("keeps the shared DTO contract checked at compile time", () => {
    expect(true).toBe(true);
  });
});
