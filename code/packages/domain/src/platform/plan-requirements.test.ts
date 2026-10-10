/**
 * 测试职责：锁住注入 Explorer 的 Plan 协议指令里那条"会让用户走进死路"的规则——
 *   仓库改动的需求不得把 CONVERSATION 标成推荐。
 *
 * 设计说明：提示词是契约的一部分（模型据此选产物模式），所以按源码断言锁住关键句，
 *   与 areas / artifactModes 的声明做交叉检查；不做模型调用。
 * 维护提示：改 EXPLORER_PLAN_INSTRUCTIONS 措辞时同步这里的字符串；删掉那句就等于规则消失。
 */
import { describe, expect, it } from "vitest";
import { EXPLORER_PLAN_INSTRUCTIONS, EXPLORER_PLAN_REQUIREMENTS } from "./plan-requirements.js";

describe("EXPLORER_PLAN_INSTRUCTIONS", () => {
  it("禁止把 CONVERSATION 标成推荐，并说明它确认后仍不可执行", () => {
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("不得把 CONVERSATION 标成");
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("确认后仍不能入队");
  });

  it("描述里出现 artifactModes 声明过的每一种产物模式", () => {
    for (const mode of EXPLORER_PLAN_REQUIREMENTS.artifactModes) expect(EXPLORER_PLAN_INSTRUCTIONS).toContain(mode.mode);
    expect(EXPLORER_PLAN_REQUIREMENTS.artifactModes.find((mode) => mode.mode === "CONVERSATION")?.executable).toBe(false);
  });

  /**
   * 探索侧跑在**只读沙箱**里，而模型不会自动知道这件事——它是撞出来的。
   *
   * 实测（需求16）：Codex 探索线程跑
   * `... && git diff --check && (cd code && npm run build)`，前两步（纯读）成功，
   * 最后那句让 vite 往 `node_modules/.vite-temp/` 写临时配置文件，被沙箱拒绝：
   * `EPERM: operation not permitted`。**这是设计**（`sandbox: "read-only"` +
   * `approvalPolicy: "never"`，见 `model/codex-app-server.ts`），失败也不影响最终结果
   * （那轮照样产出了判定为 READY 的方案）——但每次探索都要交一遍这趟学费，不该如此。
   *
   * 所以这句必须留在指令里：它把"必然失败"从**撞出来的经验**变成**读得到的规则**。
   */
  it("说明探索环境是只读的，不要跑会写盘的命令", () => {
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("运行环境是只读的");
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("不要运行会产生写盘或构建产物的命令");
    // 只读手段那句不能写成"跑 git 命令"：Claude 侧的探索角色**根本没有 Bash**
    // （见 claude-agent-sdk.ts 的 ROLE_TOOLS.explorer），指一条不存在的路比不说更糟。
    expect(EXPLORER_PLAN_INSTRUCTIONS).toContain("查证现状用只读手段");
  });
});
