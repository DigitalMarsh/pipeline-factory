/**
 * 项目级固定执行会话：独立于 Explorer Plan / Run，持续复用 Provider thread，
 * 并将消息、逐轮配置和可回放进度写入 PipelineStore。
 */
import { AgentLoopEngine, type AgentLoopEvent } from "./agent-loop.js";
import type {
  ModelGateway,
  ModelMessage,
  ModelRoleConfig,
  PipelineStore,
  Project,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  ProjectExecutionTurnStatus,
} from "../index.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";

export const PROJECT_EXECUTION_MODELS = [
  "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
] as const;
export const PROJECT_EXECUTION_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ProjectExecutionThreadSnapshot = {
  thread: ProjectExecutionThread;
  messages: ProjectExecutionMessage[];
  lastEventSequence: number;
  defaultModel: string;
  defaultReasoningEffort: string | null;
  modelOptions: string[];
  reasoningEffortOptions: Array<{ value: string | null; label: string }>;
  /**
   * 这个会话的 executor 实际由哪个 agent（后端 id）驱动。**是展示事实，不是可覆盖项**：
   * 覆盖 backend 属于 Project 级决定（settings.models.executor.backend），不该从一个会话面板改。
   */
  backend: string;
};

export type ProjectExecutionThreadServiceOptions = {
  maxSteps?: number;
  maxDurationMs?: number;
  maxRepeatedToolCalls?: number;
  maxNoProgressSteps?: number;
  providerCommandTimeoutMs?: number;
  toolRuntimeForProject?: (project: Project) => ToolRuntime | undefined;
  /**
   * 这个项目的执行会话可选的模型与推理强度；由组合根按该项目的 **executor 后端**提供。
   * 缺省时退回内置清单（`PROJECT_EXECUTION_MODELS` / `PROJECT_EXECUTION_REASONING_EFFORTS`）。
   *
   * 为什么必须由外部提供：模型名与推理强度是 provider 事实，跨后端不通用（Claude 侧只认 5 档
   * effort）。缺省清单的意义只是"没有目录信息时仍然能用"，不是权威取值。
   * **给的清单要与 `updatePreferences` 的校验同源**（这里给的正是校验用的那一份），
   * 否则会出现"下拉里有、选了却被拒"的死路。
   */
  modelCatalogForProject?: (project: Project) => { models: string[]; reasoningEfforts: string[] } | undefined;
};

/** 管理每个项目唯一的长期执行会话，并以单项目 FIFO 队列运行请求。 */
export class ProjectExecutionThreadService {
  private readonly engine: AgentLoopEngine;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly activeLoops = new Map<string, { turnId: string; loopId: string }>();

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, private readonly options: ProjectExecutionThreadServiceOptions = {}) {
    this.engine = new AgentLoopEngine(store, model, undefined, {
      defaultMaxSteps: options.maxSteps ?? 40,
      defaultMaxDurationMs: options.maxDurationMs ?? 1_800_000,
      defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls ?? 2,
      defaultMaxNoProgressSteps: options.maxNoProgressSteps ?? 3,
    });
  }

  /** 延迟创建项目会话；唯一项目约束保证重复打开和刷新不会产生重复线程。 */
  get(projectId: string): ProjectExecutionThreadSnapshot {
    const project = this.requireProject(projectId);
    const thread = this.getOrCreate(project);
    const executor = project.settings.models.executor;
    const catalog = this.options.modelCatalogForProject?.(project);
    const models = catalog?.models ?? PROJECT_EXECUTION_MODELS;
    const efforts = catalog ? catalog.reasoningEfforts : PROJECT_EXECUTION_REASONING_EFFORTS;
    // 当前覆盖值一定要在选项里，否则用户看不到自己配了什么、也没法清掉它。
    const effortValues = [...new Set([...efforts, ...(thread.reasoningEffortOverride ? [thread.reasoningEffortOverride] : [])])];
    return {
      thread,
      messages: this.store.listProjectExecutionMessages(thread.id),
      lastEventSequence: this.store.getLastEventSequence(thread.id),
      defaultModel: executor.model,
      defaultReasoningEffort: executor.reasoningEffort ?? null,
      modelOptions: [...new Set([...models, executor.model, this.model.configFor("executor").model, ...(thread.modelOverride ? [thread.modelOverride] : [])])],
      reasoningEffortOptions: [
        { value: null, label: "跟随项目默认" },
        ...effortValues.map((value) => ({ value, label: value })),
      ],
      // Project 没写 backend 时它就是这个角色在全局配置里的后端（路由网关已把 id 放进 configFor）。
      backend: executor.backend ?? this.model.configFor("executor").backend ?? "unknown",
    };
  }

  updatePreferences(projectId: string, preferences: { model: string | null; reasoningEffort: string | null }): ProjectExecutionThread {
    const project = this.requireProject(projectId);
    const thread = this.getOrCreate(project);
    const snapshot = this.get(projectId);
    const allowedModels = new Set(snapshot.modelOptions);
    if (preferences.model !== null && !allowedModels.has(preferences.model)) throw new Error("PROJECT_EXECUTION_MODEL_INVALID");
    // 推理强度校验与上面给出的选项同源：能选的一定能存，存过的一定还能再存。
    const allowedEfforts = new Set(snapshot.reasoningEffortOptions.map((option) => option.value).filter((value): value is string => value !== null));
    if (preferences.reasoningEffort !== null && !allowedEfforts.has(preferences.reasoningEffort)) throw new Error("PROJECT_EXECUTION_REASONING_EFFORT_INVALID");
    const updated = this.store.updateProjectExecutionThread({
      ...thread,
      modelOverride: preferences.model,
      reasoningEffortOverride: preferences.reasoningEffort,
      updatedAt: this.store.now(),
    });
    this.store.appendEvent({ type: "project.execution.preferences.updated", aggregateId: thread.id, payload: { projectId, modelOverride: updated.modelOverride, reasoningEffortOverride: updated.reasoningEffortOverride } });
    return updated;
  }

  /** 保存请求及其助手占位；clientTurnId 对重试保持幂等。 */
  submit(projectId: string, input: { content: string; clientTurnId: string }): { thread: ProjectExecutionThread; user: ProjectExecutionMessage; assistant: ProjectExecutionMessage } {
    const project = this.requireProject(projectId);
    if (project.status !== "ACTIVE") throw new Error("PROJECT_ARCHIVED");
    const content = input.content.trim();
    const clientTurnId = input.clientTurnId.trim();
    if (!content) throw new Error("PROJECT_EXECUTION_MESSAGE_EMPTY");
    if (!clientTurnId || clientTurnId.length > 160) throw new Error("PROJECT_EXECUTION_CLIENT_TURN_ID_INVALID");
    const thread = this.getOrCreate(project);
    const existing = this.store.getProjectExecutionMessageByClientTurnId(thread.id, clientTurnId);
    if (existing) {
      const assistant = this.store.listProjectExecutionMessages(thread.id).find((message) => message.turnId === existing.turnId && message.role === "assistant");
      if (assistant) return { thread, user: existing, assistant };
    }
    const messages = this.store.listProjectExecutionMessages(thread.id);
    const hasInFlight = messages.some((message) => message.role === "assistant" && (message.status === "QUEUED" || message.status === "RUNNING"));
    const createdAt = this.store.now();
    const turnId = this.store.nextId("project-execution-turn");
    const status: ProjectExecutionTurnStatus = hasInFlight ? "QUEUED" : "RUNNING";
    const user: ProjectExecutionMessage = {
      id: this.store.nextId("project-execution-message"), threadId: thread.id, turnId, clientTurnId,
      role: "user", content, status: "COMPLETED", error: null, createdAt,
      sequence: (messages.at(-1)?.sequence ?? 0) + 1, loopId: null, model: null, reasoningEffort: null,
    };
    const assistant: ProjectExecutionMessage = {
      id: this.store.nextId("project-execution-message"), threadId: thread.id, turnId, clientTurnId: null,
      role: "assistant", content: "", status, error: null, createdAt,
      sequence: user.sequence + 1, loopId: null, model: null, reasoningEffort: null,
    };
    this.store.saveProjectExecutionMessage(user);
    this.store.saveProjectExecutionMessage(assistant);
    this.store.updateProjectExecutionThread({ ...thread, updatedAt: createdAt });
    this.store.appendEvent({ type: "project.execution.turn.accepted", aggregateId: thread.id, payload: { projectId, turnId, userMessageId: user.id, assistantMessageId: assistant.id, status } });
    if (status === "RUNNING") this.startWorker(project.id, thread.id);
    return { thread, user, assistant };
  }

  async cancel(projectId: string, assistantMessageId: string): Promise<ProjectExecutionMessage> {
    const project = this.requireProject(projectId);
    const thread = this.getOrCreate(project);
    const assistant = this.store.listProjectExecutionMessages(thread.id).find((message) => message.id === assistantMessageId && message.role === "assistant");
    if (!assistant) throw new Error("PROJECT_EXECUTION_TURN_NOT_FOUND");
    if (assistant.status === "QUEUED") {
      const cancelled = this.store.updateProjectExecutionMessage({ ...assistant, status: "CANCELLED", error: "USER_CANCELLED" });
      this.store.appendEvent({ type: "project.execution.turn.cancelled", aggregateId: thread.id, payload: { turnId: assistant.turnId, messageId: assistant.id, reason: "user_cancelled" } });
      return cancelled;
    }
    const active = this.activeLoops.get(thread.id);
    if (active?.turnId !== assistant.turnId) return assistant;
    await this.engine.cancel(active.loopId, "user_cancelled");
    return this.store.listProjectExecutionMessages(thread.id).find((message) => message.id === assistant.id) ?? assistant;
  }

  pauseLoop(loopId: string, reason: string) { return this.engine.pause(loopId, reason); }
  resumeLoop(loopId: string) { return this.engine.resume(loopId); }
  cancelLoop(loopId: string, reason: string) { return this.engine.cancel(loopId, reason); }

  /** 服务启动时不重放未知副作用的在途轮次，并继续处理已持久化队列。 */
  recoverQueuedTurns(): void {
    for (const project of this.store.listProjects()) {
      const thread = this.store.getProjectExecutionThread(project.id);
      if (!thread) continue;
      for (const message of this.store.listProjectExecutionMessages(thread.id)) {
        if (message.role !== "assistant" || message.status !== "RUNNING") continue;
        const recovered = this.store.updateProjectExecutionMessage({ ...message, status: "RECOVERY_REQUIRED", error: "PROJECT_EXECUTION_RECOVERY_REQUIRED" });
        const loop = message.loopId ? this.store.getAgentLoop(message.loopId) : undefined;
        if (loop && !["COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "NEEDS_RECONCILIATION"].includes(loop.state)) {
          const completedAt = this.store.now();
          this.store.updateAgentLoop({ ...loop, state: "NEEDS_RECONCILIATION", completedAt, checkpointJson: JSON.stringify({ reason: "PROJECT_EXECUTION_RECOVERY_REQUIRED" }) });
          this.store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_FAILED", status: "NEEDS_RECONCILIATION", payload: { reason: "PROJECT_EXECUTION_RECOVERY_REQUIRED", recovered: true } });
          this.store.appendEvent({ type: "agent.loop.recovery_required", aggregateId: loop.id, payload: { reason: "PROJECT_EXECUTION_RECOVERY_REQUIRED", recovered: true } });
        }
        this.store.appendEvent({ type: "project.execution.turn.failed", aggregateId: thread.id, payload: { turnId: recovered.turnId, messageId: recovered.id, error: recovered.error, recoveryRequired: true } });
      }
      if (this.store.listProjectExecutionMessages(thread.id).some((message) => message.role === "assistant" && message.status === "QUEUED")) this.startWorker(project.id, thread.id);
    }
  }

  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    return project;
  }

  private getOrCreate(project: Project): ProjectExecutionThread {
    const existing = this.store.getProjectExecutionThread(project.id);
    if (existing) return existing;
    const now = this.store.now();
    const candidate: ProjectExecutionThread = {
      id: this.store.nextId("project-execution"), projectId: project.id,
      providerThreadId: null, modelOverride: null, reasoningEffortOverride: null,
      createdAt: now, updatedAt: now,
    };
    const thread = this.store.saveProjectExecutionThread(candidate);
    if (thread.id === candidate.id) this.store.appendEvent({ type: "project.execution.thread.created", aggregateId: thread.id, payload: { projectId: project.id } });
    return thread;
  }

  private startWorker(projectId: string, threadId: string): void {
    if (this.workers.has(threadId)) return;
    const worker = this.drain(projectId, threadId).finally(() => {
      this.workers.delete(threadId);
      if (this.store.listProjectExecutionMessages(threadId).some((message) => message.role === "assistant" && message.status === "QUEUED")) this.startWorker(projectId, threadId);
    });
    this.workers.set(threadId, worker);
  }

  private async drain(projectId: string, threadId: string): Promise<void> {
    for (;;) {
      const assistant = this.store.listProjectExecutionMessages(threadId).find((message) => message.role === "assistant" && message.status === "QUEUED")
        ?? this.store.listProjectExecutionMessages(threadId).find((message) => message.role === "assistant" && message.status === "RUNNING" && !message.loopId);
      if (!assistant) return;
      const thread = this.store.getProjectExecutionThread(projectId);
      const project = this.store.getProject(projectId);
      if (!thread || !project || project.status !== "ACTIVE") {
        this.store.updateProjectExecutionMessage({ ...assistant, status: "FAILED", error: project?.status === "ARCHIVED" ? "PROJECT_ARCHIVED" : "PROJECT_NOT_FOUND" });
        continue;
      }
      const startedAt = this.store.now();
      const executorDefaults = project.settings.models.executor;
      const effectiveConfig: ModelRoleConfig = {
        ...executorDefaults,
        model: thread.modelOverride ?? executorDefaults.model,
        ...(thread.reasoningEffortOverride ?? executorDefaults.reasoningEffort
          ? { reasoningEffort: thread.reasoningEffortOverride ?? executorDefaults.reasoningEffort }
          : { reasoningEffort: undefined }),
      };
      const running = this.store.updateProjectExecutionMessage({
        ...assistant, status: "RUNNING", error: null, model: effectiveConfig.model,
        reasoningEffort: effectiveConfig.reasoningEffort ?? null,
      });
      this.store.appendEvent({ type: "project.execution.turn.started", aggregateId: thread.id, payload: { turnId: running.turnId, messageId: running.id, model: effectiveConfig.model, reasoningEffort: effectiveConfig.reasoningEffort ?? null, startedAt } });
      const conversation: ModelMessage[] = this.store.listProjectExecutionMessages(threadId)
        .filter((message) => message.sequence <= running.sequence && message.turnId !== running.turnId)
        .map((message) => ({ role: message.role, content: message.content }));
      const userMessage = this.store.listProjectExecutionMessages(threadId).find((message) => message.turnId === running.turnId && message.role === "user");
      if (userMessage) conversation.push({ role: "user", content: userMessage.content });
      const system: ModelMessage = {
        role: "system",
        content: [
          `你是项目 ${project.name} 的长期执行助手。直接在项目仓库中完成用户请求，不要求先创建 Explorer Plan，也不要创建 Run。`,
          `工作目录固定为项目仓库根目录：${project.repoRoot}。只能访问此工作区；使用提供的工具和现有项目策略。`,
          "持续利用本线程已有上下文。简明汇报执行进度、结果和验证情况；遇到失败时说明原因。",
          effectiveConfig.developerInstructions,
        ].filter(Boolean).join("\n\n"),
      };
      const loopMode = effectiveConfig.loopMode ?? "provider-controlled";
      const toolRuntime = this.options.toolRuntimeForProject?.(project);
      const loopId = this.store.nextId("agent-loop");
      this.activeLoops.set(thread.id, { turnId: running.turnId, loopId });
      this.store.updateProjectExecutionMessage({ ...running, loopId });
      try {
        const loop = await this.engine.start({
          id: loopId,
          ownerType: "project-execution-turn",
          ownerId: running.id,
          role: "executor",
          mode: loopMode,
          maxSteps: this.options.maxSteps ?? 40,
          // 这个线程没有回答入口（面板只有提交 / 取消）。模型真要结构化提问时让 Loop 直接阻塞，
          // 不要挂进「等待输入」——那个状态在这条线上等不到答案，只能靠取消脱身。
          allowStructuredInput: false,
          ...(this.options.maxDurationMs === undefined ? {} : { maxDurationMs: this.options.maxDurationMs }),
          ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
          ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
          ...(this.options.providerCommandTimeoutMs === undefined ? {} : { providerCommandTimeoutMs: this.options.providerCommandTimeoutMs }),
          workspacePath: project.repoRoot,
          ...(toolRuntime ? { toolRuntime } : {}),
          modelRequest: {
            messages: [system, ...conversation],
            conversationId: thread.id,
            providerThreadId: thread.providerThreadId ?? undefined,
            cwd: project.repoRoot,
            modelConfig: effectiveConfig,
          },
          onEvent: (event) => this.handleLoopEvent(thread, running, event),
        });
        const result = await this.engine.wait(loop.id);
        const current = this.store.listProjectExecutionMessages(thread.id).find((message) => message.id === running.id) ?? running;
        const status = result.state === "COMPLETED" ? "COMPLETED" : result.state === "CANCELLED" ? "CANCELLED" : "FAILED";
        const error = status === "FAILED" ? this.loopError(result.checkpointJson) : null;
        this.store.updateProjectExecutionMessage({ ...current, status, error });
        this.store.appendEvent({
          type: status === "COMPLETED" ? "project.execution.turn.completed" : status === "CANCELLED" ? "project.execution.turn.cancelled" : "project.execution.turn.failed",
          aggregateId: thread.id,
          payload: { turnId: running.turnId, messageId: running.id, status, ...(error ? { error } : {}) },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.store.listProjectExecutionMessages(thread.id).find((item) => item.id === running.id) ?? running;
        this.store.updateProjectExecutionMessage({ ...current, status: "FAILED", error: message });
        this.store.appendEvent({ type: "project.execution.turn.failed", aggregateId: thread.id, payload: { turnId: running.turnId, messageId: running.id, error: message } });
      } finally {
        this.activeLoops.delete(thread.id);
      }
    }
  }

  private handleLoopEvent(thread: ProjectExecutionThread, assistant: ProjectExecutionMessage, event: AgentLoopEvent): void {
    const message = this.store.listProjectExecutionMessages(thread.id).find((item) => item.id === assistant.id);
    if (!message) return;
    if (event.type === "agent.provider.thread.started" && typeof event.payload.threadId === "string") {
      const updated = this.store.updateProjectExecutionThread({ ...thread, providerThreadId: event.payload.threadId, updatedAt: this.store.now() });
      thread.providerThreadId = updated.providerThreadId;
    }
    if (event.type === "agent.model.text.delta" && typeof event.payload.text === "string") {
      const updated = this.store.updateProjectExecutionMessage({ ...message, content: message.content + event.payload.text });
      this.store.appendEvent({ type: "project.execution.turn.text.delta", aggregateId: thread.id, payload: { turnId: assistant.turnId, messageId: assistant.id, text: event.payload.text, content: updated.content } });
      return;
    }
    if (event.type === "agent.provider.activity" || event.type.startsWith("agent.tool.")) {
      this.store.appendEvent({ type: "project.execution.turn.activity", aggregateId: thread.id, payload: { turnId: assistant.turnId, messageId: assistant.id, kind: event.type, ...event.payload } });
    }
  }

  private loopError(checkpointJson: string | null): string {
    if (checkpointJson) {
      try {
        const value = JSON.parse(checkpointJson) as Record<string, unknown>;
        const candidate = value.error ?? value.reason;
        if (typeof candidate === "string") return candidate;
      } catch { /* keep a stable fallback for malformed legacy checkpoints */ }
    }
    return "AGENT_LOOP_FAILED";
  }
}
