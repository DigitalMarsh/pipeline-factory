/**
 * 模块职责：Run 执行线程的遥测（telemetry）只读投影 —— `projectRunThreadTelemetry`，
 *   以及两者共用的"这次 Run 用的 executor 配置"解析 `resolveRunExecutorConfig`。
 *
 * 维护提示 —— **这条投影只补历史数据的缺口，不回写旧数据、不估算 token。**
 *   `telemetry_json` 是先有 Run 后有该字段的，老 Run 里是 null；这里按
 *   "thread.telemetry 已有值 → Revision 快照里的 executor 模型配置 → executor Loop 的起止时间"
 *   逐级回退，算出一个可展示的 telemetry 挂在返回的 thread 上。
 *
 *   回退顺序本身是契约：**existing 优先**。反过来（先用快照/推算值覆盖）会把已经记录过的
 *   真实模型与用量替换成推算值，且不会报错——那正是"看起来在工作、数据是错的"这一类 bug。
 *
 *   2) **`existing` 有的字段必须原样带过去**，重建对象时要逐个写全。本文件踩过一次：
 *      `backend`（这次 Run 由哪个 agent 执行）就在重建时被漏掉——库里明明记着
 *      `codex-app-server`，界面上"AGENT"一栏永远显示"未记录"。新增遥测字段时，
 *      先问"它在 existing 里吗、我搬了吗"。
 *
 *   3) `resolveRunExecutorConfig` 是**唯一**回答"这次 Run 该用哪个 executor"的地方：
 *      先看 Revision 快照（执行时真正冻结的那份），再回退当前项目设置。界面在"这一轮还没
 *      跑完、没有本次记录"时要靠它回答"现在用的是什么模型"，所以它必须与投影同源。
 *
 *   4) 同理，`durationMs` 只在起止时间都存在时才算，`usageSource` 缺省写 `"not-recorded"`
 *      而不是 `"estimated"`：**不猜**是这条投影的语义。
 */
import type { ExecutionTelemetry, ExecutionThread, PipelineStore } from "@pipeline-factory/domain";

export type RunExecutorConfig = { model: string | null; backend: string | null; reasoningEffort: string | null };

/**
 * 这次 Run 的 executor 配置：**Revision 快照优先**（Plan Confirm 时冻结、执行真正用的那份），
 * 没有快照（老数据）才回退当前项目设置。两者都没有时返回 null —— 不编造模型名。
 */
export function resolveRunExecutorConfig(store: PipelineStore, run: { planId: string; planRevision: number; projectId?: string | undefined }): RunExecutorConfig | null {
  const snapshot = store.getRevision(run.planId, run.planRevision)?.projectConfigSnapshot?.settings.models.executor;
  const current = run.projectId ? store.getProject(run.projectId)?.settings.models.executor : undefined;
  const executor = snapshot ?? current;
  if (!executor) return null;
  return { model: executor.model, backend: executor.backend ?? null, reasoningEffort: executor.reasoningEffort ?? null };
}

/** 为没有 telemetry_json 的历史 Run 提供只读投影；不会回写旧数据或估算 token。 */
export function projectRunThreadTelemetry(store: PipelineStore, run: { id: string; planId: string; planRevision: number; projectId?: string | undefined }, thread: ExecutionThread): ExecutionThread {
  const loop = store.listAgentLoops(run.id).find((item) => item.role === "executor");
  const executorConfig = resolveRunExecutorConfig(store, run);
  const existing = thread.telemetry;
  const startedAt = existing?.startedAt ?? loop?.startedAt ?? null;
  const completedAt = existing?.completedAt ?? loop?.completedAt ?? null;
  const durationMs = existing?.durationMs ?? (startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null);
  const telemetry: ExecutionTelemetry = {
    model: existing?.model ?? executorConfig?.model ?? null,
    reasoningEffort: existing?.reasoningEffort ?? executorConfig?.reasoningEffort ?? null,
    // **冻结配置写了后端时以它为准**，虽然它与上面两行是反过来的优先级。理由是这一格的来源不同：
    // `backend` 只由 `agent.loop.started` 的端点指纹写入，而那个指纹是**配置推导**的、不是 Provider
    // 上报的（见 agent-loop.ts 的 emit 与 executor-agent.ts 的 updateTelemetry），所以"Plan 确认时
    // 冻结的那份配置"才是路由真正用的那个后端。`existing.backend` 则是在指纹只吃角色名的那段
    // 时间里按**全局角色默认**算出来的——项目覆盖了执行侧后端时它就是错的（现场：冻结与项目
    // 都写 claude-agent-sdk，2026-10-07 那条 Run 的记录却写 codex-app-server，用量栏据此显示
    // "Agent Codex App Server"而模型显示 claude-opus-5）。`model` 没有这个问题：它取自
    // `effectiveModelConfig`，项目覆盖当时就已经生效了。
    // 冻结配置没写后端（跟随全局）时，才轮到指纹回答"那时全局是哪个"。
    backend: executorConfig?.backend ?? existing?.backend ?? null,
    startedAt,
    completedAt,
    durationMs,
    usage: existing?.usage ?? null,
    usageSource: existing?.usageSource ?? "not-recorded",
    usageScope: existing?.usageScope ?? null,
  };
  return { ...thread, telemetry };
}
