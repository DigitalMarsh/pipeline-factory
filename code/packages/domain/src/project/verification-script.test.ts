/**
 * 测试职责：锁住两套验证脚本预设的**硬约束**（argv 不含空格、脚本自带装依赖、wrapper 优先），
 *   而不是去逐字比对模板文案——模板会改，约束不该改。
 */
import { describe, expect, it } from "vitest";
import { normalizeProjectSettings } from "./project.js";
import { VERIFICATION_SCRIPT_PRESETS, applyVerificationScriptPlan, planVerificationScript } from "./verification-script.js";

describe("验证脚本预设", () => {
  /**
   * 这条不是风格问题：设置页那一栏是"一行文本 ↔ argv"编辑的，参数里含空格就会被切开
   * （引号切分已经修好，但模板没必要去试探它）。`./verify.sh` 与 `--fast` 都不含空格。
   */
  it("每条命令的 argv 里没有一个元素含空格", () => {
    for (const { preset } of VERIFICATION_SCRIPT_PRESETS) {
      for (const command of planVerificationScript(preset).commands) {
        for (const argument of command.argv) {
          expect(argument, `${preset} / ${command.commandId} 的参数「${argument}」含空格`).not.toMatch(/\s/);
        }
      }
    }
  });

  it("两条命令都进默认验证集，便宜的在前", () => {
    const plan = planVerificationScript("vue-vite");
    expect(plan.defaultVerificationCommandIds).toEqual(["project.hygiene", "project.verify"]);
    expect(plan.commands.map((command) => command.commandId)).toEqual(["project.hygiene", "project.verify"]);
    expect(plan.commands[0]?.argv).toEqual(["git", "diff", "--check"]);
    expect(plan.commands[1]?.argv).toEqual(["bash", "-c", "./verify.sh"]);
  });

  it("Vue 预设：先装依赖再构建，--fast 之后才轮到 typecheck / test", () => {
    const script = planVerificationScript("vue-vite").script;
    const position = (needle: string) => {
      const at = script.indexOf(needle);
      expect(at, `脚本里没有「${needle}」`).toBeGreaterThanOrEqual(0);
      return at;
    };
    // 顺序即语义：worktree 里没有 node_modules，所以 ci 必须在 build 之前。
    expect(position("npm ci")).toBeLessThan(position("npm run build"));
    expect(position("npm run build")).toBeLessThan(position("--fast：跳过类型检查与测试"));
    expect(position("--fast：跳过类型检查与测试")).toBeLessThan(position("has_script typecheck"));
    // 用 ci 不用 install：install 可能改写 package-lock.json，而那会被随后的自动提交带走。
    expect(script).toContain("npm ci --no-audit --no-fund");
    expect(script).not.toContain("npm install");
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
  });

  it("Maven 预设：wrapper 优先，--fast 只编译，全量跑测试", () => {
    const script = planVerificationScript("maven").script;
    expect(script).toContain('MVN="./mvnw"');
    expect(script).toContain('[ -x "$MVN" ] || MVN="mvn"');
    expect(script).toContain('"$MVN" -B -q -DskipTests compile');
    expect(script).toContain('"$MVN" -B -q test');
    // 依赖走用户级 ~/.m2，这条脚本不该出现任何装依赖的动作。
    expect(script).not.toContain("npm ci");
  });

  it("子目录写进 DIR；不传就是仓库根", () => {
    expect(planVerificationScript("vue-vite", { subdirectory: "code" }).script).toContain('DIR="code"');
    expect(planVerificationScript("vue-vite").script).toContain('DIR="."');
    // 空白子目录等同于不传。
    expect(planVerificationScript("maven", { subdirectory: "   " }).script).toContain('DIR="."');
  });

  it("未知预设直接抛错，不静默给一份错的模板", () => {
    expect(() => planVerificationScript("gradle" as never)).toThrow(/Unknown verification script preset/);
  });
});

describe("把预设并进项目设置", () => {
  const settingsWith = (input: Parameters<typeof normalizeProjectSettings>[0]) => normalizeProjectSettings(input);

  it("同名命令就地替换，不堆第二条", () => {
    const settings = settingsWith({
      commands: [{ commandId: "project.hygiene", argv: ["true"], category: "verification", enabled: true, timeoutMs: 1000, tags: [] }],
    });
    const merged = applyVerificationScriptPlan(settings, planVerificationScript("vue-vite"));

    expect(merged.commands.filter((command) => command.commandId === "project.hygiene")).toHaveLength(1);
    expect(merged.commands.find((command) => command.commandId === "project.hygiene")?.argv).toEqual(["git", "diff", "--check"]);
    expect(merged.commands.map((command) => command.commandId).sort()).toEqual(["project.hygiene", "project.verify"]);
  });

  it("项目自己已有的命令一条不动", () => {
    const settings = settingsWith({
      commands: [
        { commandId: "project.codegraph-init", argv: ["codegraph", "init"], category: "lifecycle", enabled: true, timeoutMs: 1000 },
      ],
      defaultVerificationCommandIds: [],
    });
    const merged = applyVerificationScriptPlan(settings, planVerificationScript("maven"));

    expect(merged.commands.map((command) => command.commandId)).toContain("project.codegraph-init");
    expect(merged.defaultVerificationCommandIds).toEqual(["project.hygiene", "project.verify"]);
  });

  it("默认验证集：预设那两条前置，项目原有且不重名的留在后面", () => {
    const settings = settingsWith({
      commands: [
        { commandId: "project.docs", argv: ["true"], category: "verification", enabled: true, timeoutMs: 1000, tags: ["docs"] },
        { commandId: "project.verify", argv: ["old"], category: "verification", enabled: true, timeoutMs: 1000 },
      ],
      defaultVerificationCommandIds: ["project.docs", "project.verify"],
    });
    const merged = applyVerificationScriptPlan(settings, planVerificationScript("vue-vite"));

    expect(merged.defaultVerificationCommandIds).toEqual(["project.hygiene", "project.verify", "project.docs"]);
  });
});
