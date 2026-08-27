import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ModelEvent, ModelGateway, ModelMessage, ModelRequest, ModelRole, ModelRoleConfig } from "./index.js";

type JsonObject = Record<string, unknown>;

export type CodexAppServerEvent = { method: string; params: JsonObject };

export type CodexThreadStartParams = {
  model: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  approvalPolicy: "never" | "on-request";
  baseInstructions?: string;
  developerInstructions?: string;
};

export type CodexTurnStartParams = {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
  model: string;
  effort?: string;
  cwd?: string;
  signal?: AbortSignal;
};

export type CodexAppServerSession = {
  startThread(params: CodexThreadStartParams): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  streamTurn(params: CodexTurnStartParams): AsyncIterable<CodexAppServerEvent>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  close(): Promise<void>;
};

export type CodexAppServerSessionFactory = () => Promise<CodexAppServerSession>;

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

  [Symbol.asyncIterator](): AsyncIterableIterator<CodexAppServerEvent> { return this; }
}

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
      const result = await this.request("turn/start", {
        threadId: params.threadId,
        input: params.input,
        model: params.model,
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
      }, params.signal);
      const turn = getObject(result, "turn");
      turnId = getString(turn, "id");
      if (!turnId) throw new Error("Codex App Server returned turn/start without a turn id");
      if (params.signal) {
        const onAbort = () => { void this.interrupt(params.threadId, turnId!).catch(() => undefined); };
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
    await this.request("initialize", {
      clientInfo: { name: this.options.clientName, version: this.options.clientVersion },
    }, undefined, this.options.startupTimeoutMs);
    this.initialized = true;
  }

  private request(method: string, params: JsonObject, signal?: AbortSignal, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("Codex App Server process is not running"));
    if (signal?.aborted) return Promise.reject(createAbortError());
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      let removeAbortListener: (() => void) | undefined;
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
      removeAbortListener = signal ? () => signal.removeEventListener("abort", onAbort) : undefined;
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
    const event: CodexAppServerEvent = { method: message.method, params: message.params as JsonObject };
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

export class CodexAppServerGateway implements ModelGateway {
  private readonly sessions = new Map<string, CodexAppServerSession>();
  private readonly resumedThreads = new Set<string>();
  private readonly sessionFactory: CodexAppServerSessionFactory;
  private readonly providerThreads = new Map<string, string>();

  constructor(private readonly options: CodexAppServerGatewayOptions) {
    this.sessionFactory = options.sessionFactory ?? (async () => new CodexAppServerClient({
      command: options.command ?? "codex",
      args: options.args ?? ["app-server", "--stdio"],
      cwd: options.cwd ?? process.cwd(),
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      maxRestarts: options.maxRestarts ?? 3,
      clientName: options.clientName ?? "pipeline-factory",
      clientVersion: options.clientVersion ?? "3.0.0",
    }));
  }

  configFor(role: ModelRole): ModelRoleConfig { return this.options.roles[role]; }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    try {
      const session = await this.getSession(request.conversationId ?? request.role);
      const roleConfig = this.configFor(request.role);
      let providerThreadId = request.providerThreadId ?? (request.conversationId ? this.providerThreads.get(request.conversationId) : undefined);
      if (providerThreadId) {
        if (!this.resumedThreads.has(providerThreadId)) {
          await session.resumeThread(providerThreadId);
          this.resumedThreads.add(providerThreadId);
        }
      } else {
        providerThreadId = await session.startThread({
          model: roleConfig.model,
          cwd: request.cwd ?? process.cwd(),
          sandbox: request.role === "explorer" ? "read-only" : "workspace-write",
          approvalPolicy: request.role === "explorer" ? "never" : "on-request",
          ...(systemInstructions(request.messages) ? { baseInstructions: systemInstructions(request.messages) } : {}),
          ...(roleConfig.developerInstructions ? { developerInstructions: roleConfig.developerInstructions } : {}),
        });
        if (request.conversationId) this.providerThreads.set(request.conversationId, providerThreadId);
        yield { type: "thread.started", threadId: providerThreadId };
      }
      const text = latestUserMessage(request.messages);
      for await (const event of session.streamTurn({
        threadId: providerThreadId,
        input: [{ type: "text", text }],
        model: roleConfig.model,
        ...(roleConfig.reasoningEffort ? { effort: roleConfig.reasoningEffort } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        const mapped = mapCodexEvent(event);
        if (mapped) yield mapped;
      }
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) yield { type: "turn.cancelled" };
      else yield { type: "turn.failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    const sessions = [...new Set(this.sessions.values())];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  private async getSession(key: string): Promise<CodexAppServerSession> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const session = await this.sessionFactory();
    this.sessions.set(key, session);
    return session;
  }
}

function mapCodexEvent(event: CodexAppServerEvent): ModelEvent | null {
  if (event.method === "item/agentMessage/delta") {
    const text = getString(event.params, "delta");
    return text === undefined ? null : { type: "text.delta", text };
  }
  if (event.method !== "turn/completed") return null;
  const turn = getObject(event.params, "turn");
  const status = getString(turn, "status");
  if (status === "interrupted") return { type: "turn.cancelled" };
  if (status === "failed") {
    const turnError = getObject(turn, "error");
    return { type: "turn.failed", error: getString(turnError, "message") ?? "Codex turn failed" };
  }
  return { type: "turn.completed" };
}

function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? messages.at(-1)?.content ?? "Continue.";
}

function systemInstructions(messages: ModelMessage[]): string {
  return messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}

function getObject(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== "object") return {};
  const candidate = (value as JsonObject)[key];
  return candidate && typeof candidate === "object" ? candidate as JsonObject : {};
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as JsonObject)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function getEventTurnId(params: JsonObject): string | undefined {
  return getString(params, "turnId") ?? getString(getObject(params, "turn"), "id");
}

function createAbortError(): Error {
  const error = new Error("Codex App Server request was cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
