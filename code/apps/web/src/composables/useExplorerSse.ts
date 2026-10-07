/**
 * 模块职责：Explorer 页面的三条 SSE 通道——需求 Turn、需求状态、Agent Loop——以及
 * 建连 / 断连生命周期。它只负责传输事件与把事件交给已存在的状态/刷新回调，
 * 不拥有 Plan 投影、输入请求或会话令牌的状态。
 *
 * 维护提示：
 * 1. `projectScopeToken` / `isCurrentProjectScope` 与每条连接捕获的 thread / plan id 是
 *    SSE 回调的双重竞态守卫；项目、线程或当前需求任一变化，旧帧都必须丢弃。
 * 2. `explorerEventSequence` 从 `usePlanProjection` 以 ref 传入：本文件只读它来构造
 *    续传 URL，绝不写游标。workspace / activity 的写侧与 reset 仍归投影 composable。
 * 3. `turn.input_required` 不能用列表第一个 OPEN 请求代替 payload 指定的 requestId，
 *    通过 `adoptInputRequest` 收口到输入请求 composable 的唯一过渡态接缝。
 * 4. `closeEvents` 不关闭 requirement-status 通道——原有调用方会按项目执行模式 / 卸载
 *    单独调用 `closeRequirementStatusEvents`，两者的生命周期不能合并。
 * 5. 轮询刷新只做节流：Turn 文本 delta 仍即时合并到 turns，终态 / 输入 / Plan 事件
 *    仍按原语义立即回查；不要把业务投影逻辑塞进 EventSource handler。
 */
import { nextTick, type Ref } from "vue";
import { api } from "../api";
import type { AgentLoop, ExplorerInputRequest, ExplorerPlan, ExplorerThread, ExplorerTurn } from "../types";
import { createSseReplayGate } from "../utils/sseReplayGate";
import { scrollTimelineToLatest } from "../utils/scrollTimeline";
import { PROJECTION_REFRESH_INTERVAL_MS } from "./usePlanProjection";

export type ExplorerSseDeps = {
  projectId: Ref<string>;
  thread: Ref<ExplorerThread | null>;
  explorers: Ref<ExplorerThread[]>;
  activeExplorerPlan: Ref<ExplorerPlan | null>;
  explorerPlans: Ref<ExplorerPlan[]>;
  turns: Ref<ExplorerTurn[]>;
  agentLoop: Ref<AgentLoop | null>;
  explorerPaused: Ref<boolean>;
  explorerEventSequence: Ref<number | null>;
  timeline: Ref<HTMLElement | null>;
  projectScopeToken: () => number;
  isCurrentProjectScope: (requestProjectId: string, requestToken?: number) => boolean;
  refreshActivity: () => Promise<void>;
  refreshPlanProjection: () => Promise<void>;
  scheduleProjectionRefresh: () => void;
  cancelProjectionRefresh: () => void;
  adoptInputRequest: (requestId: string | null, items: ExplorerInputRequest[]) => void;
  load: () => Promise<boolean>;
};

const AGENT_LOOP_IMMEDIATE_REFRESH_EVENTS = new Set(["agent.step.gate_checked", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required", "agent.loop.paused", "agent.loop.resumed", "agent.input.required", "agent.input.resolved"]);

export function useExplorerSse(deps: ExplorerSseDeps) {
  let eventSource: EventSource | null = null;
  let loopEventSource: EventSource | null = null;
  let requirementStatusEventSource: EventSource | null = null;
  let requirementStatusScope: { projectId: string; threadId: string } | null = null;
  let loopRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function refreshTurnsAfterEvent() {
    if (!deps.thread.value) return;
    const explorerPlanId = deps.activeExplorerPlan.value?.id;
    if (!explorerPlanId) return;
    const requestProjectId = deps.projectId.value;
    const requestThreadId = deps.thread.value.id;
    const requestToken = deps.projectScopeToken();
    const response = await api.getExplorerTurns(requestProjectId, requestThreadId, explorerPlanId);
    if (!deps.isCurrentProjectScope(requestProjectId, requestToken) || deps.thread.value?.id !== requestThreadId || deps.activeExplorerPlan.value?.id !== explorerPlanId) return;
    deps.turns.value = response.items;
    await deps.refreshActivity();
    await deps.refreshPlanProjection();
    const inputResponse = await api.inputRequests(requestProjectId, requestThreadId, explorerPlanId);
    if (!deps.isCurrentProjectScope(requestProjectId, requestToken) || deps.thread.value?.id !== requestThreadId || deps.activeExplorerPlan.value?.id !== explorerPlanId) return;
    deps.adoptInputRequest(null, inputResponse.items);
    await nextTick();
    if (deps.timeline.value) scrollTimelineToLatest(deps.timeline.value);
  }

  function connectEvents() {
    if (!deps.thread.value || !deps.activeExplorerPlan.value || typeof EventSource === "undefined") return;
    connectRequirementStatusEvents();
    const connectionProjectId = deps.projectId.value;
    const connectionThreadId = deps.thread.value.id;
    const connectionPlanId = deps.activeExplorerPlan.value.id;
    const connectionToken = deps.projectScopeToken();
    const isConnectionCurrent = () => deps.isCurrentProjectScope(connectionProjectId, connectionToken) && deps.thread.value?.id === connectionThreadId && deps.activeExplorerPlan.value?.id === connectionPlanId;
    eventSource?.close();
    loopEventSource?.close();
    const replayGate = createSseReplayGate();
    if (deps.explorerEventSequence.value !== null) replayGate.markReady();
    eventSource = new EventSource(api.explorerEventsUrl(connectionProjectId, connectionThreadId, connectionPlanId, deps.explorerEventSequence.value ?? undefined));
    eventSource.addEventListener("stream.ready", () => {
      if (!isConnectionCurrent()) return;
      replayGate.accept("stream.ready");
      void refreshTurnsAfterEvent();
    });
    eventSource.addEventListener("turn.text.delta", (raw) => {
      if (!isConnectionCurrent() || !replayGate.accept("turn.text.delta")) return;
      const payload = JSON.parse((raw as MessageEvent).data) as { turnId: string; text: string };
      const current = deps.turns.value.find((turn) => turn.id === payload.turnId);
      if (current) deps.turns.value = deps.turns.value.map((turn) => turn.id === payload.turnId ? { ...turn, content: turn.content + payload.text, status: "RUNNING" } : turn);
      deps.scheduleProjectionRefresh();
    });
    eventSource.addEventListener("turn.input_required", async (raw) => {
      if (!isConnectionCurrent() || !replayGate.accept("turn.input_required")) return;
      const payload = JSON.parse((raw as MessageEvent).data) as { requestId: string };
      const response = await api.inputRequests(connectionProjectId, connectionThreadId, connectionPlanId);
      if (!isConnectionCurrent()) return;
      deps.adoptInputRequest(payload.requestId, response.items);
      void deps.refreshPlanProjection();
    });
    eventSource.addEventListener("title.updated", (raw) => {
      if (!isConnectionCurrent() || !replayGate.accept("title.updated")) return;
      const payload = JSON.parse((raw as MessageEvent).data) as { explorerId: string; title: string; titleStatus: ExplorerThread["titleStatus"] };
      if (payload.explorerId !== connectionThreadId || !deps.thread.value) return;
      deps.thread.value = { ...deps.thread.value, title: payload.title, titleStatus: payload.titleStatus };
      deps.explorers.value = deps.explorers.value.map((item) => item.id === payload.explorerId ? { ...item, title: payload.title, titleStatus: payload.titleStatus } : item);
    });
    for (const eventName of ["turn.accepted", "turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.input.resolved", "plan.ready"]) eventSource.addEventListener(eventName, () => { if (!isConnectionCurrent() || !replayGate.accept(eventName)) return; void refreshTurnsAfterEvent(); });
    for (const eventName of ["plan.created", "plan.renamed"]) eventSource.addEventListener(eventName, () => { if (!isConnectionCurrent() || !replayGate.accept(eventName)) return; void deps.refreshPlanProjection(); });
    eventSource.addEventListener("thread.state.changed", () => { if (!isConnectionCurrent() || !replayGate.accept("thread.state.changed")) return; closeEvents(); void deps.load().then((loaded) => { if (loaded) connectEvents(); }); });
    connectLoopEvents();
  }

  function connectRequirementStatusEvents() {
    if (!deps.thread.value || typeof EventSource === "undefined") return;
    const connectionProjectId = deps.projectId.value;
    const connectionThreadId = deps.thread.value.id;
    if (requirementStatusEventSource && requirementStatusScope?.projectId === connectionProjectId && requirementStatusScope.threadId === connectionThreadId) return;
    closeRequirementStatusEvents();
    const connectionToken = deps.projectScopeToken();
    const source = new EventSource(api.explorerRequirementStatusEventsUrl(connectionProjectId, connectionThreadId, deps.explorerEventSequence.value ?? undefined));
    requirementStatusEventSource = source;
    requirementStatusScope = { projectId: connectionProjectId, threadId: connectionThreadId };
    source.addEventListener("requirement.status", (raw) => {
      if (requirementStatusEventSource !== source || !deps.isCurrentProjectScope(connectionProjectId, connectionToken) || deps.thread.value?.id !== connectionThreadId) return;
      const payload = JSON.parse((raw as MessageEvent).data) as { explorerPlanId: string; turnId: string | null; status: NonNullable<ExplorerPlan["runtimeStatus"]>; occurredAt: string };
      if (!deps.explorerPlans.value.some((plan) => plan.id === payload.explorerPlanId && plan.explorerThreadId === connectionThreadId)) return;
      deps.explorerPlans.value = deps.explorerPlans.value.map((plan) => plan.id === payload.explorerPlanId ? { ...plan, runtimeStatus: payload.status, lastActivityAt: payload.occurredAt } : plan);
    });
  }

  function connectLoopEvents() {
    if (!deps.agentLoop.value || typeof EventSource === "undefined") return;
    const connectionProjectId = deps.projectId.value;
    const connectionThreadId = deps.thread.value?.id;
    const connectionToken = deps.projectScopeToken();
    const loopId = deps.agentLoop.value.id;
    loopEventSource?.close();
    const replayGate = createSseReplayGate();
    loopEventSource = new EventSource(api.agentLoopEventsUrl(loopId));
    loopEventSource.addEventListener("stream.ready", () => { replayGate.accept("stream.ready"); });
    for (const eventName of ["agent.loop.started", "agent.step.started", "agent.step.model_text_delta", "agent.step.tool_requested", "agent.step.tool_completed", "agent.step.tool_denied", "agent.step.tool_failed", "agent.step.tool_needs_reconciliation", "agent.step.input_required", "agent.step.input_resolved", "agent.step.context_compacted", "agent.step.gate_checked", "agent.provider.activity", "agent.input.required", "agent.input.resolved", "agent.loop.paused", "agent.loop.resumed", "agent.loop.completed", "agent.loop.failed", "agent.loop.cancelled", "agent.loop.recovery_required"]) {
      // 状态与门禁事件立即刷新；步骤级事件（文本增量、工具活动）合并到固定间隔，避免每个事件都拉取 Loop。
      const immediate = AGENT_LOOP_IMMEDIATE_REFRESH_EVENTS.has(eventName);
      loopEventSource.addEventListener(eventName, () => {
        if (!deps.isCurrentProjectScope(connectionProjectId, connectionToken) || deps.thread.value?.id !== connectionThreadId || !replayGate.accept(eventName)) return;
        const refresh = () => {
          void api.agentLoop(loopId).then(async (response) => {
            if (!deps.isCurrentProjectScope(connectionProjectId, connectionToken) || deps.thread.value?.id !== connectionThreadId || deps.agentLoop.value?.id !== loopId) return;
            deps.agentLoop.value = response.loop;
            deps.explorerPaused.value = response.loop.state === "PAUSED";
            await deps.refreshActivity();
            if (immediate) await deps.refreshPlanProjection();
          }).catch(() => undefined);
        };
        if (immediate) { cancelLoopRefresh(); refresh(); return; }
        if (loopRefreshTimer !== null) return;
        loopRefreshTimer = setTimeout(() => { loopRefreshTimer = null; refresh(); }, PROJECTION_REFRESH_INTERVAL_MS);
      });
    }
  }

  function connectLoopEventsIfConnected() {
    if (eventSource) connectLoopEvents();
  }

  function cancelLoopRefresh() {
    if (loopRefreshTimer === null) return;
    clearTimeout(loopRefreshTimer);
    loopRefreshTimer = null;
  }

  function closeRequirementStatusEvents() { requirementStatusEventSource?.close(); requirementStatusEventSource = null; requirementStatusScope = null; }
  function closeEvents() { eventSource?.close(); loopEventSource?.close(); eventSource = null; loopEventSource = null; deps.cancelProjectionRefresh(); cancelLoopRefresh(); }

  return { connectEvents, connectRequirementStatusEvents, connectLoopEvents, connectLoopEventsIfConnected, closeEvents, closeRequirementStatusEvents };
}
