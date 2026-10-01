/**
 * 测试职责：验证 planProtocolDisplay 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 *
 * **两套 fixture 不是冗余**：`artifact`（V1 形状）与 `artifactV2`（当前形状）各有一组用例。
 * 这个文件曾经只有 V1 夹具，于是解析器只认 V1 这件事一直没被测出来——线上表现是**每一份 V2 方案**
 * 都被判为非法并显示"结构化计划校验失败，请继续完善。"（详见 artifactV2 上方的说明）。
 */
import { describe, expect, it } from "vitest";
import { parsePlanProtocolDisplay, readableAssistantText } from "./planProtocolDisplay";

const artifact = {
  title: "Personal information manager",
  goal: "Build a local single-user personal information manager",
  acceptanceCriteria: ["User can create records", "Data is encrypted at rest"],
  include: ["apps/web", "apps/api"],
  exclude: ["deploy/*"],
  tasks: [{ id: "task-1", title: "Implement record management", dependencies: [], status: "READY" }],
  verificationCommandIds: ["project.test"],
};

/**
 * **V2 是当前形状**，字段取自一次真实输出（需求5，`agent_loop_steps` 里拼回的 MODEL_TEXT_DELTA）：
 * 目标在 `objective.goal`、范围在 `scope.includePaths`、验证只声明 `mode`（命令 ID 由 Factory 解析，
 * 模型不填）。复现的缺陷是：解析器只查顶层 `goal`，于是这份合法方案被判为"校验失败"——
 * 而同一屏下方紧跟着 PLAN CREATED 卡片，页面自相矛盾。
 */
const artifactV2 = {
  schemaVersion: 2,
  title: "需求5：修复现有项目添加任务时所属项目不合法",
  artifact: { mode: "REPOSITORY_FILE", path: "doc/需求5-任务归属修复方案.md" },
  objective: {
    goal: "修复现有项目详情中新增任务因未传递所属项目 ID 而被服务端判为不合法的问题",
    audience: ["项目使用者"],
    acceptanceCriteria: ["缺少项目 ID 时返回 400 VALIDATION_ERROR", "项目不存在时返回 404 NOT_FOUND"],
    outOfScope: ["不重构任务列表页"],
  },
  design: { technicalConstraints: [], dataSecurity: [], failureHandling: [] },
  scope: { includePaths: ["code/src/App.vue", "code/server/routes/tasks.js", "doc/**"], excludePaths: ["code/data/**", "node_modules/**"] },
  tasks: [
    { id: "task-1", title: "新增项目级任务创建接口并迁移任务归属校验", dependencies: [] },
    { id: "task-2", title: "修改前端任务创建调用以使用当前项目 ID", dependencies: ["task-1"] },
  ],
  dependencies: ["需要在 code/ 目录使用仓库现有 package.json 安装依赖。"],
  conflicts: [],
  execution: {},
  verification: { mode: "PROJECT_DEFAULT" },
  merge: { strategy: "manual", requireHumanMerge: true },
};

describe("plan protocol display", () => {
  it("turns a complete READY protocol into a readable summary", () => {
    const result = parsePlanProtocolDisplay(`方案已整理完成。\n<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>\n<pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`);

    expect(result).toEqual({
      kind: "ready",
      prose: "方案已整理完成。",
      title: "Personal information manager",
      goal: "Build a local single-user personal information manager",
      includeCount: 2,
      excludeCount: 1,
      taskCount: 1,
      acceptanceCount: 2,
      verificationCount: 1,
    });
  });

  it("**当前的 V2 形状同样渲染为可执行方案**（回归：曾经每一份 V2 方案都显示「校验失败」）", () => {
    const result = parsePlanProtocolDisplay(`已补充功能范围与排除项。\n<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>\n<pipeline-factory-plan>${JSON.stringify(artifactV2)}</pipeline-factory-plan>`);

    expect(result).toEqual({
      kind: "ready",
      prose: "已补充功能范围与排除项。",
      title: "需求5：修复现有项目添加任务时所属项目不合法",
      goal: "修复现有项目详情中新增任务因未传递所属项目 ID 而被服务端判为不合法的问题",
      includeCount: 3,
      excludeCount: 2,
      taskCount: 2,
      acceptanceCount: 2,
      // 模型只声明 mode，命令 ID 由 Factory 解析——所以这里是 0，不是"没解析出来"。
      verificationCount: 0,
    });
  });

  it("V2 的助手文本也接上标题，而不是退回「校验失败」", () => {
    const content = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(artifactV2)}</pipeline-factory-plan>`;

    expect(readableAssistantText(content)).toBe("完整执行方案已生成：需求5：修复现有项目添加任务时所属项目不合法");
  });

  it("V2 夹具确实不含 V1 的顶层字段——否则上面那条回归是假的", () => {
    expect("goal" in artifactV2).toBe(false);
    expect("include" in artifactV2).toBe(false);
    expect("acceptanceCriteria" in artifactV2).toBe(false);
  });

  it("两种形状都缺目标时才算非法（V1 的顶层 goal 与 V2 的 objective.goal 都不在）", () => {
    const noGoal = parsePlanProtocolDisplay('<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"只有标题"}</pipeline-factory-plan>');

    expect(noGoal.kind).toBe("invalid");
  });

  it("hides an incomplete protocol while it is still streaming", () => {
    const result = parsePlanProtocolDisplay(`<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"Personal`);

    expect(result.kind).toBe("generating");
    if (result.kind === "generating") {
      expect(result.text).not.toContain("pipeline-factory-plan");
      expect(result.text).not.toContain("{\"title\"");
    }
  });

  it("hides malformed protocol content without affecting ordinary text", () => {
    const invalid = parsePlanProtocolDisplay("前置说明 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad}</pipeline-factory-plan>");
    const plain = parsePlanProtocolDisplay("普通消息：请选择你偏好的实现方式。");

    expect(invalid).toMatchObject({ kind: "invalid", text: "前置说明 结构化计划校验失败，请继续完善。" });
    if (invalid.kind === "invalid") expect(invalid.text).not.toContain("{bad}");
    expect(plain).toEqual({ kind: "plain", text: "普通消息：请选择你偏好的实现方式。" });
  });
});

describe("助手消息的可读文本", () => {
  it("READY 时把方案标题接在正文后面", () => {
    const content = '先说两句 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"接入登录","goal":"g"}</pipeline-factory-plan>';

    expect(readableAssistantText(content)).toBe("先说两句 完整执行方案已生成：接入登录");
  });

  it("只有协议没有正文时只留提示句，不留多余空格", () => {
    const content = '<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"接入登录","goal":"g"}</pipeline-factory-plan>';

    expect(readableAssistantText(content)).toBe("完整执行方案已生成：接入登录");
  });

  it("普通消息原样返回", () => {
    expect(readableAssistantText("普通消息")).toBe("普通消息");
  });

  it("生成中与校验失败都回退到展示对象自带的提示语", () => {
    expect(readableAssistantText("说明 <pipeline-factory-plan-status>GENERATING</pipeline-factory-plan-status>")).toBe("说明 正在整理结构化计划…");
    expect(readableAssistantText("说明 <pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad}</pipeline-factory-plan>")).toBe("说明 结构化计划校验失败，请继续完善。");
  });
});
