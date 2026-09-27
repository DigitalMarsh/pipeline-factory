/**
 * 模块职责：Run 执行线程的遥测（telemetry）只读投影 `projectRunThreadTelemetry`。
 *
 * 维护提示 —— **这条投影只补历史数据的缺口，不回写旧数据、不估算 token。**
 *   `telemetry_json` 是先有 Run 后有该字段的，老 Run 里是 null；这里按
 *   "thread.telemetry 已有值 → Revision 快照里的 executor 模型配置 → executor Loop 的起止时间"
 *   逐级回退，算出一个可展示的 telemetry 挂在返回的 thread 上。
 *
 *   回退顺序本身是契约：**existing 优先**。反过来（先用快照/推算值覆盖）会把已经记录过的
 *   真实模型与用量替换成推算值，且不会报错——那正是"看起来在工作、数据是错的"这一类 bug。
 *
 *   同理，`durationMs` 只在起止时间都存在时才算，`usageSource` 缺省写 `"not-recorded"`
 *   而不是 `"estimated"`：**不猜**是这条投影的语义。
 */
import type { ExecutionTelemetry, ExecutionThread, PipelineStore } from "@pipeline-factory/domain";

/** 为没有 telemetry_json 的历史 Run 提供只读投影；不会回写旧数据或估算 token。 */
export function projectRunThreadTelemetry(store: PipelineStore, run: { id: string; planId: string; planRevision: number }, thread: ExecutionThread): ExecutionThread {
  const revision = store.getRevision(run.planId, run.planRevision);
  const loop = store.listAgentLoops(run.id).find((item) => item.role === "executor");
  const executorConfig = revision?.projectConfigSnapshot?.settings.models.executor;
  const existing = thread.telemetry;
  const startedAt = existing?.startedAt ?? loop?.startedAt ?? null;
  const completedAt = existing?.completedAt ?? loop?.completedAt ?? null;
  const durationMs = existing?.durationMs ?? (startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null);
  const telemetry: ExecutionTelemetry = {
    model: existing?.model ?? executorConfig?.model ?? null,
    reasoningEffort: existing?.reasoningEffort ?? executorConfig?.reasoningEffort ?? null,
    startedAt,
    completedAt,
    durationMs,
    usage: existing?.usage ?? null,
    usageSource: existing?.usageSource ?? "not-recorded",
    usageScope: existing?.usageScope ?? null,
  };
  return { ...thread, telemetry };
}
