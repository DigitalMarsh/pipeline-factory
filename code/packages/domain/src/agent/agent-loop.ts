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
  | "MODEL_USAGE"
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
  ownerType: "explorer-turn" | "project-execution-turn" | "run";
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

export type AgentLoopDiagnostics = {
  providerActivityCount: number;
  lastGate: { action: string; reason: string } | null;
  terminal: { code: string; message: string } | null;
};

const TERMINAL_DIAGNOSTIC_MESSAGES: Record<string, string> = {
  DATABASE_BUSY: "数据库写入暂时繁忙",
  BLOCKED: "Agent Loop 已安全阻止",
  CANCELLED: "本轮已取消",
  MAX_STEPS_EXCEEDED: "已达到 Provider Turn 上限",
  MAX_DURATION_EXCEEDED: "已超过 Agent Loop 时间上限",
  PROVIDER_COMMAND_TIMEOUT: "Provider 命令在规定时间内未完成",
  NO_PROGRESS: "连续多个 Provider Turn 没有产生有效进展",
  MODEL_CAPABILITY_UNAVAILABLE: "当前模型不支持此 Agent Loop 能力",
  REPEATED_TOOL_CALL: "检测到重复工具调用，已安全停止",
  TOOL_RUNTIME_UNAVAILABLE: "工具运行时不可用",
  PROVIDER_TURN_NOT_ACTIVE: "服务重启后原 Provider Turn 已不可恢复",
  STRUCTURED_INPUT_RECOVERY_REQUIRED: "服务重启后需要重新提交结构化输入",
  EXPLORER_TURN_RECOVERY_REQUIRED: "服务重启后需要重新开始探索",
  UNKNOWN_TOOL_RESULT: "工具副作用结果未知，需要人工核对",
};

function diagnosticCode(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (/database is locked|SQLITE_BUSY/i.test(text)) return "DATABASE_BUSY";
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(text) ? text : "LOOP_FAILED";
}

function diagnosticMessage(code: string): string {
  return TERMINAL_DIAGNOSTIC_MESSAGES[code] ?? "Agent Loop 执行失败";
}

/**
 * 本投影只读取这三类步骤。文本增量（MODEL_TEXT_DELTA）占步骤总数 95% 以上且对诊断毫无贡献，
 * 调用方应把它传给 Store 以跳过其余行；新增诊断维度时必须同步维护这里。
 */
export const AGENT_LOOP_DIAGNOSTIC_STEP_TYPES = ["PROVIDER_ACTIVITY", "GATE_CHECKED", "LOOP_FAILED"] as const;

export function projectAgentLoopDiagnostics(loop: AgentLoop, steps: AgentLoopStep[]): AgentLoopDiagnostics {
  const providerItems = new Set<string>();
  for (const step of steps) {
    if (step.stepType !== "PROVIDER_ACTIVITY") continue;
    const itemId = typeof step.payload.providerItemId === "string"
      ? step.payload.providerItemId
      : typeof step.payload.itemId === "string" ? step.payload.itemId : `${step.providerThreadId ?? "unknown"}:${step.providerTurnId ?? "unknown"}:${step.sequence}`;
    providerItems.add(itemId);
  }
  const gateStep = [...steps].reverse().find((step) => step.stepType === "GATE_CHECKED");
  const lastGate = gateStep && typeof gateStep.payload.action === "string" && typeof gateStep.payload.reason === "string"
    ? { action: gateStep.payload.action, reason: gateStep.payload.reason }
    : null;
  if (loop.state === "COMPLETED") return { providerActivityCount: providerItems.size, lastGate, terminal: null };
  if (!isTerminal(loop.state)) return { providerActivityCount: providerItems.size, lastGate, terminal: null };
  let checkpoint: Record<string, unknown> = {};
  if (loop.checkpointJson) {
    try {
      const parsed: unknown = JSON.parse(loop.checkpointJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) checkpoint = parsed as Record<string, unknown>;
    } catch { /* malformed checkpoints are intentionally not exposed */ }
  }
  const terminalValue = checkpoint.error ?? checkpoint.reason ?? [...steps].reverse().find((step) => step.stepType === "LOOP_FAILED")?.payload.error ?? [...steps].reverse().find((step) => step.stepType === "LOOP_FAILED")?.payload.reason;
  const code = diagnosticCode(terminalValue ?? loop.state);
  return { providerActivityCount: providerItems.size, lastGate, terminal: { code, message: diagnosticMessage(code) } };
}

import type { ModelEvent, ModelGateway, ModelMessage, ModelRequest, ModelRole, ToolCall } from "../index.js";
import type { PipelineStore } from "../index.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";

/** 启动 Loop 所需的角色、循环限制、模型请求和可选工具/门禁。 */
export type AgentLoopInput = {
  id?: string;
  ownerType: AgentLoop["ownerType"];
  ownerId: string;
  role: AgentLoop["role"];
  mode: AgentLoopMode;
  maxSteps: number;
  maxDurationMs?: number;
  /** Delegated provider shell commands must finish within this duration. */
  providerCommandTimeoutMs?: number;
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
  | { action: "continue"; reason: string; continuationPrompt?: string; diagnostics?: unknown[] | undefined }
  | { action: "suspend"; reason: string; diagnostics?: unknown[] | undefined }
  | { action: "complete"; reason: string; diagnostics?: unknown[] | undefined }
  | { action: "blocked"; reason: string; diagnostics?: unknown[] | undefined };

/** 门禁可见的模型输出和执行事实，不直接暴露 Store 给策略实现。 */
export type GateContext = {
  content?: string;
  reportReady?: boolean;
  allTasksComplete?: boolean;
  hasOpenToolCalls?: boolean;
  hasPendingChangeProposal?: boolean;
  changedPaths?: string[];
  reportError?: string;
  scopeError?: string;
  pathsWithinScope?: boolean;
};

export interface TerminationGate {
  /** 根据当前模型输出和运行上下文决定继续、暂停、完成或阻塞。 */
  evaluate(context: GateContext): GateDecision | Promise<GateDecision>;
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
 * 流式文本的合并落库阈值（字符）。Provider 按 token 推送增量，逐条落库会把一次回复
 * 放大成上万条步骤与事件；按字符阈值合并后落库量降低两个数量级，同时仍保持增量可见。
 * 前端的流式渲染本身有 150ms 节流，因此更细的粒度不会带来更快的观感。
 */
const TEXT_DELTA_FLUSH_CHARS = 160;

/**
 * 流式文本的最长缓冲时间（毫秒）。低速率输出下字符阈值可能长时间达不到，
 * 定时刷新保证用户仍能看到持续增长的文本，而不是等整个步骤结束才一次出现。
 */
const TEXT_DELTA_FLUSH_INTERVAL_MS = 40;

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
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly providerCommandTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private readonly callbacks = new Map<string, (event: AgentLoopEvent) => void>();
  private readonly stepSequences = new Map<string, number>();
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

  /** 只恢复仍由当前进程持有执行协程的 PAUSED Loop，不重放已经完成的步骤。 */
  async resume(loopId: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (loop.state !== "PAUSED") throw new Error(`AgentLoop ${loopId} cannot be resumed from ${loop.state}`);
    if (!this.controllers.has(loopId)) throw new Error(`AgentLoop ${loopId} cannot be resumed without a live execution coroutine`);
    const resumed = { ...loop, state: "RUNNING" as const };
    this.store.updateAgentLoop(resumed);
    this.emit(resumed, "agent.loop.resumed", { loopId });
    return resumed;
  }

  /** 仅允许仍在执行的 Loop 写入 checkpoint 后暂停。 */
  async pause(loopId: string, reason: string): Promise<AgentLoop> {
    const loop = this.get(loopId);
    if (loop.state !== "RUNNING") throw new Error(`AgentLoop ${loopId} cannot be paused from ${loop.state}`);
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
    this.clearProviderCommandTimeouts(loopId);
    const pending = this.pendingInputs.get(loopId);
    pending?.reject(new Error("AgentLoop input was cancelled"));
    pending?.fail(new Error("AgentLoop input was cancelled"));
    if (loop.providerThreadId && loop.providerTurnId) await this.model.cancel({ conversationId: loop.id, providerThreadId: loop.providerThreadId, providerTurnId: loop.providerTurnId }).catch(() => undefined);
    const cancelled = { ...this.get(loopId), state: "CANCELLED" as const, completedAt: this.store.now(), checkpointJson: JSON.stringify({ reason }) };
    const durationMs = cancelled.startedAt ? Math.max(0, Date.now() - Date.parse(cancelled.startedAt)) : null;
    this.store.updateAgentLoop(cancelled);
    this.appendStep(cancelled, "LOOP_COMPLETED", "CANCELLED", { reason, completedAt: cancelled.completedAt, durationMs });
    this.emit(cancelled, "agent.loop.cancelled", { reason, completedAt: cancelled.completedAt, durationMs });
    this.resolveWaiter(cancelled);
    this.controllers.delete(loopId);
    this.callbacks.delete(loopId);
    this.stepSequences.delete(loopId);
    return cancelled;
  }

  /** 读取持久化 Loop，不为未知 ID 创建隐式对象。 */
  get(loopId: string): AgentLoop {
    const loop = this.store.getAgentLoop(loopId);
    if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
    return loop;
  }

  private create(input: AgentLoopInput): AgentLoop {
    if (input.id && this.store.getAgentLoop(input.id)) throw new Error(`AgentLoop ${input.id} already exists`);
    const loop: AgentLoop = { id: input.id ?? this.store.nextId("agent-loop"), ownerType: input.ownerType, ownerId: input.ownerId, role: input.role, mode: input.mode, state: "CREATED", stepCount: 0, maxSteps: input.maxSteps || this.options.defaultMaxSteps, startedAt: null, completedAt: null, providerThreadId: input.modelRequest.providerThreadId ?? null, providerTurnId: null, checkpointJson: null };
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
    const effectiveModelConfig = { ...this.model.configFor(input.role), ...(input.modelRequest.modelConfig ?? {}) };
    // 端点指纹随 Loop 起点一起落库：Run 事后能回答"这次请求实际打到了哪里、谁担保这个端点"。
    // 组合根没提供 describeEndpoint 时记 null，而不是编一个默认后端名。
    this.emit(loop, "agent.loop.started", { role: input.role, mode: input.mode, model: effectiveModelConfig.model, reasoningEffort: effectiveModelConfig.reasoningEffort ?? null, provider: this.model.describeEndpoint?.() ?? null, startedAt: loop.startedAt });
    const messages: ModelMessage[] = [...input.modelRequest.messages];
    let fullText = "";
    let continuationPrompt: string | undefined;
    let noProgressSteps = 0;
    const repeatedCalls = new Map<string, number>();
    const startedMs = Date.now();
    const maxDurationMs = input.maxDurationMs ?? this.options.defaultMaxDurationMs;
    const maxRepeatedToolCalls = input.maxRepeatedToolCalls ?? this.options.defaultMaxRepeatedToolCalls;
    const maxNoProgressSteps = input.maxNoProgressSteps ?? this.options.defaultMaxNoProgressSteps;
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const current = this.get(initial.id);
      if (current.providerThreadId && current.providerTurnId) {
        void this.model.cancel({ conversationId: current.id, providerThreadId: current.providerThreadId, providerTurnId: current.providerTurnId }).catch(() => undefined);
      }
    }, maxDurationMs);
    this.deadlineTimers.set(initial.id, deadlineTimer);

    // 流式文本缓冲区跨步骤保留，按字符阈值、定时器、输出项变化、其他事件插入或步骤结束时落库。
    let deltaBuffer = "";
    let deltaItemId: string | null = null;
    let deltaThreadId: string | null = null;
    let deltaTurnId: string | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDeltaTimer = (): void => { if (deltaTimer !== null) { clearTimeout(deltaTimer); deltaTimer = null; } };
    const flushTextDelta = (current: AgentLoop): void => {
      clearDeltaTimer();
      if (!deltaBuffer) return;
      const text = deltaBuffer;
      deltaBuffer = "";
      // appendStep 已经把这段文本落进 agent_loop_steps，并同时发出 agent.step.model_text_delta 事件。
      // 下面这次派发只为把**带 providerThreadId/providerTurnId** 的增量送给进程内消费者
      // （thread-service 靠它累积 turn 正文），不再往事件表里存第二份同样的 text。
      this.appendStep(current, "MODEL_TEXT_DELTA", "COMPLETED", { text, ...(deltaItemId ? { providerItemId: deltaItemId } : {}) });
      this.emit(current, "agent.model.text.delta", { text, ...(deltaThreadId ? { providerThreadId: deltaThreadId } : {}), ...(deltaTurnId ? { providerTurnId: deltaTurnId } : {}), ...(deltaItemId ? { providerItemId: deltaItemId } : {}) }, { durable: false });
    };
    // 低速率输出时字符阈值可能迟迟达不到；定时刷新保证文本仍能即时可见，而不是等步骤结束才出现。
    const scheduleDeltaFlush = (): void => {
      if (deltaTimer !== null) return;
      deltaTimer = setTimeout(() => {
        deltaTimer = null;
        const current = this.store.getAgentLoop(initial.id);
        if (!current || isTerminal(current.state)) return;
        flushTextDelta(current);
      }, TEXT_DELTA_FLUSH_INTERVAL_MS);
    };

    // 每一轮只允许一个模型步骤；步骤完成后先过 gate，再决定是否继续上下文压缩。
    // 这保证“模型说完成”不会绕过 Plan/Task 的业务门禁，也为暂停和恢复留下 checkpoint。
    try {
      for (;;) {
        loop = this.get(initial.id);
        if (timedOut) { this.block(initial.id, "MAX_DURATION_EXCEEDED"); return; }
        if (loop.state === "PAUSED") { await this.waitUntilResumed(initial.id, controller.signal); continue; }
        if (loop.state === "CANCELLED") return;
        if (controller.signal.aborted) { await this.cancel(initial.id, "aborted"); return; }
        if (Date.now() - startedMs >= maxDurationMs) { this.block(initial.id, "MAX_DURATION_EXCEEDED"); return; }
        if (loop.stepCount >= loop.maxSteps) { this.block(initial.id, "MAX_STEPS_EXCEEDED"); return; }
        loop = { ...loop, stepCount: loop.stepCount + 1 };
        this.store.updateAgentLoop(loop);
        this.appendStep(loop, "MODEL_STARTED", "RUNNING", { step: loop.stepCount });
        this.emit(loop, "agent.step.started", { step: loop.stepCount, ...(loop.providerThreadId ? { providerThreadId: loop.providerThreadId } : {}), ...(loop.providerTurnId ? { providerTurnId: loop.providerTurnId } : {}) });
        let stepText = "";
        let progress = false;
        try {
          for await (const event of this.model.stream({ ...input.modelRequest, role: input.role, messages, providerThreadId: loop.providerThreadId ?? undefined, ...(continuationPrompt ? { continuationPrompt } : {}), signal: controller.signal })) {
            loop = this.get(initial.id);
            // 任何非文本事件都必须排在已缓冲文本之后，否则时间线上的文本与工具/用量事件会换序。
            if (event.type !== "text.delta") flushTextDelta(loop);
            if (isTerminal(loop.state)) return;
            if (event.type === "thread.started") { loop = { ...loop, providerThreadId: event.threadId }; this.store.updateAgentLoop(loop); this.emit(loop, "agent.provider.thread.started", { threadId: event.threadId, ...(event.endpoint ? { provider: event.endpoint } : {}) }); }
            if (event.type === "text.delta") {
              stepText += event.text;
              fullText += event.text;
              progress = progress || event.text.trim().length > 0;
              const nextThreadId = event.providerThreadId ?? loop.providerThreadId;
              const nextTurnId = event.providerTurnId ?? loop.providerTurnId;
              if (nextThreadId !== loop.providerThreadId || nextTurnId !== loop.providerTurnId) {
                loop = { ...loop, providerThreadId: nextThreadId, providerTurnId: nextTurnId };
                this.store.updateAgentLoop(loop);
              }
              const itemId = event.providerItemId ?? null;
              // 同一回合内 Provider 可以切换输出项；切换时先落库，保持步骤与输出项的对应关系。
              if (deltaBuffer && itemId !== deltaItemId) flushTextDelta(loop);
              deltaBuffer += event.text;
              deltaItemId = itemId;
              deltaThreadId = nextThreadId;
              deltaTurnId = nextTurnId;
              if (deltaBuffer.length >= TEXT_DELTA_FLUSH_CHARS) flushTextDelta(loop);
              else scheduleDeltaFlush();
            }
            if (event.type === "provider.activity") {
              progress = true;
              loop = { ...loop, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}) };
              this.store.updateAgentLoop(loop);
              if (event.itemType === "commandExecution") {
                if (event.phase === "completed") this.clearProviderCommandTimeout(initial.id, event.itemId);
                else if (input.providerCommandTimeoutMs !== undefined) this.startProviderCommandTimeout(initial.id, event.itemId, input.providerCommandTimeoutMs, input.modelRequest.cwd ?? process.cwd(), controller);
              }
              const commandContext = event.itemType === "commandExecution"
                ? { cwd: input.modelRequest.cwd ?? process.cwd(), timeoutMs: input.providerCommandTimeoutMs ?? null }
                : {};
              this.appendStep(loop, "PROVIDER_ACTIVITY", event.phase === "completed" ? "COMPLETED" : "RUNNING", { phase: event.phase, itemId: event.itemId, itemType: event.itemType, title: event.title, summary: event.summary, ...commandContext, providerItemId: event.providerItemId ?? event.itemId, providerControlled: true });
              this.emit(loop, "agent.provider.activity", { phase: event.phase, itemId: event.itemId, itemType: event.itemType, title: event.title, summary: event.summary, ...commandContext, ...(event.toolName ? { toolName: event.toolName } : {}), ...(event.serverName ? { serverName: event.serverName } : {}), ...(event.status ? { status: event.status } : {}), ...(event.error ? { error: event.error } : {}), ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}), ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}) });
            }
            if (event.type === "model.usage") {
              loop = { ...loop, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}) };
              this.store.updateAgentLoop(loop);
              this.appendStep(loop, "MODEL_USAGE", "COMPLETED", { ...event.usage, scope: event.scope });
              this.emit(loop, "agent.model.usage", { ...event.usage, scope: event.scope, ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}), ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}) });
            }
            if (event.type === "tool.call") {
              progress = true;
              const signature = `${event.call.tool}:${JSON.stringify(event.call.input)}`;
              const count = (repeatedCalls.get(signature) ?? 0) + 1;
              repeatedCalls.set(signature, count);
              this.appendStep(loop, "TOOL_REQUESTED", count > maxRepeatedToolCalls ? "FAILED" : "RUNNING", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled" });
              this.emit(loop, "agent.tool.requested", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled", ...(loop.providerThreadId ? { providerThreadId: loop.providerThreadId } : {}), ...(loop.providerTurnId ? { providerTurnId: loop.providerTurnId } : {}) });
              if (count > maxRepeatedToolCalls) { this.block(initial.id, "REPEATED_TOOL_CALL"); return; }
              this.emit(loop, "agent.tool.running", { callId: event.call.callId, tool: event.call.tool, delegatedToProvider: input.mode === "provider-controlled" });
              if (input.mode === "provider-controlled") continue;
              const runtime = input.toolRuntime ?? this.defaultToolRuntime;
              if (!runtime) { this.block(initial.id, "TOOL_RUNTIME_UNAVAILABLE"); return; }
              const result = await runtime.execute(event.call, { loopId: initial.id, role: input.role, workspacePath: input.workspacePath ?? input.modelRequest.cwd ?? process.cwd() });
              const resultType = result.allowed ? "TOOL_COMPLETED" : result.status === "NEEDS_RECONCILIATION" ? "TOOL_NEEDS_RECONCILIATION" : result.status === "FAILED" ? "TOOL_FAILED" : "TOOL_DENIED";
              const eventType = resultType === "TOOL_COMPLETED" ? "agent.tool.completed" : resultType === "TOOL_NEEDS_RECONCILIATION" ? "agent.tool.needs_reconciliation" : resultType === "TOOL_FAILED" ? "agent.tool.failed" : "agent.tool.denied";
              this.appendStep(loop, resultType, result.allowed ? "COMPLETED" : resultType === "TOOL_DENIED" ? "DENIED" : "FAILED", { callId: event.call.callId, reason: result.reason, result: result.result });
              this.emit(loop, eventType, { callId: event.call.callId, tool: event.call.tool, reason: result.reason, ...(loop.providerThreadId ? { providerThreadId: loop.providerThreadId } : {}), ...(loop.providerTurnId ? { providerTurnId: loop.providerTurnId } : {}) });
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
            if (event.type === "turn.cancelled") { if (timedOut) this.block(initial.id, "MAX_DURATION_EXCEEDED"); else await this.cancel(initial.id, "provider_cancelled"); return; }
            if (event.type === "turn.completed") break;
          }
        } catch (error) {
          // 失败/取消前先落库已缓冲的文本，避免用户看到被截断的回复。
          flushTextDelta(loop);
          if (timedOut) { this.block(initial.id, "MAX_DURATION_EXCEEDED"); return; }
          if (controller.signal.aborted) { await this.cancel(initial.id, "aborted"); return; }
          this.fail(initial.id, error instanceof Error ? error.message : String(error));
          return;
        }
        loop = this.get(initial.id);
        if (isTerminal(loop.state)) return;
        flushTextDelta(loop);
        if (timedOut || Date.now() - startedMs >= maxDurationMs) { this.block(initial.id, "MAX_DURATION_EXCEEDED"); return; }
        this.appendStep(loop, "MODEL_COMPLETED", "COMPLETED", { step: loop.stepCount });
        this.emit(loop, "agent.model.completed", { step: loop.stepCount, ...(loop.providerThreadId ? { providerThreadId: loop.providerThreadId } : {}), ...(loop.providerTurnId ? { providerTurnId: loop.providerTurnId } : {}) });
        let decision: GateDecision;
        try {
          decision = await (input.gate ?? { evaluate: () => ({ action: "complete", reason: "MODEL_COMPLETED" } as GateDecision) }).evaluate({ content: fullText });
        } catch (error) {
          this.fail(initial.id, error instanceof Error ? error.message : String(error));
          return;
        }
        this.appendStep(loop, "GATE_CHECKED", decision.action === "blocked" ? "FAILED" : "COMPLETED", { action: decision.action, reason: decision.reason, ...(decision.diagnostics?.length ? { diagnostics: decision.diagnostics } : {}), ...(decision.action === "continue" && decision.continuationPrompt ? { continuationPrompt: decision.continuationPrompt } : {}) });
        this.emit(loop, "agent.gate.checked", decision);
        if (decision.action === "complete") { this.complete(initial.id, decision.reason); return; }
        if (decision.action === "blocked") { this.block(initial.id, decision.reason); return; }
        if (progress) noProgressSteps = 0; else noProgressSteps += 1;
        if (noProgressSteps >= maxNoProgressSteps) { this.block(initial.id, "NO_PROGRESS"); return; }
        if (stepText.trim()) messages.push({ role: "assistant", content: stepText });
        const gateContinuationPrompt = decision.action === "continue" ? decision.continuationPrompt : undefined;
        continuationPrompt = gateContinuationPrompt ?? `继续完善当前${input.role === "explorer" ? "计划" : "执行任务"}。不要重新开始已经完成的工作，只处理下一项必要内容。`;
        messages.push({ role: "user", content: continuationPrompt });
        loop = { ...this.get(initial.id), checkpointJson: JSON.stringify({ stepCount: loop.stepCount, providerThreadId: loop.providerThreadId, messageCount: messages.length, lastText: stepText.slice(-1000) }) };
        this.store.updateAgentLoop(loop);
        this.appendStep(loop, "CONTEXT_COMPACTED", "COMPLETED", { messageCount: messages.length });
        this.emit(loop, "agent.context.compacted", { messageCount: messages.length });
      }
    } finally {
      // 任何退出路径都不能留下未清理的定时器。
      clearDeltaTimer();
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
    this.stepSequences.set(loop.id, step.sequence);
    this.emit(loop, `agent.step.${stepType.toLowerCase()}`, { ...payload, sequence: step.sequence });
  }

  /**
   * Loop 当前的步骤序号。步骤序号从 1 连续递增，因此“最后一条步骤的序号”就是步骤总数。
   * 首次访问从 Store 播种，之后由 appendStep 维护，避免每个事件都读取整张步骤表。
   */
  private currentStepSequence(loopId: string): number {
    const cached = this.stepSequences.get(loopId);
    if (cached !== undefined) return cached;
    const seeded = this.store.getLastAgentLoopStepSequence(loopId);
    this.stepSequences.set(loopId, seeded);
    return seeded;
  }

  private emit(loop: AgentLoop, type: string, payload: Record<string, unknown>, options: { durable?: boolean } = {}): void {
    const event: AgentLoopEvent = { loopId: loop.id, type, sequence: this.currentStepSequence(loop.id), payload };
    this.callbacks.get(loop.id)?.(event);
    this.listeners.get(loop.id)?.forEach((listener) => listener(event));
    // durable:false 用于"同一份事实已经以步骤形式落库"的事件，避免同一次模型增量在事件表里存两份。
    // **进程内派发必须保留**——Explorer 的实时文本链路（thread-service 的 callback）靠它。
    // 只跳过 appendEvent，调用方读到的事件内容与顺序完全不变。
    if (options.durable === false) return;
    this.store.appendEvent({ type: type as import("../index.js").DomainEvent["type"], aggregateId: loop.id, payload });
  }

  private clearDeadline(loopId: string): void { const timer = this.deadlineTimers.get(loopId); if (timer) clearTimeout(timer); this.deadlineTimers.delete(loopId); }
  private clearProviderCommandTimeout(loopId: string, itemId: string): void {
    const timers = this.providerCommandTimers.get(loopId);
    const timer = timers?.get(itemId);
    if (timer) clearTimeout(timer);
    timers?.delete(itemId);
    if (timers?.size === 0) this.providerCommandTimers.delete(loopId);
  }
  private clearProviderCommandTimeouts(loopId: string): void {
    const timers = this.providerCommandTimers.get(loopId);
    if (timers) for (const timer of timers.values()) clearTimeout(timer);
    this.providerCommandTimers.delete(loopId);
  }
  private startProviderCommandTimeout(loopId: string, itemId: string, timeoutMs: number, cwd: string, controller: AbortController): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !itemId) return;
    this.clearProviderCommandTimeout(loopId, itemId);
    const timers = this.providerCommandTimers.get(loopId) ?? new Map<string, ReturnType<typeof setTimeout>>();
    const timer = setTimeout(() => {
      const current = this.get(loopId);
      if (isTerminal(current.state)) return;
      this.block(loopId, "PROVIDER_COMMAND_TIMEOUT", { itemId, itemType: "commandExecution", timeoutMs, cwd });
      controller.abort();
      if (current.providerThreadId && current.providerTurnId) {
        void this.model.cancel({ conversationId: current.id, providerThreadId: current.providerThreadId, providerTurnId: current.providerTurnId }).catch(() => undefined);
      }
    }, timeoutMs);
    timers.set(itemId, timer);
    this.providerCommandTimers.set(loopId, timers);
  }
  private complete(loopId: string, reason: string): void { this.clearDeadline(loopId); this.clearProviderCommandTimeouts(loopId); const completedAt = this.store.now(); const loop = { ...this.get(loopId), state: "COMPLETED" as const, completedAt }; const durationMs = loop.startedAt ? Math.max(0, Date.now() - Date.parse(loop.startedAt)) : null; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_COMPLETED", "COMPLETED", { reason, completedAt, durationMs }); this.emit(loop, "agent.loop.completed", { reason, completedAt, durationMs }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); this.stepSequences.delete(loopId); }
  private block(loopId: string, reason: string, details: Record<string, unknown> = {}): void { this.clearDeadline(loopId); this.clearProviderCommandTimeouts(loopId); const completedAt = this.store.now(); const loop = { ...this.get(loopId), state: "BLOCKED" as const, completedAt, checkpointJson: JSON.stringify({ reason, ...details }) }; const durationMs = loop.startedAt ? Math.max(0, Date.now() - Date.parse(loop.startedAt)) : null; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_FAILED", "FAILED", { reason, ...details, completedAt, durationMs }); this.emit(loop, "agent.loop.failed", { reason, ...details, completedAt, durationMs }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); this.stepSequences.delete(loopId); }
  private fail(loopId: string, error: string): void {
    this.clearDeadline(loopId);
    this.clearProviderCommandTimeouts(loopId);
    const code = diagnosticCode(error);
    const persistedError = code === "DATABASE_BUSY" ? code : error;
    const completedAt = this.store.now();
    const loop = { ...this.get(loopId), state: "FAILED" as const, completedAt, checkpointJson: JSON.stringify({ error: persistedError, detail: error }) };
    const durationMs = loop.startedAt ? Math.max(0, Date.now() - Date.parse(loop.startedAt)) : null;
    this.store.updateAgentLoop(loop);
    this.appendStep(loop, "LOOP_FAILED", "FAILED", { error: persistedError, completedAt, durationMs });
    this.emit(loop, "agent.loop.failed", { error: persistedError, completedAt, durationMs });
    this.resolveWaiter(loop);
    this.controllers.delete(loopId);
    this.callbacks.delete(loopId);
    this.stepSequences.delete(loopId);
  }
  private needsReconciliation(loopId: string, reason: string): void { this.clearDeadline(loopId); this.clearProviderCommandTimeouts(loopId); const completedAt = this.store.now(); const loop = { ...this.get(loopId), state: "NEEDS_RECONCILIATION" as const, completedAt, checkpointJson: JSON.stringify({ reason }) }; const durationMs = loop.startedAt ? Math.max(0, Date.now() - Date.parse(loop.startedAt)) : null; this.store.updateAgentLoop(loop); this.appendStep(loop, "LOOP_FAILED", "NEEDS_RECONCILIATION", { reason, completedAt, durationMs }); this.emit(loop, "agent.loop.recovery_required", { reason, completedAt, durationMs }); this.resolveWaiter(loop); this.controllers.delete(loopId); this.callbacks.delete(loopId); this.stepSequences.delete(loopId); }
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
