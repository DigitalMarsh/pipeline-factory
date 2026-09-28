/**
 * 测试职责：锁住"这个 Plan 还缺哪些已注册验证命令"这条**跨模块判定规则**。
 *
 * 为什么值得单独测一个纯函数：这条规则原先在 run/scheduler.ts、PlanService.reviseConfiguration 与
 *   PlanDispatchCoordinator.evaluateWait 三处各写了一遍，而且分成两套不一致的规则，症状是
 *   "同一个 Plan 该不该被拦取决于谁先问"——派发前放行、启动时抛 RUN_PREREQUISITES_UNSATISFIED。
 *   收敛成一处的意义只有在两侧语义都被钉住时才成立：既要保住 V2 的严格判定（未启用/非 verification
 *   的命令不算已注册），也要保住 V1 平面的回落行为。漏掉任一侧，这个"统一"就变成了悄悄放宽或收紧。
 *
 * 维护提示：用例按"传入 resolvedContract 与否"两组组织，对应函数里那条三元分支。
 *   新增分支时两侧都要补，只测一边会让另一边的行为无声漂移。
 */
import { describe, expect, it } from "vitest";
import { missingVerificationCommands } from "./contract.js";
import type { RegisteredCommandDefinition } from "../platform/commands.js";

function command(commandId: string, overrides: Partial<RegisteredCommandDefinition> = {}): RegisteredCommandDefinition {
  return { commandId, argv: ["node", "-e", "process.exit(0)"], ...overrides };
}

describe("missingVerificationCommands", () => {
  describe("带 resolvedContract（V2 权威）", () => {
    it("以 V2 解析出的 commandIds 为准，而不是 V1 的镜像字段", () => {
      // 这正是原缺陷的现场：V2 模式为 NONE（commandIds 为空、按设计应被 SKIPPED），
      // 却带着一份陈旧的 V1 镜像 id。以 V1 为准就会把可执行的 Plan 拦成 NEEDS_CONFIGURATION。
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: ["project.test", "project.typecheck"] },
        resolvedContract: { verification: { mode: "NONE", commandIds: [] } },
        commands: [],
      });

      expect(missing).toEqual([]);
    });

    it("只把 verification 类别且已启用的命令算作已注册", () => {
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: [] },
        resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test", "project.lint"] } },
        // project.test 是 verification 且启用 → 已注册；project.lint 同 id 但被停用 → 仍缺。
        commands: [command("project.test", { category: "verification", enabled: true }), command("project.lint", { category: "verification", enabled: false })],
      });

      expect(missing).toEqual(["project.lint"]);
    });

    it("同 id 但类别不是 verification 的命令不算已注册", () => {
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: [] },
        resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.cleanup"] } },
        commands: [command("project.cleanup", { category: "lifecycle", enabled: true })],
      });

      expect(missing).toEqual(["project.cleanup"]);
    });

    it("缺少 category/enabled 字段时按未注册处理", () => {
      // 默认值由 project.ts 的 settings 规范化补成 unclassified/false，所以到达这里时缺字段
      // 只可能来自手工构造的数据——按未注册处理是与规范化后一致的保守选择。
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: [] },
        resolvedContract: { verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test"] } },
        commands: [command("project.test")],
      });

      expect(missing).toEqual(["project.test"]);
    });
  });

  describe("不带 resolvedContract（V1 平面回落）", () => {
    it("以 V1 的 verificationCommandIds 为准", () => {
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: ["project.test", "project.gone"] },
        commands: [command("project.test", { category: "verification", enabled: true })],
      });

      expect(missing).toEqual(["project.gone"]);
    });

    it("保持历史行为：V1 平面下任何已注册命令都算数，不看类别与启用状态", () => {
      // 这是与 V2 分支**有意不同**的一侧：V1 合同没有 resolvedContract 可依据，
      // 收紧它会让旧库里的历史合同突然无法确认。改动这里等于改历史数据的可执行性。
      const missing = missingVerificationCommands({
        contract: { verificationCommandIds: ["project.cleanup"] },
        commands: [command("project.cleanup", { category: "lifecycle", enabled: false })],
      });

      expect(missing).toEqual([]);
    });
  });
});
