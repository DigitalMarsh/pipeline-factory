/**
 * 模块职责：跨模块的"这个 Plan 还缺哪些已注册的验证命令"判定 —— **唯一出处**。
 *
 * 为什么必须唯一：这条规则原先在三处各写了一遍，而且分成两套不一致的规则：
 *   - run/scheduler.ts 的 assertVerificationCommands 与 PlanService.reviseConfiguration
 *     读的是那份 V1 有损镜像的 `verificationCommandIds`，并把 settings.commands 里**任何**命令都算作已注册；
 *   - PlanDispatchCoordinator.evaluateWait 读已解析契约的 `verification.commandIds`，
 *     且只把 `category === "verification"` 且 `enabled !== false` 的命令算作已注册。
 * 分歧的后果是"同一个 Plan 该不该被拦"取决于**谁先问**：派发前的 evaluateWait 放行，
 * 但 Scheduler.start 里的同名校验抛 `RUN_PREREQUISITES_UNSATISFIED`，最终表现为
 * `WAITING / NEEDS_CONFIGURATION`。典型触发是 `verification.mode: "NONE"`
 * （解析后 commandIds 为空、按设计应当被 SKIPPED 而非被拦）却仍带着一份陈旧的镜像 id。
 *
 * 现在只有一套：**已解析契约是唯一来源**——那份 V1 镜像已经删了，没有第二种读法。
 */
import type { ResolvedPlanContract } from "./plan-spec.js";
import type { RegisteredCommandDefinition } from "../platform/commands.js";

export function missingVerificationCommands(input: {
  resolvedContract: Pick<ResolvedPlanContract, "verification">;
  commands: readonly RegisteredCommandDefinition[];
}): string[] {
  const expected = input.resolvedContract.verification.commandIds;
  const registered = new Set(
    input.commands
      .filter((command) => command.category === "verification" && command.enabled !== false)
      .map((command) => command.commandId),
  );
  return expected.filter((commandId) => !registered.has(commandId));
}
