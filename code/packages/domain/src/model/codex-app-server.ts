/**
 * 模块职责：封装 Codex App Server 的进程、JSON-RPC 会话和事件映射。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EXPLORER_PLAN_INSTRUCTIONS } from "../platform/plan-requirements.js";
import { replayConversation, resolveModelMode } from "./provider-session.js";
import { activityOutcome, classifyCodexActivity, type ProviderActivityKind } from "./provider-activity.js";
import { normalizeModelUsage } from "./usage.js";
// 用 import type 而不是"具名绑定带 type 前缀"：这样"本模块对模型契约只剩类型依赖"是显式的，
// check-cycles.mjs 也据此判定这条边已被切断。P2 期间它指向 ../index.js；批 E 建 model/types.ts
// 后改指 ./types.js（边仍是 type-only，判定不变）—— 至此 model/ 下四个 ModelGateway 实现
// 都直接从同一处契约取类型，不再有实现经由 barrel 绕一圈。
import type {
  ModelCapabilities,
  ModelEvent,
  ModelGateway,
  ModelMessage,
  ModelMessagePhase,
  ModelRequest,
  ModelRole,
  ModelRoleConfig,
  ProviderEndpoint,
} from "./types.js";

type JsonObject = Record<string, unknown>;
/** JSON-RPC 请求和通知使用的 Provider request id。 */
export type CodexRequestId = string | number;

/** Codex App Server 推送的通知或响应事件。 */
export type CodexAppServerEvent = { id?: CodexRequestId; method: string; params: JsonObject };

/** 启动外部 Codex Thread 的固定工作目录、沙箱和审批策略。 */
export type CodexThreadStartParams = {
  model: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never" | "on-request";
  baseInstructions?: string;
  developerInstructions?: string;
  collaborationMode?: {
    mode: "plan" | "default";
    settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
  };
};

/** 启动 Provider turn 的输入和可取消信号。 */
export type CodexTurnStartParams = {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
  model: string;
  effort?: string;
  cwd?: string;
  collaborationMode?: {
    mode: "plan" | "default";
    settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
  };
  signal?: AbortSignal;
};

/** App Server 会话端口；Domain 通过它隔离具体 JSON-RPC 传输。 */
export type CodexAppServerSession = {
  startThread(params: CodexThreadStartParams): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  streamTurn(params: CodexTurnStartParams): AsyncIterable<CodexAppServerEvent>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  respond(requestId: CodexRequestId, result: JsonObject): Promise<void>;
  answerUserInput(requestId: CodexRequestId, response: { answers: Record<string, { answers: string[] }> }): Promise<void>;
  close(): Promise<void>;
};

/** 创建新 Provider 会话的工厂，便于重启和测试注入。 */
export type CodexAppServerSessionFactory = () => Promise<CodexAppServerSession>;

/** Codex App Server Client 的进程、超时和重启参数。 */
export type CodexAppServerClientOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  maxRestarts?: number;
  clientName: string;
  clientVersion: string;
  spawnProcess?: CodexSpawnProcess;
};

/** 可替换的进程启动函数，用于隔离真实子进程和测试桩。 */
export type CodexSpawnProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
};

class NotificationSubscription implements AsyncIterableIterator<CodexAppServerEvent> {
  private readonly queue: CodexAppServerEvent[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<CodexAppServerEvent>) => void; reject: (error: Error) => void }> = [];
  private ended = false;
  private failure: Error | null = null;

  constructor(private readonly predicate: (event: CodexAppServerEvent) => boolean) {}

  push(event: CodexAppServerEvent): void {
    if (this.ended || !this.predicate(event)) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<CodexAppServerEvent>> {
    const event = this.queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<CodexAppServerEvent>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<CodexAppServerEvent> {
    return this;
  }
}

/** 通过 stdio JSON-RPC 管理 Codex App Server 进程、请求超时、通知订阅和重启。 */
export class CodexAppServerClient implements CodexAppServerSession {
  private readonly spawnProcess: CodexSpawnProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Set<NotificationSubscription>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private startup: Promise<void> | undefined;
  private initialized = false;
  private closing = false;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private hasStarted = false;
  private restartCount = 0;

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  }

  async startThread(params: CodexThreadStartParams): Promise<string> {
    await this.ensureReady();
    const result = await this.request("thread/start", params);
    const thread = getObject(result, "thread");
    const threadId = getString(thread, "id");
    if (!threadId) throw new Error("Codex App Server returned thread/start without a thread id");
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureReady();
    await this.request("thread/resume", { threadId });
  }

  async *streamTurn(params: CodexTurnStartParams): AsyncIterable<CodexAppServerEvent> {
    await this.ensureReady();
    const subscription = new NotificationSubscription((event) => getString(event.params, "threadId") === params.threadId);
    this.subscriptions.add(subscription);
    let turnId: string | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      const result = await this.request(
        "turn/start",
        {
          threadId: params.threadId,
          input: params.input,
          model: params.model,
          ...(params.effort ? { effort: params.effort } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.collaborationMode ? { collaborationMode: params.collaborationMode } : {}),
        },
        params.signal,
      );
      const turn = getObject(result, "turn");
      turnId = getString(turn, "id");
      if (!turnId) throw new Error("Codex App Server returned turn/start without a turn id");
      if (params.signal) {
        const onAbort = () => {
          void this.interrupt(params.threadId, turnId!).catch(() => undefined);
        };
        params.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", onAbort);
      }
      while (true) {
        const next = await subscription.next();
        if (next.done) return;
        const eventTurnId = getEventTurnId(next.value.params);
        if (eventTurnId && eventTurnId !== turnId) continue;
        yield next.value;
        if (next.value.method === "turn/completed") return;
      }
    } finally {
      removeAbortListener?.();
      this.subscriptions.delete(subscription);
      subscription.end();
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.ensureReady();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async respond(requestId: CodexRequestId, result: JsonObject): Promise<void> {
    if (!this.process) throw new Error("Codex App Server process is not running");
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`);
  }

  async answerUserInput(requestId: CodexRequestId, response: { answers: Record<string, { answers: string[] }> }): Promise<void> {
    await this.respond(requestId, response as unknown as JsonObject);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error("Codex App Server client closed"));
    }
    this.pending.clear();
    for (const subscription of this.subscriptions) subscription.end(new Error("Codex App Server client closed"));
    this.subscriptions.clear();
    this.process?.stdin.end();
    this.process?.kill("SIGTERM");
    this.process = undefined;
    this.initialized = false;
    this.startup = undefined;
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) return;
    if (!this.startup) this.startup = this.startProcess();
    try {
      await this.startup;
    } catch (error) {
      this.startup = undefined;
      throw error;
    }
  }

  private async startProcess(): Promise<void> {
    if (this.hasStarted) {
      const maxRestarts = this.options.maxRestarts ?? 3;
      if (this.restartCount >= maxRestarts) throw new Error(`Codex App Server restart limit reached (${maxRestarts})`);
      this.restartCount += 1;
    } else {
      this.hasStarted = true;
    }
    this.closing = false;
    this.process = this.spawnProcess(this.options.command, this.options.args, { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string | Buffer) => this.readStdout(String(chunk)));
    this.process.once("error", (error) => this.handleProcessFailure(error instanceof Error ? error : new Error(String(error))));
    this.process.once("exit", (code, signal) => {
      if (!this.closing) this.handleProcessFailure(new Error(`Codex App Server exited with ${signal ?? code ?? "unknown status"}`));
    });
    await this.request(
      "initialize",
      {
        clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
        capabilities: { experimentalApi: true },
      },
      undefined,
      this.options.startupTimeoutMs,
    );
    this.initialized = true;
  }

  private request(method: string, params: JsonObject, signal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("Codex App Server process is not running"));
    if (signal?.aborted) return Promise.reject(createAbortError());
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbortListener?.();
        reject(new Error(`Codex App Server request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(createAbortError());
      };
      // 声明在这里而不是函数顶部：它只被赋值一次，而唯一读它的地方是上面的超时回调——那个回调
      // 在本次初始化之后才会执行，所以没有暂时性死区问题（`const` 而不是 `let` 也是这个意思）。
      const removeAbortListener = signal ? () => signal.removeEventListener("abort", onAbort) : undefined;
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, ...(removeAbortListener ? { removeAbortListener } : {}) });
      try {
        this.process!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        removeAbortListener?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed) as JsonObject);
      } catch (error) {
        this.handleProcessFailure(new Error(`Invalid Codex App Server JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  private handleMessage(message: JsonObject): void {
    const id = message.id;
    if (id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id));
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(getString(error, "message") ?? "Codex App Server request failed"));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string" || !message.params || typeof message.params !== "object") return;
    const event: CodexAppServerEvent = {
      ...(id === undefined ? {} : { id: id as CodexRequestId }),
      method: message.method,
      params: message.params as JsonObject,
    };
    for (const subscription of this.subscriptions) subscription.push(event);
  }

  private handleProcessFailure(error: Error): void {
    if (this.closing) return;
    this.initialized = false;
    this.process = undefined;
    this.startup = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
    for (const subscription of this.subscriptions) subscription.end(error);
  }
}

/** 将 App Server 事件映射成 ModelGateway 事件时使用的角色和会话工厂。 */
export type CodexAppServerGatewayOptions = {
  roles: Record<ModelRole, ModelRoleConfig>;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRestarts?: number;
  clientName?: string;
  clientVersion?: string;
  sessionFactory?: CodexAppServerSessionFactory;
};

/** 将 Codex App Server 协议映射为 Domain ModelGateway，并保留 Provider activity 与输入请求。 */
export class CodexAppServerGateway implements ModelGateway {
  private session: CodexAppServerSession | null = null;
  private sessionPromise: Promise<CodexAppServerSession> | null = null;
  private readonly resumedThreads = new Set<string>();
  private readonly sessionFactory: CodexAppServerSessionFactory;
  private readonly providerThreads = new Map<string, string>();
  private readonly pendingInputSessions = new Map<string, CodexAppServerSession>();

  constructor(private readonly options: CodexAppServerGatewayOptions) {
    this.sessionFactory =
      options.sessionFactory ??
      (async () =>
        new CodexAppServerClient({
          command: options.command ?? "codex",
          args: options.args ?? ["app-server", "--stdio"],
          cwd: options.cwd ?? process.cwd(),
          startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
          requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
          maxRestarts: options.maxRestarts ?? 3,
          clientName: options.clientName ?? "pipeline-factory",
          clientVersion: options.clientVersion ?? "4.0.0",
        }));
  }

  configFor(role: ModelRole): ModelRoleConfig {
    return this.options.roles[role];
  }

  /**
   * 端点指纹：Codex 侧没有可配的 baseUrl，能担保的只有"我们启动了哪个 CLI"，
   * 上游端点与凭据由 Codex 自己的登录态决定 —— 因此 endpoint 记命令、source 记 provider-settings。
   * CLI 版本不在这里编：App Server 的 initialize 响应本适配器不消费版本字段，如实留 null。
   */
  describeEndpoint(): ProviderEndpoint {
    return {
      backend: "codex-app-server",
      endpoint: [this.options.command ?? "codex", ...(this.options.args ?? ["app-server", "--stdio"])].join(" "),
      source: "provider-settings",
      cliVersion: null,
      credentialSource: null,
      providerModel: null,
    };
  }

  capabilities(role: ModelRole): ModelCapabilities {
    return { supportsStructuredUserInput: role === "explorer", supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    try {
      const session = await this.getSession(request.conversationId ?? request.role);
      const roleConfig = { ...this.configFor(request.role), ...(request.modelConfig ?? {}) };
      const mode = resolveModelMode(request, roleConfig);
      let providerThreadId =
        request.providerThreadId ?? (request.conversationId ? this.providerThreads.get(request.conversationId) : undefined);
      let rebuilt = false;
      if (providerThreadId) {
        if (request.conversationId) this.providerThreads.set(request.conversationId, providerThreadId);
        if (!this.resumedThreads.has(providerThreadId)) {
          try {
            await session.resumeThread(providerThreadId);
            this.resumedThreads.add(providerThreadId);
          } catch {
            // Provider 侧会话可能已经消失（App Server 重启、换供应商、会话过期）。这不是回合失败：
            // request.messages 里带着完整历史，重建一条新线程继续即可，否则一次可恢复的丢失会
            // 被升级成"这次探索挂了"，用户看到的错误也解释不了原因。
            this.resumedThreads.delete(providerThreadId);
            providerThreadId = undefined;
            rebuilt = true;
          }
        }
      }
      if (!providerThreadId) {
        const developerInstructions =
          request.role === "explorer" && mode === "plan"
            ? [EXPLORER_PLAN_INSTRUCTIONS, roleConfig.developerInstructions].filter(Boolean).join("\n\n")
            : roleConfig.developerInstructions;
        providerThreadId = await session.startThread({
          model: roleConfig.model,
          cwd: request.cwd ?? process.cwd(),
          sandbox: request.role === "explorer" ? "read-only" : "workspace-write",
          approvalPolicy: request.role === "explorer" ? "never" : "on-request",
          ...(systemInstructions(request.messages) ? { baseInstructions: systemInstructions(request.messages) } : {}),
          ...(developerInstructions ? { developerInstructions } : {}),
          collaborationMode: {
            mode,
            settings: {
              model: roleConfig.model,
              reasoning_effort: roleConfig.reasoningEffort ?? null,
              developer_instructions: roleConfig.developerInstructions ?? null,
            },
          },
        });
        if (request.conversationId) this.providerThreads.set(request.conversationId, providerThreadId);
        yield { type: "thread.started", threadId: providerThreadId };
        if (rebuilt) {
          // 让时间线上能看出"线程 id 为什么变了"，而不是静默换一条线程。
          yield {
            type: "provider.activity",
            phase: "completed",
            itemId: providerThreadId,
            itemType: "providerSession",
            ...classifyCodexActivity({ itemType: "providerSession", phase: "completed" }),
            title: "Provider session rebuilt",
            summary: "The previous provider session was gone; the local transcript was replayed into a new one.",
            providerItemId: providerThreadId,
          };
        }
      }
      // 常规续接只发最新一条用户消息（历史在 Provider 侧）；重建出来的线程没有那份历史，
      // 必须回放本地对话，否则模型只看到最后一句。
      const text = rebuilt ? replayConversation(request.messages) : latestUserMessage(request.messages);
      for await (const event of session.streamTurn({
        threadId: providerThreadId,
        input: [{ type: "text", text: request.continuationPrompt ?? text }],
        model: roleConfig.model,
        ...(roleConfig.reasoningEffort ? { effort: roleConfig.reasoningEffort } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        collaborationMode: {
          mode,
          settings: {
            model: roleConfig.model,
            reasoning_effort: roleConfig.reasoningEffort ?? null,
            developer_instructions: roleConfig.developerInstructions ?? null,
          },
        },
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        const eventTurnId = getEventTurnId(event.params);
        const mapped = mapCodexEvent(event, { providerThreadId, ...(eventTurnId ? { providerTurnId: eventTurnId } : {}) });
        const mappedEvents = mapped ? (Array.isArray(mapped) ? mapped : [mapped]) : [];
        for (const mappedEvent of mappedEvents) {
          if (mappedEvent.type === "turn.input_required") {
            if (event.id === undefined) throw new Error("Codex App Server input request did not include a JSON-RPC id");
            this.pendingInputSessions.set(String(event.id), session);
          }
          yield mappedEvent;
        }
      }
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) yield { type: "turn.cancelled" };
      else yield { type: "turn.failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    const session = this.session ?? (this.sessionPromise ? await this.sessionPromise.catch(() => null) : null);
    this.session = null;
    this.sessionPromise = null;
    this.pendingInputSessions.clear();
    await session?.close();
  }

  async answerUserInput(input: { requestId: string | number; answers: import("../index.js").ModelInputAnswers }): Promise<void> {
    const session = this.pendingInputSessions.get(String(input.requestId));
    if (!session) throw new Error(`No active Codex App Server input request ${String(input.requestId)}`);
    await session.answerUserInput(input.requestId, { answers: input.answers });
    this.pendingInputSessions.delete(String(input.requestId));
  }

  async cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void> {
    if (!request.providerTurnId) return;
    if (!this.session && !this.sessionPromise) return;
    const session = await this.getSession(request.conversationId);
    await session.interrupt(request.providerThreadId, request.providerTurnId);
  }

  private async getSession(_key: string): Promise<CodexAppServerSession> {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.sessionFactory()
        .then((session) => {
          this.session = session;
          return session;
        })
        .catch((error: unknown) => {
          this.sessionPromise = null;
          throw error;
        });
    }
    return this.sessionPromise;
  }
}

/** 把外部通知转换成内部统一 ModelEvent；未知通知安全忽略而不伪造模型输出。 */
function mapCodexEvent(
  event: CodexAppServerEvent,
  source: { providerThreadId?: string; providerTurnId?: string } = {},
): ModelEvent | ModelEvent[] | null {
  if (
    event.method.includes("tokenUsage") ||
    event.method.includes("token_usage") ||
    event.method === "thread/tokenUsage/updated" ||
    event.method === "thread/usage/updated"
  ) {
    const usage = extractCodexUsage(event.params);
    return usage
      ? [
          {
            type: "model.usage",
            usage,
            scope: "total",
            ...(source.providerThreadId ? { providerThreadId: source.providerThreadId } : {}),
            ...(source.providerTurnId ? { providerTurnId: source.providerTurnId } : {}),
          },
        ]
      : null;
  }
  if (event.method === "item/agentMessage/delta") {
    const text = getString(event.params, "delta");
    if (text === undefined) return null;
    const providerThreadId = getString(event.params, "threadId") ?? source.providerThreadId;
    const providerTurnId = getEventTurnId(event.params) ?? source.providerTurnId;
    const providerItemId = getString(event.params, "itemId") ?? getString(getObject(event.params, "item"), "id");
    return {
      type: "text.delta",
      text,
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerTurnId ? { providerTurnId } : {}),
      ...(providerItemId ? { providerItemId } : {}),
    };
  }
  if (event.method === "item/started" || event.method === "item/completed") {
    const item = getObject(event.params, "item");
    const itemId = getString(item, "id");
    const itemType = getString(item, "type");
    if (!itemId || !itemType) return null;
    // 正文类 item **不产出"活动行"**——它的文字走 `item/agentMessage/delta`。但 `phase`
    // （`commentary` / `final_answer`）**只在这条 item 上**，delta 的载荷里没有它
    // （见 `AgentMessageDeltaNotification` 的 schema），所以单独送一趟。
    // 此前这里对 agentMessage 直接 `return null`，把"这一段是过程叙述还是最终回答"整个丢掉了。
    if (itemType === "agentMessage" || itemType === "message") {
      const phase = messagePhaseOf(item);
      return phase ? { type: "text.phase", providerItemId: itemId, phase } : null;
    }
    const title = getString(item, "name") ?? getString(item, "title") ?? null;
    // **推理的文字在数组里**：Codex 的 `reasoning` item 是 `{ content: string[], summary: string[] }`，
    // 而下面这几个 `getString` 只认字符串——于是推理正文整段丢掉，界面上只剩一个「推理」标签。
    // 只取 `summary[]`（Provider 自己给的推理摘要）：`content[]` 是原始思维链，按本仓的立场不展示。
    const summary =
      (itemType === "reasoning" ? joinStrings(item, "summary") : null) ?? getString(item, "command") ?? getString(item, "text") ?? null;
    const server = getObject(item, "server");
    const serverName = getString(item, "serverName") ?? getString(server, "name");
    const toolName = getString(item, "toolName") ?? (itemType.toLowerCase().includes("tool") ? getString(item, "name") : undefined);
    const exitCode = numberField(item, "exitCode");
    const status = getString(item, "status") ?? (exitCode === undefined ? undefined : exitCode === 0 ? "succeeded" : "failed");
    const error =
      getString(item, "error") ??
      getString(getObject(item, "error"), "message") ??
      (exitCode !== undefined && exitCode !== 0 ? `Provider command exited with code ${exitCode}` : undefined);
    const providerThreadId = getString(event.params, "threadId") ?? source.providerThreadId;
    const providerTurnId = getEventTurnId(event.params) ?? source.providerTurnId;
    const phase = event.method === "item/started" ? "started" : "completed";
    // 中立词表在**这里**翻译，而不是留给消费方：`itemType` / `status` 是 Codex 的原生词，
    // 只有本文件知道它们的含义（见 model/provider-activity.ts 的模块注释）。
    const classification = classifyCodexActivity({
      itemType,
      phase,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
    });
    return {
      type: "provider.activity",
      phase,
      itemId,
      itemType,
      ...classification,
      title,
      summary,
      ...structuredItemPayload(itemType, item),
      ...(toolName ? { toolName } : {}),
      ...(serverName ? { serverName } : {}),
      ...(status ? { status } : {}),
      ...(error ? { error } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerTurnId ? { providerTurnId } : {}),
      providerItemId: itemId,
    };
  }
  if (event.method === "item/tool/requestUserInput") {
    const request = event.params;
    const threadId = getString(request, "threadId");
    const turnId = getString(request, "turnId");
    const itemId = getString(request, "itemId");
    if (!threadId || !turnId || !itemId || !Array.isArray(request.questions)) throw new Error("Invalid item/tool/requestUserInput payload");
    const questions = request.questions.flatMap((question) => {
      if (!question || typeof question !== "object") return [];
      const value = question as JsonObject;
      const id = getString(value, "id");
      const header = getString(value, "header");
      const text = getString(value, "question");
      if (!id || !header || !text) return [];
      const options =
        value.options === null
          ? null
          : Array.isArray(value.options)
            ? value.options.flatMap((option) => {
                if (!option || typeof option !== "object") return [];
                const item = option as JsonObject;
                const label = getString(item, "label");
                const description = getString(item, "description");
                return label && description ? [{ label, description }] : [];
              })
            : null;
      return [{ id, header, question: text, isOther: value.isOther === true, isSecret: value.isSecret === true, options }];
    });
    return {
      type: "turn.input_required",
      request: { requestId: event.id ?? "", threadId, turnId, itemId, questions, isBlocking: request.isBlocking === true },
    };
  }
  // ── ④「Provider 说的」运行事实 ────────────────────────────────────────────
  // 这些不是模型做的，也不是你说的，而是会话设施在报告自己的状态。它们走**同一套**
  // `provider.activity` 通道（消费方只需要一个地方回答"这是什么、成没成"，多一条事件类型就多
  // 一处要同步的地方），靠 `activityKind` 落进 ④ 组——消费方用 `isRuntimeKind()` 把它们挡在
  // 会话正文之外，收进 Run 头诊断区。
  if (event.method === "thread/compacted") {
    return runtimeFact(
      {
        id: `compaction:${getString(event.params, "turnId") ?? getString(event.params, "threadId") ?? "unknown"}`,
        itemType: "threadCompacted",
        activityKind: "compaction",
        title: "上下文已压缩",
        summary: "Provider 在这一轮压缩了上下文。",
      },
      source,
    );
  }
  if (event.method === "hook/started" || event.method === "hook/completed") {
    const run = getObject(event.params, "run");
    const name = getString(run, "eventName") ?? "hook";
    const started = event.method === "hook/started";
    const durationMs = numberField(run, "durationMs");
    const status = started ? "started" : (getString(run, "status") ?? "completed");
    const statusMessage = getString(run, "statusMessage");
    return runtimeFact(
      {
        id: getString(run, "id") ?? `hook:${name}:${getString(event.params, "turnId") ?? source.providerTurnId ?? ""}`,
        itemType: started ? "hook_started" : "hook_completed",
        activityKind: "hook",
        title: `钩子 · ${name}`,
        summary: started ? "钩子开始执行。" : "钩子执行结束。",
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(statusMessage ? { error: statusMessage } : {}),
      },
      source,
    );
  }
  if (event.method === "account/rateLimits/updated") {
    return runtimeFact(
      {
        id: `rate-limits:${source.providerThreadId ?? "account"}`,
        itemType: "accountRateLimits",
        activityKind: "rate-limit",
        title: "配额已更新",
        summary: "Provider 上报了新的账号配额。",
      },
      source,
    );
  }
  if (
    event.method === "warning" ||
    event.method === "guardianWarning" ||
    event.method === "configWarning" ||
    event.method === "windows/worldWritableWarning"
  ) {
    const message = getString(event.params, "message") ?? getString(event.params, "summary") ?? "Provider 报告了一条警告。";
    return runtimeFact(
      {
        id: `warning:${event.method}:${source.providerThreadId ?? ""}:${message.slice(0, 40)}`,
        itemType: event.method,
        activityKind: "warning",
        title: "Provider 警告",
        summary: message,
        status: "warning",
      },
      source,
    );
  }
  if (event.method === "deprecationNotice") {
    const summary = getString(event.params, "summary") ?? "Provider 报告了一条弃用提示。";
    const details = getString(event.params, "details");
    return runtimeFact(
      {
        id: `deprecation:${summary.slice(0, 40)}`,
        itemType: "deprecationNotice",
        activityKind: "warning",
        title: "弃用提示",
        summary: [summary, details].filter(Boolean).join(" "),
        status: "warning",
      },
      source,
    );
  }
  if (event.method !== "turn/completed") return null;
  const turn = getObject(event.params, "turn");
  const usage = extractCodexUsage(turn) ?? extractCodexUsage(event.params);
  const usageEvent = usage
    ? {
        type: "model.usage" as const,
        usage,
        scope: "turn" as const,
        ...(source.providerThreadId ? { providerThreadId: source.providerThreadId } : {}),
        ...(source.providerTurnId ? { providerTurnId: source.providerTurnId } : {}),
      }
    : null;
  const status = getString(turn, "status");
  if (status === "interrupted") return usageEvent ? [usageEvent, { type: "turn.cancelled" }] : { type: "turn.cancelled" };
  if (status === "failed") {
    const turnError = getObject(turn, "error");
    const failed = { type: "turn.failed" as const, error: getString(turnError, "message") ?? "Codex turn failed" };
    return usageEvent ? [usageEvent, failed] : failed;
  }
  return usageEvent ? [usageEvent, { type: "turn.completed" }] : { type: "turn.completed" };
}

/** 这一条正文是"过程叙述"还是"最终回答"。Provider 不保证给，不给就是"不知道"。 */
function messagePhaseOf(item: JsonObject): ModelMessagePhase | null {
  const phase = getString(item, "phase");
  return phase === "commentary" || phase === "final_answer" ? phase : null;
}

/**
 * 一条**没有 item 载体**的运行事实（通知形态，如 `thread/compacted` / `hook/*` / 账号配额）。
 * 构造出来的形态与 item 那条一模一样，消费方不必分两路读。
 */
function runtimeFact(
  input: {
    id: string;
    itemType: string;
    activityKind: ProviderActivityKind;
    title: string;
    summary: string;
    status?: string;
    error?: string;
    durationMs?: number;
  },
  source: { providerThreadId?: string; providerTurnId?: string },
): ModelEvent {
  return {
    type: "provider.activity",
    phase: "completed",
    itemId: input.id,
    itemType: input.itemType,
    activityKind: input.activityKind,
    outcome: activityOutcome({
      kind: input.activityKind,
      phase: "completed",
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
    title: input.title,
    summary: input.summary,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.status ? { status: input.status } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(source.providerThreadId ? { providerThreadId: source.providerThreadId } : {}),
    ...(source.providerTurnId ? { providerTurnId: source.providerTurnId } : {}),
    providerItemId: input.id,
  };
}

/**
 * 这一动作的**结构化载荷**——"它到底跑了什么、结果是什么"，此前一个都没进业务层。
 *
 * 取不到的键**不写**：`undefined` 是"Provider 没给"，空数组是"Provider 说这里什么都没有"，
 * 两者在界面上该长得不一样（前者不摆那一格，后者摆一个"无输出"）。
 * 输出类字段落库保留原样，**脱敏与截断发生在展示边界**（`apps/web/src/utils/sensitiveValue.ts`），
 * 这样排障与审计仍然拿得到全量数据。
 */
function structuredItemPayload(
  itemType: string,
  item: JsonObject,
): { arguments?: unknown; result?: unknown; output?: string; exitCode?: number; durationMs?: number } {
  const payload: { arguments?: unknown; result?: unknown; output?: string; exitCode?: number; durationMs?: number } = {};
  const durationMs = numberField(item, "durationMs");
  if (durationMs !== undefined) payload.durationMs = durationMs;
  if (itemType === "commandExecution") {
    const output = getString(item, "aggregatedOutput");
    if (output !== undefined) payload.output = output;
    const exitCode = numberField(item, "exitCode");
    if (exitCode !== undefined) payload.exitCode = exitCode;
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall") {
    if (item.arguments !== undefined) payload.arguments = item.arguments;
    if (item.result !== undefined) payload.result = item.result;
  }
  if (itemType === "fileChange" && item.changes !== undefined) payload.result = item.changes;
  if (itemType === "webSearch" && item.results !== undefined) payload.result = item.results;
  return payload;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as JsonObject)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? messages.at(-1)?.content ?? "Continue.";
}

function systemInstructions(messages: ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

function getObject(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== "object") return {};
  const candidate = (value as JsonObject)[key];
  return candidate && typeof candidate === "object" ? (candidate as JsonObject) : {};
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as JsonObject)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * 取一个**字符串数组**字段并拼成一段。Codex 的推理 item 用这种形状（`summary: string[]`），
 * 而 `getString` 对它只会返回 `undefined`——**这就是推理正文一直被丢掉的原因**：
 * 界面上只有一个「推理」标签，展开也没有东西，看起来像"这一轮没推理"。
 *
 * 空数组、全是空串都算"没有内容"，返回 `null` 而不是空串（两者的区别在呈现层是有意义的）。
 */
function joinStrings(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as JsonObject)[key];
  if (!Array.isArray(candidate)) return null;
  const joined = candidate
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return joined || null;
}

function getEventTurnId(params: JsonObject): string | undefined {
  return getString(params, "turnId") ?? getString(getObject(params, "turn"), "id");
}

function extractCodexUsage(value: unknown): ReturnType<typeof normalizeModelUsage> {
  if (!value || typeof value !== "object") return null;
  const candidate = value as JsonObject;
  const usage =
    candidate.usage ??
    candidate.tokenUsage ??
    candidate.token_usage ??
    getObject(candidate, "response").usage ??
    getObject(candidate, "turn").usage;
  const direct = normalizeModelUsage(usage);
  if (direct) return direct;
  if (usage && typeof usage === "object") {
    const nested = usage as JsonObject;
    return normalizeModelUsage(nested.total) ?? normalizeModelUsage(nested.last) ?? normalizeModelUsage(nested.current);
  }
  return normalizeModelUsage(candidate);
}

function createAbortError(): Error {
  const error = new Error("Codex App Server request was cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
