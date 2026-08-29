export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" | undefined }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaX?: number | undefined; deltaY?: number | undefined };

export type ComputerUseScreenshot = {
  mediaType: string;
  data: string;
};

export interface ComputerUseHostAdapter {
  screenshot(signal?: AbortSignal): Promise<ComputerUseScreenshot>;
  perform(action: Exclude<ComputerUseAction, { type: "screenshot" }>, signal?: AbortSignal): Promise<unknown>;
  cancel?(requestId: string, reason: string): Promise<void>;
}

export type ComputerUseEvent = {
  type: "requested" | "approved" | "denied" | "started" | "completed" | "failed" | "cancelled";
  requestId: string;
  action: ComputerUseAction["type"];
  reason?: string | undefined;
};

export type ComputerUseBridgeOptions = {
  adapter: ComputerUseHostAdapter;
  enabled?: boolean;
  requireApproval?: boolean;
  approve?: (action: ComputerUseAction) => Promise<boolean>;
  timeoutMs?: number;
  onEvent?: (event: ComputerUseEvent) => void;
};

export class ComputerUseBridge {
  private readonly active = new Map<string, AbortController>();
  private readonly enabled: boolean;
  private readonly requireApproval: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly options: ComputerUseBridgeOptions) {
    this.enabled = options.enabled === true;
    this.requireApproval = options.requireApproval !== false;
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 120_000, 600_000));
  }

  async call(input: { action: ComputerUseAction; requestId?: string; timeoutMs?: number }): Promise<unknown> {
    const requestId = input.requestId ?? "computer-use-" + Date.now().toString(36);
    this.emit({ type: "requested", requestId, action: input.action.type });
    if (!this.enabled) {
      this.emit({ type: "denied", requestId, action: input.action.type, reason: "Computer Use is disabled by host policy" });
      throw new Error("Computer Use is disabled by host policy");
    }
    if (this.requireApproval) {
      const approved = await this.options.approve?.(input.action);
      if (approved !== true) {
        this.emit({ type: "denied", requestId, action: input.action.type, reason: "User approval is required for Computer Use" });
        throw new Error("User approval is required for Computer Use");
      }
    }
    this.emit({ type: "approved", requestId, action: input.action.type });
    const controller = new AbortController();
    this.active.set(requestId, controller);
    const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? this.timeoutMs, 600_000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.emit({ type: "started", requestId, action: input.action.type });
    try {
      const operation = input.action.type === "screenshot"
        ? this.options.adapter.screenshot(controller.signal)
        : this.options.adapter.perform(input.action, controller.signal);
      const result = await raceAbort(operation, controller.signal, requestId);
      this.emit({ type: "completed", requestId, action: input.action.type });
      return result;
    } catch (error) {
      const reason = controller.signal.aborted ? "Computer Use action timed out or was cancelled" : error instanceof Error ? error.message : String(error);
      this.emit({ type: controller.signal.aborted ? "cancelled" : "failed", requestId, action: input.action.type, reason });
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
      this.active.delete(requestId);
    }
  }

  async cancel(requestId: string, reason = "user_cancelled"): Promise<void> {
    const controller = this.active.get(requestId);
    controller?.abort();
    await this.options.adapter.cancel?.(requestId, reason);
  }

  private emit(event: ComputerUseEvent): void {
    this.options.onEvent?.(event);
  }
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal, requestId: string): Promise<T> {
  if (signal.aborted) throw new Error("Computer Use action " + requestId + " was cancelled");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Computer Use action " + requestId + " was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
