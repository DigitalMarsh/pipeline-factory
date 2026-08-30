/**
 * 模块职责：定义 Agent Loop 的状态、步骤事件、终止门禁和生命周期控制。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
/** 标识继续策略由 Provider 还是 Factory 的本地状态机负责。 */
export type AgentLoopMode = "provider-controlled" | "factory-controlled";

/** Agent Loop 的持久化状态；终态不会再创建新的模型步骤。 */
export type AgentLoopState =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "PAUSED"
  | "RECOVERING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_RECONCILIATION";

/** Agent Loop 可审计的步骤类型；每种类型都可通过 journal/SSE 回放。 */
export type AgentStepType =
  | "MODEL_STARTED"
  | "MODEL_TEXT_DELTA"
  | "PROVIDER_ACTIVITY"
  | "MODEL_COMPLETED"
  | "TOOL_REQUESTED"
  | "TOOL_DENIED"
  | "TOOL_COMPLETED"
  | "TOOL_FAILED"
  | "TOOL_NEEDS_RECONCILIATION"
  | "INPUT_REQUIRED"
  | "INPUT_RESOLVED"
  | "CONTEXT_COMPACTED"
  | "GATE_CHECKED"
  | "LOOP_SUSPENDED"
  | "LOOP_RESUMED"
  | "LOOP_COMPLETED"
  | "LOOP_FAILED";

/** Loop 的持久化聚合；providerThreadId/providerTurnId 用于恢复和取消外部会话。 */
export type AgentLoop = {
  id: string;
  ownerType: "explorer-turn" | "run";
  ownerId: string;
  role: "explorer" | "executor";
  mode: AgentLoopMode;
  state: AgentLoopState;
  stepCount: number;
  maxSteps: number;
  startedAt: string | null;
  completedAt: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  checkpointJson: string | null;
};

/** 单步生命周期状态；NEEDS_RECONCILIATION 表示外部副作用结果未知。 */
export type AgentLoopStepStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "DENIED"
  | "CANCELLED"
  | "NEEDS_RECONCILIATION";

/** Loop 内单步事实，sequence 与 Domain Event 共同支持审计和增量回放。 */
export type AgentLoopStep = {
  loopId: string;
  sequence: number;
  stepType: AgentStepType;
  status: AgentLoopStepStatus;
  callId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
};

/** 创建 Loop 步骤时允许调用方省略由 Store/Engine 生成的审计字段。 */
export type AgentLoopStepInput = Omit<AgentLoopStep, "sequence" | "occurredAt" | "callId" | "providerThreadId" | "providerTurnId"> & Partial<Pick<AgentLoopStep, "callId" | "providerThreadId" | "providerTurnId" | "occurredAt">>;

import type { ModelEvent, ModelGateway, ModelMessage, ModelRequest, ModelRole, ToolCall } from "./index.js";
import type { PipelineStore } from "./index.js";
import type { ToolRuntime } from "./tool-runtime.js";

/** 启动 Loop 所需的角色、循环限制、模型请求和可选工具/门禁。 */
export type AgentLoopInput = {
  id?: string;
  ownerType: AgentLoop["ownerType"];
  ownerId: string;
  role: AgentLoop["role"];
  mode: AgentLoopMode;
  maxSteps: number;
  maxDurationMs?: number;
  maxRepeatedToolCalls?: number;
  maxNoProgressSteps?: number;
  modelRequest: Omit<ModelRequest, "role">;
  gate?: TerminationGate;
  toolRuntime?: ToolRuntime;
  workspacePath?: string;
  onEvent?: (event: AgentLoopEvent) => void;
};

/** Loop 的终态结果；reason 用于 UI、审计和恢复诊断。 */
export type AgentLoopResult = {
  loop: AgentLoop;
  reason: string;
};

/** 终止门禁的明确决策；blocked 与 complete 都会结束当前 Loop。 */
export type GateDecision =
  | { action: "continue"; reason: string }
  | { action: "suspend"; reason: string }
  | { action: "complete"; reason: string }
  | { action: "blocked"; reason: string };

/** 门禁可见的模型输出和执行事实，不直接暴露 Store 给策略实现。 */
export type GateContext = {
  content?: string;
  reportReady?: boolean;
  allTasksComplete?: boolean;
  hasOpenToolCalls?: boolean;
  hasPendingChangeProposal?: boolean;
  pathsWithinScope?: boolean;
};

export interface TerminationGate {
  /** 根据当前模型输出和运行上下文决定继续、暂停、完成或阻塞。 */
  evaluate(context: GateContext): GateDecision;
}

/** 对外实时事件；payload 保持结构化以便 API SSE 和 UI 投影复用。 */
export type AgentLoopEvent = {
  loopId: string;
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
};

export type AgentLoopEngineOptions = {
  defaultMaxSteps?: number;
  defaultMaxDurationMs?: number;
  defaultMaxRepeatedToolCalls?: number;
  defaultMaxNoProgressSteps?: number;
};

/**
 * 驱动一次可恢复的模型循环，并把步骤、事件和控制状态持久化到 PipelineStore。
 * Provider-controlled 模式只消费 Provider 事件；factory-controlled 模式才会调用 ToolRuntime，
 * 这样两种工具循环不会嵌套，也不会重复执行 Provider 已经处理的工具。
 */
export class AgentLoopEngine implements AgentLoopRunner {
  private readonly waiters = new Map<string, Promise<AgentLoop>>();
  private readonly resolveWaiters = new Map<string, (loop: AgentLoop) => void>();
  private readonly listeners = new Map<string, Set<(event: AgentLoopEvent) => void>>();
  private readonly pendingInputs = new Map<string, {
    requestId: string | number;
    resolve: (answers: Record<string, { answers: string[] }>) => void;
    reject: (error: Error) => void;
    completion: Promise<void>;
    complete: () => void;
    fail: (error: Error) => void;
  }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly callbacks = new Map<string, (event: AgentLoopEvent) => void>();
  private readonly options: Required<AgentLoopEngineOptions>;

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, private readonly defaultToolRuntime?: ToolRuntime, options: AgentLoopEngineOptions = {}) {
    this.options = {
      defaultMaxSteps: options.defaultMaxSteps ?? 40,
      defaultMaxDurationMs: options.defaultMaxDurationMs ?? 1_800_000,
      defaultMaxRepeatedToolCalls: options.defaultMaxRepeatedToolCalls ?? 2,
      defaultMaxNoProgressSteps: options.defaultMaxNoProgressSteps ?? 3,
    };
  }

  /** 创建并异步启动 Loop；调用方可通过事件订阅或 wait 获取最终状态。 */
  async start(input: AgentLoopInput): Promise<AgentLoop> {
    const loop = this.create(input);
    if (input.onEvent) this.callbacks.set(loop.id, input.onEvent);
    this.createWaiter(loop.id);
    void this.execute(input, loop).catch((error) => this.fail(loop.id, error instanceof Error ? error.message : String(error)));
    return loop;
  }

  /** 创建并同步运行 Loop，适合需要等待完整执行结果的后台任务。 */
  async run(input: AgentLoopInput): Promise<AgentLoop> {
    const loop = this.create(input);
    if (input.onEvent) this.callbacks.set(loop.id, input.onEvent);
    this.createWaiter(loop.id);
    await this.execute(input, loop);
    return this.get(loop.id);
  }

  /** 等待指定 Loop 进入终态；已完成的 Loop 直接返回持久化状态。 */
  async wait(loopId: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (isTerminal(loop.state)) return loop;
    this.createWaiter(loopId);
    return this.waiters.get(loopId)!;
  }

  /** 提交当前结构化问题的答案，并等待 Provider 接收答案后的状态更新。 */
  async answerInput(loopId: string, requestId: string | number, answers: Record<string, { answers: string[] }>): Promise<AgentLoop> {
    const pending = this.pendingInputs.get(loopId);
    if (!pending || String(pending.requestId) !== String(requestId)) throw new Error("AgentLoop input request is not open");
    pending.resolve(answers);
    await pending.completion;
    return this.get(loopId);
  }

  /** 订阅实时事件；返回的函数用于解绑，持久化事件仍由 Store 保留。 */
  subscribe(loopId: string, listener: (event: AgentLoopEvent) => void): () => void {
    const listeners = this.listeners.get(loopId) ?? new Set<(event: AgentLoopEvent) => void>();
    listeners.add(listener);
    this.listeners.set(loopId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.listeners.delete(loopId); };
  }

  /** 从 PAUSED 或 RECOVERING 恢复 Loop，不重放已经完成的步骤。 */
  async resume(loopId: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (loop.state !== "PAUSED" && loop.state !== "RECOVERING") throw new Error(`AgentLoop ${loopId} cannot be resumed from ${loop.state}`);
    const resumed = { ...loop, state: "RUNNING" as const };
    this.store.updateAgentLoop(resumed);
    this.emit(resumed, "agent.loop.resumed", { loopId });
    return resumed;
  }

  /** 写入 checkpoint 后暂停 Loop；当前 Provider 调用由控制器决定是否继续中断。 */
  async pause(loopId: string, reason: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (isTerminal(loop.state)) throw new Error(`AgentLoop ${loopId} is already ${loop.state}`);
    const paused = { ...loop, state: "PAUSED" as const, checkpointJson: JSON.stringify({ stepCount: loop.stepCount, reason }) };
    this.store.updateAgentLoop(paused);
    this.emit(paused, "agent.loop.paused", { reason });
    return paused;
  }

  /** 取消 Loop，并尽力取消 Provider Turn；取消本身是幂等的。 */
  async cancel(loopId: string, reason: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (isTerminal(loop.state)) return loop;
    this.controllers.get(loopId)?.abort();
    const pending = this.pendingInputs.get(loopId);
    pending?.reject(new Error("AgentLoop input was cancelled"));
    pending?.fail(new Error("AgentLoop input was cancelled"));
    if (loop.providerThreadId && loop.providerTurnId) await this.model.cancel({ conversationId: loop.id, providerThreadId: loop.providerThreadId, providerTurnId: loop.providerTurnId }).catch(() => undefined);
    const cancelled = { ...this.get(loopId), state: "CANCELLED" as const, completedAt: this.store.now(), checkpointJson: JSON.stringify({ reason }) };
    this.store.updateAgentLoop(cancelled);
    this.appendStep(cancelled, "LOOP_COMPLETED", "CANCELLED", { reason });
    this.emit(cancelled, "agent.loop.cancelled", { reason });
    this.resolveWaiter(cancelled);
    return cancelled;
  }

  /** 读取持久化 Loop，不为未知 ID 创建隐式对象。 */
  get(loopId: string): AgentLoop {
    const loop = this.store.getAgentLoop(loopId);
    if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
    return loop;
  }

  private create(input: AgentLoopInput): AgentLoop {
    const loop: AgentLoop = { id: input.id ?? this.store.nextId("agent-loop"), ownerType: input.ownerType, ownerId: input.ownerId, role: input.role, mode: input.mode, state: "CREATED", stepCount: 0, maxSteps: input.maxSteps || this.options.defaultMaxSteps, startedAt: null, completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null };
    this.store.saveAgentLoop(loop);
    return loop;
  }

  private async execute(input: AgentLoopInput, initial: AgentLoop): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(initial.id, controller);
    const capabilities = this.model.capabilities?.(input.role);
    if (input.mode === "factory-controlled" && (!capabilities?.supportsToolCalls || !capabilities.supportedLoopModes.includes(input.mode))) {
      this.block(initial.id, "MODEL_CAPABILITY_UNAVAILABLE");
      return;
    }
    if (input.mode === "provider-controlled" && capabilities && !capabilities.supportedLoopModes.includes(input.mode)) {
      this.block(initial.id, "MODEL_CAPABILITY_UNAVAILABLE");
      return;
    }
    let loop: AgentLoop = { ...initial, state: "RUNNING", startedAt: this.store.now() };
    this.store.updateAgentLoop(loop);
    this.appendStep(loop, "LOOP_RESUMED", "RUNNING", { role: input.role, mode: input.mode });
    this.emit(loop, "agent.loop.started", { role: input.role, mode: input.mode });
    const messages: ModelMessage[] = [...input.modelRequest.messages];
    let fullText = "";
    let continuationPrompt: string | undefined;
    let noProgressSteps = 0;
    const repeatedCalls = new Map<string, number>();
    const startedMs = Date.now();
    const maxDurationMs = input.maxDurationMs ?? this.options.defaultMaxDurationMs;
    const maxRepeatedToolCalls = input.maxRepeatedToolCalls ?? this.options.defaultMaxRepeatedToolCalls;
    const maxNoProgressSteps = input.maxNoProgressSteps ?? this.options.defaultMaxNoProgressSteps;

    // 每一轮只允许一个模型步骤；步骤完成后先过 gate，再决定是否继续上下文压缩。
    // 这保证“模型说完成”不会绕过 Plan/Task 的业务门禁，也为暂停和恢复留下 checkpoint。
    for (;;) {
      loop = this.get(initial.id);
      if (loop.state === "PAUSED") { await this.waitUntilResumed(initial.id, controller.signal); continue; }
      if (loop.state === "CANCELLED") return;
      if (controller.signal.aborted) { await this.cancel(initial.id, "aborted"); return; }
      if (Date.now() - startedMs >= maxDurationMs) { this.block(initial.id, "MAX_DURATION_EXCEEDED"); return; }
      if (loop.stepCount >= loop.maxSteps) { this.block(initial.id, "MAX_STEPS_EXCEEDED"); return; }
      loop = { ...loop, stepCount: loop.stepCount + 1 };
      this.store.updateAgentLoop(loop);
      this.appendStep(loop, "MODEL_STARTED", "RUNNING", { step: loop.stepCount });
      this.emit(loop, "agent.step.started", { step: loop.stepCount });
      let stepText = "";
      let progress = false;
      try {
        for await (const event of this.model.stream({ ...input.modelRequest, role: input.role, messages, providerThreadId: loop.providerThreadId ?? undefined, ...(continuationPrompt ? { continuationPrompt } : {}), signal: controller.signal })) {
          loop = this.get(initial.id);
          if (event.type === "thread.started") { loop = { ...loop, providerThreadId: event.threadId }; this.store.updateAgentLoop(loop); this.emit(loop, "agent.provider.thread.started", { threadId: event.threadId }); }
          if (event.type === "text.delta") {
            stepText += event.text;
            fullText += event.text;
            progress = progress || event.text.trim().length > 0;
            loop = { ...loop, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}) };
            this.store.updateAgentLoop(loop);
            this.appendStep(loop, "MODEL_TEXT_DELTA", "COMPLETED", { text: event.text, ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}) });
            this.emit(loop, "agent.model.text.delta", { text: event.text, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}), ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}) });
          }
          if (event.type === "provider.activity") {
            progress = true;
            loop = { ...loop, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}) };
            this.store.updateAgentLoop(loop);
            this.appendStep(loop, "PROVIDER_ACTIVITY", event.phase === "completed" ? "COMPLETED" : "RUNNING", { phase: event.phase, itemId: event.itemId, itemType: event.itemType, title: event.title, summary: event.summary, providerItemId: event.providerItemId ?? event.itemId, providerControlled: true });
            this.emit(loop, "agent.provider.activity", { phase: event.phase, itemId: event.itemId, itemType: event.itemType, title: event.title, summary: event.summary, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}), ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}) });
          }
          if (event.type === "tool.call") {
            progress = true;
            const signature = `${event.call.tool}:${JSON.stringify(event.call.input)}`;
            const count = (repeatedCalls.get(signature) ?? 0) + 1;
            repeatedCalls.set(signature, count);
            this.appendStep(loop, "TOOL_REQUESTED", count > maxRepeatedToolCalls ? "FAILED" : "RUNNING", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled" });
            this.emit(loop, "agent.tool.requested", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled" });
            if (count > maxRepeatedToolCalls) { this.block(initial.id, "REPEATED_TOOL_CALL"); return; }
            this.emit(loop, "agent.tool.running", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled" });
            if (input.mode === "provider-controlled") continue;
            const runtime = input.toolRuntime ?? this.defaultToolRuntime;
            if (!runtime) { this.block(initial.id, "TOOL_RUNTIME_UNAVAILABLE"); return; }
            const result = await runtime.execute(event.call, { loopId: initial.id, role: input.role, workspacePath: input.workspacePath ?? input.modelRequest.cwd ?? process.cwd() });
            const resultType = result.allowed ? "TOOL_COMPLETED" : result.status === "NEEDS_RECONCILIATION" ? "TOOL_NEEDS_RECONCILIATION" : result.status === "FAILED" ? "TOOL_FAILED" : "TOOL_DENIED";
            const eventType = resultType === "TOOL_COMPLETED" ? "agent.tool.completed" : resultType === "TOOL_NEEDS_RECONCILIATION" ? "agent.tool.needs_reconciliation" : resultType === "TOOL_FAILED" ? "agent.tool.failed" : "agent.tool.denied";
            this.appendStep(loop, resultType, result.allowed ? "COMPLETED" : resultType === "TOOL_DENIED" ? "DENIED" : "FAILED", { callId: event.call.callId, reason: result.reason, result: result.result });
            this.emit(loop, eventType, { callId: event.call.callId, reason: result.reason });
            if (resultType === "TOOL_NEEDS_RECONCILIATION") { this.needsReconciliation(initial.id, result.reason ?? "UNKNOWN_TOOL_RESULT"); return; }
            messages.push({ role: "assistant", content: JSON.stringify({ toolCall: event.call }) }, { role: "tool", content: JSON.stringify(result), toolCallId: event.call.callId });
          }
          if (event.type === "turn.input_required") {
            if (capabilities && !capabilities.supportsStructuredUserInput) { this.block(initial.id, "MODEL_CAPABILITY_UNAVAILABLE"); return; }
            progress = true;
            loop = { ...loop, state: "WAITING_FOR_INPUT", providerThreadId: event.request.threadId, providerTurnId: event.request.turnId, checkpointJson: JSON.stringify({ stepCount: loop.stepCount, providerThreadId: event.request.threadId, providerTurnId: event.request.turnId }) };
            this.store.updateAgentLoop(loop);
            this.appendStep(loop, "INPUT_REQUIRED", "RUNNING", { requestId: event.request.requestId, questions: event.request.questions, isBlocking: event.request.isBlocking });
            this.emit(loop, "agent.input.required", { request: event.request });
            const answers = await this.waitForInput(initial.id, event.request.requestId, controller.signal);
            const pending = this.pendingInputs.get(initial.id);
            try {
              await this.model.answerUserInput({ requestId: event.request.requestId, answers });
              pending?.complete();
            } catch (error) {
              pending?.fail(error instanceof Error ? error : new Error(String(error)));
              throw error;
            } finally {
              this.pendingInputs.delete(initial.id);
            }
            this.appendStep(this.get(initial.id), "INPUT_RESOLVED", "COMPLETED", { requestId: event.request.requestId, answerCount: Object.values(answers).reduce((count, item) => count + item.answers.length, 0) });
            loop = { ...this.get(initial.id), state: "RUNNING" as const };
            this.store.updateAgentLoop(loop);
            this.emit(loop, "agent.input.resolved", { requestId: event.request.requestId });
          }
          if (event.type === "turn.failed") { this.fail(initial.id, event.error); return; }
          if (event.type === "turn.cancelled") { await this.cancel(initial.id, "provider_cancelled"); return; }
          if (event.type === "turn.completed") break;
        }
      } catch (error) {
        if (controller.signal.aborted) { await this.cancel(initial.id, "aborted"); return; }
        this.fail(initial.id, error instanceof Error ? error.message : String(error));
        return;
      }
      loop = this.get(initial.id);
      this.appendStep(loop, "MODEL_COMPLETED", "COMPLETED", { step: loop.stepCount });
      this.emit(loop, "agent.model.completed", { step: loop.stepCount });
      const decision = (input.gate ?? { evaluate: () => ({ action: "complete", reason: "MODEL_COMPLETED" } as GateDecision) }).evaluate({ content: fullText });
      this.appendStep(loop, "GATE_CHECKED", decision.action === "blocked" ? "FAILED" : "COMPLETED", { action: decision.action, reason: decision.reason });
      this.emit(loop, "agent.gate.checked", decision);
      if (decision.action === "complete") { this.complete(initial.id, decision.reason); return; }
      if (decision.action === "blocked") { this.block(initial.id, decision.reason); return; }
      if (progress) noProgressSteps = 0; else noProgressSteps += 1;
      if (noProgressSteps >= maxNoProgressSteps) { this.block(initial.id, "NO_PROGRESS"); return; }
      if (stepText.trim()) messages.push({ role: "assistant", content: stepText });
      continuationPrompt = `继续完善当前${input.role === "explorer" ? "计划" : "执行任务"}。不要重新开始已经完成的工作，只处理下一项必要内容。`;
      messages.push({ role: "user", content: continuationPrompt });
      loop = { ...this.get(initial.id), checkpointJson: JSON.stringify({ stepCount: loop.stepCount, providerThreadId: loop.providerThreadId, messageCount: messages.length, lastText: stepText.slice(-1000) }) };
      this.store.updateAgentLoop(loop);
      this.appendStep(loop, "CONTEXT_COMPACTED", "COMPLETED", { messageCount: messages.length });
      this.emit(loop, "agent.context.compacted", { messageCount: messages.length });
    }
  }

  private waitForInput(loopId: string, requestId: string | number, signal: AbortSignal): Promise<Record<string, { answers: string[] }>> {
    return new Promise((resolve, reject) => {
      let complete!: () => void;
      let fail!: (error: Error) => void;
      const completion = new Promise<void>((resolveCompletion, rejectCompletion) => { complete = resolveCompletion; fail = rejectCompletion; });
      const onAbort = () => {
        this.pendingInputs.delete(loopId);
        const error = new Error("AgentLoop input was cancelled");
        reject(error);
        // 上方已经拒绝输入 Promise；这里仍需完成辅助 Promise，避免没有答案请求
        // 在途时因取消产生未处理的 rejection。
        complete();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingInputs.set(loopId, {
        requestId,
        completion,
        complete,
        fail,
        reject,
        resolve: (answers) => { signal.removeEventListener("abort", onAbort); resolve(answers); },
      });
    });
  }

  private waitUntilResumed(loopId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setInterval(() => { if (signal.aborted || this.get(loopId).state !== "PAUSED") { clearInterval(timer); resolve(); } }, 20);
    });
  }

  private createWaiter(loopId: string): void {
    if (this.waiters.has(loopId)) return;
    this.waiters.set(loopId, new Promise((resolve) => this.resolveWaiters.set(loopId, resolve)));
  }

  private resolveWaiter(loop: AgentLoop): void { this.resolveWaiters.get(loop.id)?.(loop); this.resolveWaiters.delete(loop.id); }

  private appendStep(loop: AgentLoop, stepType: AgentStepType, status: AgentLoopStepStatus, payload: Record<string, unknown>): void {
    const step = this.store.appendAgentLoopStep({ loopId: loop.id, stepType, status, callId: typeof payload.callId === "string" ? payload.callId : null, providerThreadId: loop.providerThreadId, providerTurnId: loop.providerTurnId, payload });
    this.emit(loop, `agent.step.${stepType.toLowerCase()}`, { ...payload, sequence: step.sequence });
  }

  private emit(loop: AgentLoop, type: string, payload: Record<string, unknown>): void {
    const event: AgentLoopEvent = { loopId: loop.id, type, sequence: this.store.listAgentLoopSteps(loop.id).length, payload };
    this.callbacks.get(loop.id)?.(event);
    this.listeners.get(loop.id)?.forEach((listener) => listener(event));
    this.store.appendEvent({ type: type as import("./index.js").DomainEvent["type"], aggregateId: loop.id, payload });
  }

  private complete(loopId: string, reason: string): void { const loop = { ...this.get(loopId), state: "COMPLETED" as const, completedAt: this.store.now() }; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_COMPLETED", "COMPLETED", { reason }); this.emit(loop, "agent.loop.completed", { reason }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); }
  private block(loopId: string, reason: string): void { const loop = { ...this.get(loopId), state: "BLOCKED" as const, completedAt: this.store.now(), checkpointJson: JSON.stringify({ reason }) }; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_FAILED", "FAILED", { reason }); this.emit(loop, "agent.loop.failed", { reason }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); }
  private fail(loopId: string, error: string): void { const loop = { ...this.get(loopId), state: "FAILED" as const, completedAt: this.store.now(), checkpointJson: JSON.stringify({ error }) }; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_FAILED", "FAILED", { error }); this.emit(loop, "agent.loop.failed", { error }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); }
  private needsReconciliation(loopId: string, reason: string): void { const loop = { ...this.get(loopId), state: "NEEDS_RECONCILIATION" as const, completedAt: this.store.now(), checkpointJson: JSON.stringify({ reason }) }; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_FAILED", "NEEDS_RECONCILIATION", { reason }); this.emit(loop, "agent.loop.recovery_required", { reason }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); }
}

function isTerminal(state: AgentLoopState): boolean {
  return state === "BLOCKED" || state === "COMPLETED" || state === "FAILED" || state === "CANCELLED" || state === "NEEDS_RECONCILIATION";
}

export interface AgentLoopRunner {
  /** 启动并返回可观察的 Loop 聚合。 */
  start(input: AgentLoopInput): Promise<AgentLoop>;
  /** 从已持久化 checkpoint 恢复 Loop。 */
  resume(loopId: string): Promise<AgentLoop>;
  /** 暂停仍可继续的 Loop，并记录暂停原因。 */
  pause(loopId: string, reason: string): Promise<AgentLoop>;
  /** 取消 Loop 和外部 Provider turn。 */
  cancel(loopId: string, reason: string): Promise<AgentLoop>;
  /** 读取 Loop 当前持久化状态。 */
  get(loopId: string): AgentLoop;
}
