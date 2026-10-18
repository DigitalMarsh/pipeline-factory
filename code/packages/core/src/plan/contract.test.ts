/**
 * 测试职责：锁住"这个 Plan 还缺哪些已注册验证命令"这条**跨模块判定规则**。
 *
 * 为什么值得单独测一个纯函数：这条规则原先在 run/scheduler.ts、PlanService.reviseConfiguration 与
 *   PlanDispatchCoordinator.evaluateWait 三处各写了一遍，而且分成两套不一致的规则，症状是
 *   "同一个 Plan 该不该被拦取决于谁先问"——派发前放行、启动时抛 RUN_PREREQUISITES_UNSATISFIED。
 *   收敛成一处之后，只有把判定语义钉死，这个"统一"才不会被悄悄放宽或收紧。
 *
 * 现在只有一套：**已解析契约是唯一来源**。V1 的 `verificationCommandIds` 镜像已经删掉，
 * 那份"未启用或非 verification 类别的命令也算已注册"的宽判定也随之消失（见 docs 的 §6 B 类）。
 */
import { describe, expect, it } from "vitest";
import { missingVerificationCommands } from "./contract.js";
import type { RegisteredCommandDefinition } from "../platform/commands.js";

function command(commandId: string, overrides: Partial<RegisteredCommandDefinition> = {}): RegisteredCommandDefinition {
  return { commandId, argv: ["node", "-e", "process.exit(0)"], ...overrides };
}

describe("missingVerificationCommands", () => {
  it("mode 为 NONE（commandIds 为空）时没有任何缺项", () => {
    // 这是原缺陷的现场：mode: "NONE" 按设计应当被 SKIPPED，而不是被拦成 NEEDS_CONFIGURATION。
    // 曾经有一条拿 V1 镜像是问的旁路，会把这种 Plan 判成缺命令。
    const missing = missingVerificationCommands({
      resolvedContract: { verification: { mode: "NONE", commandIds: [] } },
      commands: [],
    });

    expect(missing).toEqual([]);
  });

  it("只把 verification 类别且已启用的命令算作已注册", () => {
    const missing = missingVerificationCommands({
      resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test", "project.lint"] } },
      // project.test 是 verification 且启用 → 已注册；project.lint 同 id 但被停用 → 仍缺。
      commands: [
        command("project.test", { category: "verification", enabled: true }),
        command("project.lint", { category: "verification", enabled: false }),
      ],
    });

    expect(missing).toEqual(["project.lint"]);
  });

  it("同 id 但类别不是 verification 的命令不算已注册", () => {
    const missing = missingVerificationCommands({
      resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.cleanup"] } },
      commands: [command("project.cleanup", { category: "lifecycle", enabled: true })],
    });

    expect(missing).toEqual(["project.cleanup"]);
  });

  it("缺少 category/enabled 字段时按未注册处理", () => {
    // 默认值由 project.ts 的 settings 规范化补成 unclassified/false，所以到达这里时缺字段
    // 只可能来自手工构造的数据——按未注册处理是与规范化后一致的保守选择。
    const missing = missingVerificationCommands({
      resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test"] } },
      commands: [command("project.test")],
    });

    expect(missing).toEqual(["project.test"]);
  });
});
