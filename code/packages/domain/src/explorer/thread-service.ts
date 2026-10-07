/**
 * 模块职责：ExplorerThreadService —— 运行 Explorer 对话、结构化输入流程，并把 Provider
 *   事件投影为本地消息流（含消息落库、标题生成、Plan completeness 门禁）。
 *
 * 为什么从 index.ts 抽出来：这是 Explorer 侧最复杂的一条链路（530 行），涉及"什么时候
 *   才允许创建 CandidatePlan"这个核心业务规则。搬出来之后它可以被单独阅读，值依赖全部落在
 *   既有叶子模块上（plan/service.ts、plan/completion.ts、store/records.ts、
 *   explorer/explorer-title.ts、explorer/thread-selection.ts、agent/agent-loop.ts、
 *   agent/termination-gates.ts、platform/plan-requirements.ts）。
 *
 * 维护提示：
 *   1) **门禁不可绕过**：模型回合结束后必须通过 assessPlanCompletion，只有通过才会创建
 *      CandidatePlan。普通文本完成、模型自己说"做完了"都不算——去掉这道门禁会让未完成的
 *      Plan 进入确认流程。
 *   2) 落库的正文必须先 stripPlanProtocol、摘要必须走 summarizeExplorerMessage。
 *      协议块（pipeline-factory-plan）随消息回灌到下一轮 prompt 会污染模型上下文，
 *      而且这条错误只在多轮对话后才显现。
 *   3) 本类持有两个**进程内状态**：jobs（进行中的回合，含 resolveInput 的挂起 promise）与
 *      activeTurnByPlan。它们不落库，进程重启即清空——这是有意的（回合本身就是短生命周期）。
 *      因此任何"重启后恢复进行中回合"的需求都**不能**靠这里，要走 store 的恢复路径。
 *   4) PlanService 是在构造函数里直接 new 出来的，不是注入的。改它的依赖时要同时改这里与
 *      Scheduler 里的构造方式。
 *   5) 终端的标题来源判定走 explorer-title.js 的 composeExplorerTitle / normalizeExplorerTitle，
 *      失败分支回落 projectPlaceholderExplorerTitle —— 占位标题是展示契约，不要在本地拼。
 */
import { assessPlanCompletion } from "../plan/completion.js";
import { PlanService } from "../plan/service.js";
import { AgentLoopEngine } from "../agent/agent-loop.js";
import { PlanCompletenessGate } from "../agent/termination-gates.js";
import { composeExplorerTitle, normalizeExplorerTitle } from "./explorer-title.js";
import { projectPlaceholderExplorerTitle } from "./thread-selection.js";
import { REQUIRED_PLAN_AREAS } from "../platform/plan-requirements.js";
import { defaultExplorerPlan, defaultThreadContextSummary, stripPlanProtocol, summarizeExplorerMessage } from "../store/records.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { AgentLoop, AgentLoopEvent, AgentLoopRunner } from "../agent/agent-loop.js";
import type { ExplorerTitleGenerator } from "./explorer-title.js";
import type {
  DomainEvent,
  ModelGateway,
  ModelRoleConfig,
  ExplorerInputRequest,
  ExplorerPlan,
  ExplorerThread,
  ExplorerThreadContextSummary,
  ExplorerTurn,
  ModelInputAnswers,
  ModelInputQuestion,
  ModelInputRequest,
} from "../index.js";

/**
 * 运行 Explorer 对话和结构化输入流程，并把 Provider 事件投影为本地消息流。
 * 模型回合结束后必须通过 Plan completeness gate，才会创建 CandidatePlan；普通文本完成不会越过门禁。
 */
export class ExplorerThreadService {
  private readonly jobs = new Map<
    string,
    {
      threadId: string;
      userId: string;
      assistantId: string;
      explorerPlanId: string;
      loopId?: string | undefined;
      providerThreadId: string | null;
      providerTurnId: string | null;
      resolveInput?: (() => void) | undefined;
      cancelled: boolean;
    }
  >();
  private readonly activeTurnByPlan = new Map<string, string>();
  private readonly queuedTurns = new Map<string, string[]>();
  private readonly agentLoops: AgentLoopEngine;
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();
  private readonly plans: PlanService;
  private readonly loopMaxSteps: number;
  private readonly titleGenerator: ExplorerTitleGenerator | undefined;
  private readonly cwdForProject: ((projectId: string) => string | undefined) | undefined;
  private readonly modelConfigForProject: ((projectId: string) => ModelRoleConfig | undefined) | undefined;
  private readonly repositoryContextForProject: ((projectId: string) => { key: string; summary: string } | undefined) | undefined;

  constructor(
    private readonly store: PipelineStore,
    private readonly model: ModelGateway,
    options: {
      /** @deprecated retained for compatibility; Explorer uses the global model.loop.maxSteps. */ maxAutoContinuationTurns?:
        number | undefined;
      maxSteps?: number | undefined;
      maxDurationMs?: number | undefined;
      maxRepeatedToolCalls?: number | undefined;
      maxNoProgressSteps?: number | undefined;
      titleGenerator?: ExplorerTitleGenerator | undefined;
      cwdForProject?: ((projectId: string) => string | undefined) | undefined;
      modelConfigForProject?: ((projectId: string) => ModelRoleConfig | undefined) | undefined;
      repositoryContextForProject?: ((projectId: string) => { key: string; summary: string } | undefined) | undefined;
    } = {},
  ) {
    this.titleGenerator = options.titleGenerator;
    this.cwdForProject = options.cwdForProject;
    this.modelConfigForProject = options.modelConfigForProject;
    this.repositoryContextForProject = options.repositoryContextForProject;
    this.plans = new PlanService(store);
    this.loopMaxSteps = options.maxSteps ?? 40;
    this.agentLoops = new AgentLoopEngine(store, model, undefined, {
      defaultMaxSteps: this.loopMaxSteps,
      ...(options.maxDurationMs === undefined ? {} : { defaultMaxDurationMs: options.maxDurationMs }),
      ...(options.maxRepeatedToolCalls === undefined ? {} : { defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls }),
      ...(options.maxNoProgressSteps === undefined ? {} : { defaultMaxNoProgressSteps: options.maxNoProgressSteps }),
    });
    for (const thread of store.listThreads()) {
      if (thread.titleSource === "AUTO" && thread.titleStatus === "GENERATING") store.updateThread({ ...thread, titleStatus: "FAILED" });
    }
    for (const thread of store.listThreads()) {
      const recoveredTurnIds = new Set<string>();
      for (const request of store.listInputRequests(thread.id)) {
        if (request.status === "OPEN" || request.status === "SUBMITTING" || request.status === "RECOVERY_REQUIRED") {
          if (request.status === "OPEN" || request.status === "SUBMITTING")
            store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
          const turn = store.listTurns(thread.id).find((item) => item.id === request.localTurnId);
          if (turn && (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED")) {
            store.updateTurn({
              ...turn,
              status: "FAILED",
              error: "STRUCTURED_INPUT_RECOVERY_REQUIRED",
              content: turn.content || "模型回合中断，需要恢复结构化输入",
            });
            if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED", turn.id);
            recoveredTurnIds.add(turn.id);
          }
        }
      }
      for (const turn of store.listTurns(thread.id)) {
        if (recoveredTurnIds.has(turn.id) || (turn.status !== "RUNNING" && turn.status !== "WAITING_FOR_INPUT" && turn.status !== "PAUSED"))
          continue;
        store.updateTurn({
          ...turn,
          status: "FAILED",
          error: "EXPLORER_TURN_RECOVERY_REQUIRED",
          content: turn.content || "模型回合中断，需要重新开始探索",
        });
        if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED", turn.id);
      }
    }
    for (const thread of store.listThreads()) {
      if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
    }
    for (const thread of store.listThreads()) {
      for (const turn of store.listTurns(thread.id).filter((item) => item.role === "assistant" && item.status === "QUEUED")) {
        const planId = turn.explorerPlanId ?? store.listExplorerPlans(thread.id)[0]?.id;
        if (!planId) continue;
        const queue = this.queuedTurns.get(planId) ?? [];
        queue.push(turn.id);
        this.queuedTurns.set(planId, queue);
      }
    }
  }

  async recoverQueuedTurns(): Promise<void> {
    await Promise.all([...this.queuedTurns.keys()].map((explorerPlanId) => this.startNextQueuedTurn(explorerPlanId)));
  }

  async startTurn(input: {
    threadId: string;
    explorerPlanId: string;
    content: string;
    clientTurnId: string;
  }): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null }> {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`ExplorerThread ${input.threadId} not found`);
    if (!input.explorerPlanId) throw new Error("explorerPlanId is required for every Explorer turn");
    const prior = this.store.getIdempotency("explorer-turn", input.clientTurnId);
    if (prior) return prior as unknown as { user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null };
    if (thread.state === "ARCHIVED") throw new Error(`ExplorerThread ${input.threadId} is archived`);
    const plan = this.resolveExplorerPlan(thread, input.explorerPlanId);
    const turns = this.store.listTurns(input.threadId);
    /**
     * 下一个序号**从现有的最大值接着数，不能数行数**。
     *
     * `turns.length + 1` 在"回合只会跟整条线程一起消失"的年代是对的——那时行数恒等于最大序号。
     * 但删除一条**需求**之后，中间会留下空号（实测：删掉两条需求后剩下的序号是 1,2,7…14,17,18，
     * 行数 12），再数行数就会**撞上已经存在的号**：新需求的 #13/#14 与旧需求的 #13/#14 并存，
     * 同一线程里两对回合分不出先后。
     */
    const nextSequence = turns.reduce((max, turn) => Math.max(max, turn.sequence), 0) + 1;
    const firstRequirementMessage = turns.every((turn) => turn.explorerPlanId !== plan.id || turn.role !== "user");
    const hasActiveJob =
      this.activeTurnByPlan.has(plan.id) ||
      this.store
        .listTurns(input.threadId)
        .some(
          (turn) =>
            turn.explorerPlanId === plan.id &&
            (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED"),
        );
    const user: ExplorerTurn = {
      id: this.store.nextId("turn"),
      threadId: input.threadId,
      role: "user",
      content: input.content,
      status: "COMPLETED",
      createdAt: this.store.now(),
      sequence: nextSequence,
      explorerPlanId: plan.id,
    };
    const assistant: ExplorerTurn = {
      id: this.store.nextId("turn"),
      threadId: input.threadId,
      role: "assistant",
      content: "",
      status: hasActiveJob ? "QUEUED" : "RUNNING",
      createdAt: this.store.now(),
      sequence: nextSequence + 1,
      explorerPlanId: plan.id,
    };
    this.store.saveTurn(user);
    this.store.saveTurn(assistant);
    this.store.updateThread({
      ...thread,
      activeExplorerPlanId: plan.id,
      messageCount: thread.messageCount + 2,
      lastActivityAt: assistant.createdAt,
    });
    const firstSummary = summarizeExplorerMessage(input.content);
    this.store.updateExplorerPlan({
      ...plan,
      ...(firstRequirementMessage && plan.titleSource === "AUTO"
        ? { title: firstSummary || `Plan ${plan.ordinal} / 待探索`, titleStatus: firstSummary ? "GENERATED" : plan.titleStatus }
        : {}),
      messageCount: plan.messageCount + 2,
      latestUserMessageSummary: firstSummary,
      lastActivityAt: assistant.createdAt,
    });
    this.scheduleTitleGeneration(thread.id, input.content, plan.id);
    const accepted = {
      user,
      assistant,
      eventsUrl: `/api/v4/projects/${thread.projectId}/explorer-thread/events?threadId=${encodeURIComponent(thread.id)}&explorerPlanId=${encodeURIComponent(plan.id)}`,
    };
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.accepted",
        aggregateId: input.threadId,
        payload: { turnId: assistant.id, userTurnId: user.id, explorerPlanId: plan.id, loopId: null, state: assistant.status },
      }),
    );
    if (hasActiveJob) {
      const queue = this.queuedTurns.get(plan.id) ?? [];
      queue.push(assistant.id);
      this.queuedTurns.set(plan.id, queue);
      const acceptedWithQueue = { ...accepted, loopId: null };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithQueue as unknown as Record<string, unknown>);
      return acceptedWithQueue;
    }
    this.updatePlanRuntimeStatus(thread.id, plan.id, "RUNNING", assistant.id);
    try {
      const loop = await this.startQueuedTurn(thread.id, assistant.id);
      const acceptedWithLoop = { ...accepted, loopId: loop.id };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithLoop as unknown as Record<string, unknown>);
      return acceptedWithLoop;
    } catch (error) {
      const failed = this.failTurnStart(thread.id, assistant.id, error);
      const acceptedWithFailure = { ...accepted, assistant: failed ?? { ...assistant, status: "FAILED" as const }, loopId: null };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithFailure as unknown as Record<string, unknown>);
      void this.startNextQueuedTurn(plan.id);
      return acceptedWithFailure;
    }
  }

  private async startQueuedTurn(threadId: string, assistantId: string): Promise<AgentLoop> {
    const thread = this.store.getThread(threadId);
    const assistant = this.store.listTurns(threadId).find((turn) => turn.id === assistantId && turn.role === "assistant");
    if (!thread || !assistant) throw new Error(`Explorer turn ${assistantId} not found`);
    const plan = this.resolveExplorerPlan(thread, assistant.explorerPlanId);
    if (assistant.status === "QUEUED") this.store.updateTurn({ ...assistant, status: "RUNNING" });
    const job: {
      threadId: string;
      userId: string;
      assistantId: string;
      explorerPlanId: string;
      loopId?: string | undefined;
      providerThreadId: string | null;
      providerTurnId: string | null;
      resolveInput?: (() => void) | undefined;
      cancelled: boolean;
    } = {
      threadId,
      userId:
        this.store
          .listTurns(threadId)
          .find((turn) => turn.role === "user" && turn.sequence === assistant.sequence - 1 && turn.explorerPlanId === plan.id)?.id ?? "",
      assistantId,
      explorerPlanId: plan.id,
      providerThreadId: plan.providerThreadId ?? null,
      providerTurnId: null,
      cancelled: false,
    };
    this.jobs.set(assistantId, job);
    this.activeTurnByPlan.set(plan.id, assistantId);
    const user = this.store.listTurns(threadId).find((turn) => turn.id === job.userId);
    const repositoryContext = this.repositoryContextForProject?.(thread.projectId);
    const repositoryContextChanged = Boolean(repositoryContext && plan.repositoryContextKey !== repositoryContext.key);
    const latestPlan =
      repositoryContextChanged && repositoryContext
        ? this.store.updateExplorerPlan({ ...plan, repositoryContextKey: repositoryContext.key })
        : plan;
    const planBoundary = this.planBoundary(
      thread,
      latestPlan,
      user?.content ?? "",
      repositoryContextChanged ? repositoryContext?.summary : undefined,
    );
    const loop = await this.agentLoops.start({
      ownerType: "explorer-turn",
      ownerId: assistant.id,
      role: "explorer",
      mode: this.modelConfigForProject?.(thread.projectId)?.loopMode ?? "provider-controlled",
      maxSteps: this.loopMaxSteps,
      modelRequest: {
        messages: this.store
          .listTurns(thread.id)
          .filter(
            (turn) =>
              turn.explorerPlanId === plan.id &&
              turn.sequence < assistant.sequence &&
              !(turn.role === "assistant" && turn.status === "QUEUED"),
          )
          .map((turn) => ({ role: turn.role, content: turn.content })),
        conversationId: plan.id,
        continuationPrompt: planBoundary,
        ...(plan.providerThreadId ? { providerThreadId: plan.providerThreadId } : {}),
        ...(this.cwdForProject?.(thread.projectId) ? { cwd: this.cwdForProject(thread.projectId) } : {}),
        ...(this.modelConfigForProject?.(thread.projectId) ? { modelConfig: this.modelConfigForProject(thread.projectId) } : {}),
      },
      gate: new PlanCompletenessGate(),
      onEvent: (event) => this.handleExplorerLoopEvent(thread.id, assistant.id, event),
    });
    job.loopId = loop.id;
    this.updatePlanRuntimeStatus(threadId, plan.id, "RUNNING", assistantId);
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.started",
        aggregateId: threadId,
        payload: { turnId: assistantId, explorerPlanId: plan.id, loopId: loop.id },
      }),
    );
    return loop;
  }

  private async startNextQueuedTurn(explorerPlanId: string): Promise<void> {
    if (this.activeTurnByPlan.has(explorerPlanId)) return;
    const queue = this.queuedTurns.get(explorerPlanId) ?? [];
    let assistantId: string | undefined;
    let threadId: string | undefined;
    while (queue.length > 0 && !assistantId) {
      const candidateId = queue.shift();
      const candidate = candidateId ? this.findTurn(candidateId) : undefined;
      if (candidate?.turn.role === "assistant" && candidate.turn.status === "QUEUED" && candidate.turn.explorerPlanId === explorerPlanId) {
        assistantId = candidate.turn.id;
        threadId = candidate.threadId;
      }
    }
    if (queue.length === 0) this.queuedTurns.delete(explorerPlanId);
    else this.queuedTurns.set(explorerPlanId, queue);
    if (!assistantId) return;
    try {
      await this.startQueuedTurn(threadId!, assistantId);
    } catch (error) {
      this.failTurnStart(threadId!, assistantId, error);
      await this.startNextQueuedTurn(explorerPlanId);
    }
  }

  private failTurnStart(threadId: string, assistantId: string, error: unknown): ExplorerTurn | undefined {
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId && turn.role === "assistant");
    const message = error instanceof Error ? error.message : String(error);
    const failed =
      current && current.status !== "FAILED"
        ? this.store.updateTurn({ ...current, status: "FAILED", error: message, content: current.content || "模型调用未能启动" })
        : current;
    const job = this.jobs.get(assistantId);
    this.jobs.delete(assistantId);
    const explorerPlanId = job?.explorerPlanId ?? current?.explorerPlanId;
    if (explorerPlanId && this.activeTurnByPlan.get(explorerPlanId) === assistantId) this.activeTurnByPlan.delete(explorerPlanId);
    if (explorerPlanId) this.updatePlanRuntimeStatus(threadId, explorerPlanId, "FAILED", assistantId);
    if (current?.status !== "FAILED") {
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.failed",
          aggregateId: threadId,
          payload: {
            assistantTurnId: assistantId,
            turnId: assistantId,
            explorerPlanId: explorerPlanId ?? null,
            loopId: job?.loopId ?? null,
            error: message,
          },
        }),
      );
    }
    return failed;
  }

  private updatePlanRuntimeStatus(
    threadId: string,
    explorerPlanId: string,
    runtimeStatus: NonNullable<ExplorerTurn["status"]>,
    turnId?: string,
  ): void {
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== threadId) return;
    const statusChanged = plan.runtimeStatus !== runtimeStatus;
    this.store.updateExplorerPlan({ ...plan, runtimeStatus, lastActivityAt: this.store.now() });
    if (!statusChanged) return;
    this.publish(
      this.store.appendEvent({
        type: "explorer.requirement.status.changed",
        aggregateId: threadId,
        payload: {
          explorerPlanId,
          turnId: turnId ?? this.activeTurnByPlan.get(explorerPlanId) ?? null,
          status: runtimeStatus,
          occurredAt: this.store.now(),
        },
      }),
    );
  }

  private findTurn(turnId: string): { threadId: string; turn: ExplorerTurn } | undefined {
    for (const thread of this.store.listThreads()) {
      const turn = this.store.listTurns(thread.id).find((item) => item.id === turnId);
      if (turn) return { threadId: thread.id, turn };
    }
    return undefined;
  }

  private resolveExplorerPlan(thread: ExplorerThread, explorerPlanId?: string): ExplorerPlan {
    const selected = explorerPlanId
      ? this.store.getExplorerPlan(explorerPlanId)
      : this.store.getExplorerPlan(thread.activeExplorerPlanId ?? "");
    if (explorerPlanId && (!selected || selected.explorerThreadId !== thread.id || selected.projectId !== thread.projectId))
      throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    if (selected && selected.explorerThreadId === thread.id && selected.projectId === thread.projectId) return selected;
    const first = this.store.listExplorerPlans(thread.id)[0];
    if (first) return first;
    const createdAt = this.store.now();
    const created = defaultExplorerPlan(thread, this.store.nextId("explorer-plan"), 1, createdAt);
    this.store.saveExplorerPlan(created);
    this.store.updateThread({
      ...thread,
      activeExplorerPlanId: created.id,
      contextSummary: { ...(thread.contextSummary ?? defaultThreadContextSummary(createdAt)), openPlanIds: [created.id] },
    });
    return created;
  }

  private planBoundary(_thread: ExplorerThread, plan: ExplorerPlan, content: string, repositorySummary?: string): string {
    const firstPlanTurn =
      this.store.listTurns(plan.explorerThreadId).filter((turn) => turn.explorerPlanId === plan.id && turn.role === "user").length <= 1;
    return `[需求 ${plan.ordinal}: ${plan.title}]\n${repositorySummary ? `Project repository index (versioned, shared across requirements):\n${repositorySummary}\n` : ""}${firstPlanTurn ? "This is an isolated requirement conversation. Do not infer decisions from sibling requirements.\n" : "Continue only the current requirement conversation.\n"}User message:\n${content}`;
  }

  async backfillTitles(): Promise<void> {
    if (!this.titleGenerator) return;
    await Promise.all(
      this.store.listThreads().map(async (thread) => {
        if (thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
        const firstUser = this.store.listTurns(thread.id).find((turn) => turn.role === "user" && turn.content.trim());
        if (!firstUser) return;
        this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
        await this.generateTitle(thread.id, firstUser.content, firstUser.explorerPlanId);
      }),
    );
  }

  private scheduleTitleGeneration(threadId: string, content: string, explorerPlanId: string): void {
    if (!this.titleGenerator || !content.trim()) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
    if (this.store.listTurns(threadId).filter((turn) => turn.role === "user" && turn.content.trim()).length !== 1) return;
    this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
    void this.generateTitle(threadId, content, explorerPlanId);
  }

  private async generateTitle(threadId: string, content: string, explorerPlanId?: string): Promise<void> {
    const generator = this.titleGenerator;
    if (!generator) return;
    try {
      const generated = normalizeExplorerTitle(await generator.generate({ threadId, content }));
      if (!generated) throw new Error("Explorer title generator returned an invalid title");
      const thread = this.store.getThread(threadId);
      if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "GENERATING") return;
      const updated = this.store.updateThread({
        ...thread,
        title: composeExplorerTitle(thread.createdAt, generated),
        titleStatus: "GENERATED",
      });
      this.publish(
        this.store.appendEvent({
          type: "explorer.title.updated",
          aggregateId: threadId,
          payload: {
            explorerId: threadId,
            explorerPlanId: explorerPlanId ?? updated.activeExplorerPlanId,
            turnId: null,
            loopId: null,
            title: updated.title,
            titleStatus: updated.titleStatus,
          },
        }),
      );
    } catch {
      const thread = this.store.getThread(threadId);
      if (thread?.titleSource === "AUTO" && thread.titleStatus === "GENERATING")
        this.store.updateThread({ ...thread, title: projectPlaceholderExplorerTitle(this.store, thread), titleStatus: "FAILED" });
    }
  }

  async answerInput(input: {
    threadId: string;
    requestId: string;
    answers: ModelInputAnswers;
    clientRequestId: string;
    actorId: string;
  }): Promise<{ request: ExplorerInputRequest; turn: ExplorerTurn }> {
    const existingResult = this.store.getIdempotency("input-answer", input.clientRequestId);
    if (existingResult) return existingResult as unknown as { request: ExplorerInputRequest; turn: ExplorerTurn };
    const request = this.store.getInputRequest(input.requestId);
    if (!request) throw new Error("Input request not found");
    if (request.threadId !== input.threadId) throw new Error("Input request does not belong to this ExplorerThread");
    if (request.status === "ANSWERED") {
      const turn = this.store.listTurns(input.threadId).find((item) => item.id === request.localTurnId && item.role === "assistant");
      if (!turn) throw new Error("Assistant turn for input request not found");
      const result = { request, turn };
      this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
      return result;
    }
    if (request.status !== "OPEN") throw new Error(`Input request cannot be answered from ${request.status}`);
    validateInputAnswers(request.questions, input.answers);
    const job = this.jobs.get(request.localTurnId);
    if (!job?.loopId || job.providerThreadId !== request.providerThreadId || job.providerTurnId !== request.providerTurnId)
      throw new Error("Input request requires recovery before it can be answered");
    this.store.updateInputRequest({ ...request, status: "SUBMITTING" });
    try {
      await this.agentLoops.answerInput(job.loopId, request.providerRequestId, input.answers);
    } catch (error) {
      const recovery = { ...request, status: "RECOVERY_REQUIRED" as const };
      this.store.updateInputRequest(recovery);
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.failed",
          aggregateId: input.threadId,
          payload: {
            inputRequestId: request.id,
            turnId: request.localTurnId,
            explorerPlanId: request.explorerPlanId ?? null,
            loopId: job.loopId ?? null,
            recoveryRequired: true,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      // `cause` 是给排障留的：这一句是给用户看的"要恢复"，底下 Provider 报的才是原因。
      throw new Error(
        `Structured input response is uncertain; recovery is required: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const answered: ExplorerInputRequest = {
      ...request,
      status: "ANSWERED",
      answeredAt: this.store.now(),
      answeredBy: input.actorId,
      redactedAnswerSummary: Object.fromEntries(
        request.questions.map((question) => {
          const answers = (input.answers[question.id]?.answers ?? []).map((answer) => answer.trim()).filter(Boolean);
          return [question.id, { answerCount: answers.length, secret: question.isSecret, ...(question.isSecret ? {} : { answers }) }];
        }),
      ),
    };
    this.store.updateInputRequest(answered);
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === request.localTurnId && turn.role === "assistant");
    if (!assistant) throw new Error("Assistant turn for input request not found");
    this.store.updateTurn({ ...assistant, status: "RUNNING" });
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "RUNNING", assistant.id);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.input.resolved",
        aggregateId: input.threadId,
        payload: {
          inputRequestId: request.id,
          turnId: request.localTurnId,
          explorerPlanId: request.explorerPlanId ?? null,
          loopId: job.loopId ?? null,
          actorId: input.actorId,
          answerCounts: answered.redactedAnswerSummary,
        },
      }),
    );
    const result = { request: answered, turn: { ...assistant, status: "RUNNING" as const } };
    this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
    return result;
  }

  async cancelTurn(input: { threadId: string; turnId: string; reason: string }): Promise<ExplorerTurn> {
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === input.turnId && turn.role === "assistant");
    if (!assistant) throw new Error("Active Explorer turn not found");
    const job = this.jobs.get(assistant.id);
    if (!job) {
      const planId = assistant.explorerPlanId;
      const queue = planId ? (this.queuedTurns.get(planId) ?? []) : [];
      if (assistant.status !== "QUEUED" || !queue.includes(assistant.id)) throw new Error("Active Explorer turn not found");
      this.queuedTurns.set(
        planId!,
        queue.filter((id) => id !== assistant.id),
      );
      const cancelledQueued = { ...assistant, status: "CANCELLED" as const, content: "本轮已取消", error: input.reason };
      this.store.updateTurn(cancelledQueued);
      if (assistant.explorerPlanId && !this.activeTurnByPlan.has(assistant.explorerPlanId))
        this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED", assistant.id);
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.cancelled",
          aggregateId: input.threadId,
          payload: { turnId: input.turnId, explorerPlanId: assistant.explorerPlanId ?? null, loopId: null, reason: input.reason },
        }),
      );
      return cancelledQueued;
    }
    job.cancelled = true;
    if (job.loopId) await this.agentLoops.cancel(job.loopId, input.reason);
    else if (job.providerThreadId)
      await this.model.cancel({
        conversationId: job.explorerPlanId,
        providerThreadId: job.providerThreadId,
        ...(job.providerTurnId ? { providerTurnId: job.providerTurnId } : {}),
      });
    for (const request of this.store.listInputRequests(input.threadId, "OPEN"))
      if (request.localTurnId === assistant.id)
        this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
    job.resolveInput?.();
    const cancelled: ExplorerTurn = { ...assistant, status: "CANCELLED", content: "本轮已取消", error: input.reason };
    this.store.updateTurn(cancelled);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED", assistant.id);
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.cancelled",
        aggregateId: input.threadId,
        payload: {
          turnId: input.turnId,
          explorerPlanId: assistant.explorerPlanId ?? null,
          loopId: job.loopId ?? null,
          reason: input.reason,
        },
      }),
    );
    return cancelled;
  }

  agentLoopController(): Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> {
    return {
      pause: (loopId, reason) => this.pauseLoop(loopId, reason),
      resume: (loopId) => this.resumeLoop(loopId),
      cancel: (loopId, reason) => this.cancelLoop(loopId, reason),
    };
  }

  private loopTurn(loopId: string): { loop: AgentLoop; threadId: string; turnId: string } {
    const loop = this.store.getAgentLoop(loopId);
    if (!loop || loop.ownerType !== "explorer-turn") throw new Error(`Explorer AgentLoop ${loopId} not found`);
    const turn = this.store
      .listThreads()
      .flatMap((thread) => this.store.listTurns(thread.id))
      .find((candidate) => candidate.id === loop.ownerId);
    if (!turn) throw new Error(`Explorer turn for AgentLoop ${loopId} not found`);
    return { loop, threadId: turn.threadId, turnId: turn.id };
  }

  async pauseLoop(loopId: string, reason: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    const paused = await this.agentLoops.pause(loopId, reason);
    const turn = this.store.listTurns(threadId).find((item) => item.id === turnId);
    if (turn && turn.status === "RUNNING") this.store.updateTurn({ ...turn, status: "PAUSED" });
    const pausedTurn = this.store.listTurns(threadId).find((turn) => turn.id === turnId);
    if (pausedTurn?.explorerPlanId) this.updatePlanRuntimeStatus(threadId, pausedTurn.explorerPlanId, "PAUSED", turnId);
    return paused;
  }

  async resumeLoop(loopId: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    const resumed = await this.agentLoops.resume(loopId);
    const turn = this.store.listTurns(threadId).find((item) => item.id === turnId);
    if (turn && turn.status === "PAUSED") this.store.updateTurn({ ...turn, status: "RUNNING" });
    if (turn?.explorerPlanId) this.updatePlanRuntimeStatus(threadId, turn.explorerPlanId, "RUNNING", turnId);
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    return resumed;
  }

  async cancelLoop(loopId: string, reason: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    await this.cancelTurn({ threadId, turnId, reason });
    return this.agentLoops.get(loopId);
  }

  subscribeEvents(threadId: string, listener: (event: DomainEvent) => void, afterSequence = 0): () => void {
    for (const event of this.store.listEvents({ aggregateId: threadId, afterSequence })) listener(event);
    const listeners = this.listeners.get(threadId) ?? new Set<(event: DomainEvent) => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  private handleExplorerLoopEvent(threadId: string, assistantId: string, event: AgentLoopEvent): void {
    const job = this.jobs.get(assistantId);
    if (!job) return;
    if (event.type === "agent.provider.thread.started") {
      const providerThreadId = String(event.payload.threadId ?? "");
      if (providerThreadId) {
        job.providerThreadId = providerThreadId;
        const plan = this.store.getExplorerPlan(job.explorerPlanId);
        if (plan) this.store.updateExplorerPlan({ ...plan, providerThreadId, lastActivityAt: this.store.now() });
      }
      return;
    }
    if (event.type === "agent.model.text.delta") {
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (!text) return;
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (!current) return;
      const providerThreadId = typeof event.payload.providerThreadId === "string" ? event.payload.providerThreadId : null;
      if (providerThreadId) {
        const currentPlan = this.store.getExplorerPlan(job.explorerPlanId);
        if (currentPlan && currentPlan.providerThreadId !== providerThreadId)
          this.store.updateExplorerPlan({ ...currentPlan, providerThreadId, lastActivityAt: this.store.now() });
      }
      this.store.updateTurn({ ...current, content: current.content + text, status: "RUNNING" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "RUNNING", assistantId);
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.text.delta",
          aggregateId: threadId,
          payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, text },
        }),
      );
      return;
    }
    if (event.type === "agent.input.required") {
      const request = event.payload.request as ModelInputRequest | undefined;
      if (!request) return;
      job.providerThreadId = request.threadId;
      job.providerTurnId = request.turnId;
      const currentPlan = this.store.getExplorerPlan(job.explorerPlanId);
      if (currentPlan && currentPlan.providerThreadId !== request.threadId)
        this.store.updateExplorerPlan({ ...currentPlan, providerThreadId: request.threadId, lastActivityAt: this.store.now() });
      const inputRequest: ExplorerInputRequest = {
        id: this.store.nextId("input"),
        threadId,
        explorerPlanId: job.explorerPlanId,
        localTurnId: assistantId,
        providerRequestId: request.requestId,
        providerThreadId: request.threadId,
        providerTurnId: request.turnId,
        itemId: request.itemId,
        questions: request.questions,
        isBlocking: request.isBlocking,
        status: "OPEN",
        createdAt: this.store.now(),
        answeredAt: null,
        answeredBy: null,
        redactedAnswerSummary: null,
      };
      const saved = this.store.saveInputRequest(inputRequest);
      const currentThread = this.store.getThread(threadId);
      if (currentThread) this.store.updateThread({ ...currentThread, lastActivityAt: this.store.now() });
      const currentTurn = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (currentTurn) this.store.updateTurn({ ...currentTurn, status: "WAITING_FOR_INPUT" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "WAITING_FOR_INPUT", assistantId);
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.input_required",
          aggregateId: threadId,
          payload: {
            requestId: saved.id,
            threadId,
            turnId: assistantId,
            explorerPlanId: job.explorerPlanId,
            loopId: job.loopId ?? null,
            localTurnId: assistantId,
            providerRequestId: saved.providerRequestId,
            providerThreadId: saved.providerThreadId,
            providerTurnId: saved.providerTurnId,
            itemId: saved.itemId,
            questions: saved.questions,
            isBlocking: saved.isBlocking,
          },
        }),
      );
      return;
    }
    if (event.type === "agent.loop.completed") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    if (event.type === "agent.loop.cancelled") {
      for (const request of this.store.listInputRequests(threadId))
        if (request.localTurnId === assistantId && (request.status === "OPEN" || request.status === "SUBMITTING"))
          this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (current && current.status !== "CANCELLED")
        this.store.updateTurn({ ...current, status: "CANCELLED", content: current.content || "本轮已取消" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "CANCELLED", assistantId);
      this.publish(
        this.store.appendEvent({
          type: "explorer.turn.cancelled",
          aggregateId: threadId,
          payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, reason: event.payload.reason },
        }),
      );
      this.finishExplorerJob(assistantId);
      return;
    }
    if (event.type === "agent.loop.failed")
      this.handleExplorerLoopFailure(threadId, assistantId, String(event.payload.error ?? event.payload.reason ?? "AgentLoop failed"));
  }

  private finalizeExplorerLoop(threadId: string, assistantId: string): void {
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const thread = this.store.getThread(threadId);
    if (!current || !thread) return;
    const explorerPlan = this.resolveExplorerPlan(thread, current.explorerPlanId);
    const assessment = assessPlanCompletion(current.content);
    const updatedPlan = this.store.updateExplorerPlan({
      ...explorerPlan,
      exploration: {
        ...explorerPlan.exploration,
        status: assessment.status,
        missing: assessment.missing,
        completed: assessment.completed,
        diagnostics: assessment.diagnostics,
        lastAssessedTurnId: assistantId,
      },
      lastAssessedTurnId: assistantId,
      lastActivityAt: this.store.now(),
    });
    const mirror = {
      status: assessment.status,
      missing: assessment.missing,
      completed: assessment.completed,
      diagnostics: assessment.diagnostics,
      candidatePlanId: explorerPlan.candidatePlanId,
      lastAssessedTurnId: assistantId,
    };
    this.updateThreadContextSummary(threadId, updatedPlan, assessment.artifact?.generatedSpec?.objective.goal ?? null);
    const currentThread = this.store.getThread(threadId) ?? thread;
    this.store.updateThread({
      ...currentThread,
      ...(currentThread.activeExplorerPlanId === explorerPlan.id ? { exploration: mirror } : {}),
      lastActivityAt: this.store.now(),
    });
    this.publish(
      this.store.appendEvent({
        type: assessment.status === "READY" ? "explorer.plan.ready" : "explorer.plan.incomplete",
        aggregateId: threadId,
        payload: {
          turnId: assistantId,
          explorerPlanId: explorerPlan.id,
          missing: assessment.missing,
          completed: assessment.completed,
          diagnostics: assessment.diagnostics,
        },
      }),
    );
    if (assessment.status === "READY" && assessment.artifact) {
      const source = this.planSource(assistantId);
      const activeDraftId =
        thread.activeRevisionDraftId &&
        (this.store.getRevisionDraft(thread.activeRevisionDraftId)?.explorerPlanId === undefined ||
          this.store.getRevisionDraft(thread.activeRevisionDraftId)?.explorerPlanId === explorerPlan.id)
          ? thread.activeRevisionDraftId
          : null;
      if (activeDraftId) {
        this.plans.updateRevisionDraftFromExplorer(activeDraftId, assessment.artifact, source);
        const revisedPlan = this.store.getRevisionDraft(activeDraftId)?.planId ?? null;
        const planAfterDraft = this.store.getExplorerPlan(explorerPlan.id);
        if (planAfterDraft)
          this.store.updateExplorerPlan({
            ...planAfterDraft,
            exploration: {
              status: "READY",
              missing: [],
              completed: [...REQUIRED_PLAN_AREAS],
              diagnostics: [],
              candidatePlanId: revisedPlan,
              lastAssessedTurnId: assistantId,
            },
            candidatePlanId: revisedPlan,
            newPlanRequested: false,
            lastAssessedTurnId: assistantId,
            lastActivityAt: this.store.now(),
          });
      } else {
        const existing = explorerPlan.candidatePlanId ? this.store.getPlan(explorerPlan.candidatePlanId) : undefined;
        const plan =
          existing?.status === "DRAFT"
            ? this.plans.reviseCandidate(existing.id, assessment.artifact, source)
            : this.plans.createCandidatePlan({
                projectId: thread.projectId,
                sourceExplorerThreadId: threadId,
                explorerPlanId: explorerPlan.id,
                title: assessment.artifact.title,
                generatedSpec: assessment.artifact.generatedSpec,
                ...source,
              });
        const planAfterCandidate = this.store.updateExplorerPlan({
          ...this.store.getExplorerPlan(explorerPlan.id)!,
          exploration: {
            status: "READY",
            missing: [],
            completed: [...REQUIRED_PLAN_AREAS],
            diagnostics: [],
            candidatePlanId: plan.id,
            lastAssessedTurnId: assistantId,
          },
          candidatePlanId: plan.id,
          newPlanRequested: false,
          lastAssessedTurnId: assistantId,
          lastActivityAt: this.store.now(),
        });
        this.updateThreadContextSummary(threadId, planAfterCandidate, plan.resolvedContract.objective.goal ?? null);
        const latestThread = this.store.getThread(threadId)!;
        if (latestThread.activeExplorerPlanId === explorerPlan.id)
          this.store.updateThread({ ...latestThread, exploration: planAfterCandidate.exploration, lastActivityAt: this.store.now() });
      }
    }
    this.store.updateTurn({ ...current, status: "COMPLETED", content: stripPlanProtocol(current.content) });
    this.updatePlanRuntimeStatus(threadId, explorerPlan.id, "COMPLETED", assistantId);
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.completed",
        aggregateId: threadId,
        payload: {
          assistantTurnId: assistantId,
          turnId: assistantId,
          explorerPlanId: explorerPlan.id,
          loopId: this.jobs.get(assistantId)?.loopId ?? null,
          planReady: assessment.status === "READY",
        },
      }),
    );
    this.finishExplorerJob(assistantId);
  }

  private handleExplorerLoopFailure(threadId: string, assistantId: string, error: string): void {
    if (error === "MAX_STEPS_EXCEEDED" || error === "NO_PROGRESS") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    for (const request of this.store.listInputRequests(threadId))
      if (request.localTurnId === assistantId && (request.status === "OPEN" || request.status === "SUBMITTING"))
        this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const job = this.jobs.get(assistantId);
    if (current && current.status !== "CANCELLED")
      this.store.updateTurn({ ...current, status: "FAILED", error, content: current.content || `模型调用失败：${error}` });
    if (job) this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "FAILED", assistantId);
    this.publish(
      this.store.appendEvent({
        type: "explorer.turn.failed",
        aggregateId: threadId,
        payload: {
          assistantTurnId: assistantId,
          turnId: assistantId,
          explorerPlanId: job?.explorerPlanId ?? current?.explorerPlanId ?? null,
          loopId: job?.loopId ?? null,
          error,
        },
      }),
    );
    this.finishExplorerJob(assistantId);
  }

  private finishExplorerJob(assistantId: string): void {
    const job = this.jobs.get(assistantId);
    if (!job) return;
    const thread = this.store.getThread(job.threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    this.jobs.delete(assistantId);
    if (this.activeTurnByPlan.get(job.explorerPlanId) === assistantId) this.activeTurnByPlan.delete(job.explorerPlanId);
    void this.startNextQueuedTurn(job.explorerPlanId);
  }

  private updateThreadContextSummary(threadId: string, changedPlan: ExplorerPlan, goal: string | null): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const plans = this.store.listExplorerPlans(threadId).map((plan) => (plan.id === changedPlan.id ? changedPlan : plan));
    const completedPlans = plans
      .filter((plan) => plan.exploration.status === "READY")
      .map((plan) => {
        const candidate = plan.candidatePlanId ? this.store.getPlan(plan.candidatePlanId) : undefined;
        const resolvedGoal = goal && plan.id === changedPlan.id ? goal : (candidate?.resolvedContract.objective.goal ?? null);
        const keyConstraints = candidate?.generatedSpec?.design.technicalConstraints ?? [];
        return {
          explorerPlanId: plan.id,
          title: plan.title,
          status: plan.exploration.status,
          goal: resolvedGoal,
          keyConstraints: [...keyConstraints],
          latestUserMessageSummary: plan.latestUserMessageSummary,
        };
      });
    const contextSummary: ExplorerThreadContextSummary = {
      version: 1,
      updatedAt: this.store.now(),
      completedPlans,
      openPlanIds: plans.filter((plan) => plan.exploration.status !== "READY").map((plan) => plan.id),
    };
    this.store.updateThread({ ...thread, contextSummary });
  }

  private planSource(assistantId: string): {
    sourceTurnId: string;
    providerThreadId: string | null;
    providerTurnId: string | null;
    providerItemId: string | null;
  } {
    const loop = this.store.listAgentLoops(assistantId).at(-1);
    const steps = loop ? this.store.listAgentLoopSteps(loop.id) : [];
    const latestTextStep = [...steps]
      .reverse()
      .find((step) => step.stepType === "MODEL_TEXT_DELTA" && typeof step.payload.providerItemId === "string");
    const latestProviderStep =
      latestTextStep ??
      [...steps].reverse().find((step) => typeof step.payload.providerItemId === "string" || typeof step.payload.itemId === "string");
    const providerThreadId = loop?.providerThreadId ?? [...steps].reverse().find((step) => step.providerThreadId)?.providerThreadId ?? null;
    const providerTurnId = loop?.providerTurnId ?? [...steps].reverse().find((step) => step.providerTurnId)?.providerTurnId ?? null;
    const providerItemId =
      typeof latestProviderStep?.payload.providerItemId === "string"
        ? latestProviderStep.payload.providerItemId
        : typeof latestProviderStep?.payload.itemId === "string"
          ? latestProviderStep.payload.itemId
          : null;
    return { sourceTurnId: assistantId, providerThreadId, providerTurnId, providerItemId };
  }

  private publish(event: DomainEvent): void {
    for (const listener of this.listeners.get(event.aggregateId) ?? []) listener(event);
  }
}

function validateInputAnswers(questions: ModelInputQuestion[], answers: ModelInputAnswers): void {
  const questionIds = new Set(questions.map((question) => question.id));
  for (const questionId of Object.keys(answers)) if (!questionIds.has(questionId)) throw new Error(`Unknown question id: ${questionId}`);
  for (const question of questions) {
    const values = answers[question.id]?.answers;
    if (!values || values.length === 0) throw new Error(`Answer is required for question ${question.id}`);
    if (question.options) {
      const allowed = new Set(question.options.map((option) => option.label));
      const customValues = values.filter((value) => !allowed.has(value));
      if (customValues.length > 0 && (!question.isOther || values.length !== 1))
        throw new Error(`Invalid option for question ${question.id}`);
    }
    if (
      question.isOther &&
      (!question.options || values.some((value) => !question.options!.some((option) => option.label === value))) &&
      values.length !== 1
    )
      throw new Error(`Other answer must contain exactly one value for question ${question.id}`);
  }
}
