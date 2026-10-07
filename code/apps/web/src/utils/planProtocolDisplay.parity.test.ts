/**
 * 测试职责：钉住 Plan 协议解析的**两份实现给出相同结论**。
 *
 * 为什么会有两份：领域层要把活动摘要落库（`explorer-activity.ts` 的 `formatPlanActivity`），
 *   web 又必须在**流式**期间自己解析一遍（活动摘要要等回合结束才落库）。而 web 不能运行时依赖
 *   领域层——那会把整个领域打进浏览器包——所以这是一对**必要的镜像**，不是重复代码。
 *
 * 代价是两边会各自漂移，而这次漂移的后果是：领域层那份只认 V1 形状（顶层 `goal`），
 *   于是每一份方案都被判为非法、活动摘要写成"结构化计划校验失败，请继续完善。"——
 *   web 那份当时也错，所以没有一方能暴露另一方。这个文件用同一批夹具同时喂给两边，
 *   任何一边改了判定都会在这里红。
 */
import { describe, expect, it } from "vitest";
import { projectExplorerActivity } from "@pipeline-factory/domain";
import { parsePlanProtocolDisplay } from "./planProtocolDisplay";

/** 领域层的活动投影要一堆持久化事实才能跑；这里只造跑通所需的最小集合。 */
function domainActivitySummary(content: string): { summary: string; details: Record<string, unknown> | null } {
  const items = projectExplorerActivity({
    turns: [
      {
        id: "assistant-1",
        threadId: "explorer-1",
        role: "assistant",
        content: "",
        status: "COMPLETED",
        createdAt: "2026-10-01T00:00:00.000Z",
        sequence: 1,
      },
    ],
    loops: [
      {
        id: "loop-1",
        ownerType: "explorer-turn",
        ownerId: "assistant-1",
        role: "explorer",
        mode: "provider-controlled",
        state: "COMPLETED",
        stepCount: 1,
        maxSteps: 40,
        startedAt: "2026-10-01T00:00:00.000Z",
        completedAt: "2026-10-01T00:00:02.000Z",
        providerThreadId: null,
        providerTurnId: null,
        checkpointJson: null,
      },
    ],
    steps: [
      {
        loopId: "loop-1",
        sequence: 1,
        stepType: "MODEL_TEXT_DELTA",
        status: "COMPLETED",
        callId: null,
        providerThreadId: null,
        providerTurnId: null,
        payload: { text: content },
        occurredAt: "2026-10-01T00:00:01.000Z",
      },
    ],
  });
  const item = items.find((candidate) => candidate.kind === "ASSISTANT_MESSAGE");
  return { summary: item?.summary ?? "", details: (item?.details as Record<string, unknown> | null) ?? null };
}

const artifact = {
  schemaVersion: 2,
  title: "需求5：修复现有项目添加任务时所属项目不合法",
  artifact: { mode: "REPOSITORY_FILE", path: "doc/需求5-任务归属修复方案.md" },
  objective: {
    goal: "修复新增任务未传递所属项目 ID 的问题",
    audience: ["使用者"],
    acceptanceCriteria: ["缺失时返回 400", "不存在时返回 404"],
    outOfScope: ["不重构列表页"],
  },
  design: { technicalConstraints: [], dataSecurity: [], failureHandling: [] },
  scope: { includePaths: ["code/src/App.vue", "code/server/routes/tasks.js", "doc/**"], excludePaths: ["code/data/**", "node_modules/**"] },
  tasks: [{ id: "task-1", title: "新增项目级任务创建接口", dependencies: [] }],
  dependencies: [],
  conflicts: [],
  execution: {},
  verification: { mode: "PROJECT_DEFAULT" },
  merge: { strategy: "manual", requireHumanMerge: true },
};

const artifactV1 = {
  title: "Personal information manager",
  goal: "Build a local single-user personal information manager",
  acceptanceCriteria: ["User can create records", "Data is encrypted at rest"],
  include: ["apps/web", "apps/api"],
  exclude: ["deploy/*"],
  tasks: [{ id: "task-1", title: "Implement record management", dependencies: [] }],
  verificationCommandIds: ["project.test"],
};

function protocol(spec: unknown): string {
  return `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(spec)}</pipeline-factory-plan>`;
}

describe("Plan 协议解析：领域层与 web 两份实现一致", () => {
  it.each([{ name: "当前形状的契约", content: protocol(artifact) }])("$name：两边都判为 READY，且摘要字段相同", ({ content }) => {
    const domain = domainActivitySummary(content);
    const web = parsePlanProtocolDisplay(content);

    expect(domain.details?.status).toBe("READY");
    expect(web.kind).toBe("ready");
    if (web.kind !== "ready") return;
    expect({
      title: domain.details?.title,
      goal: domain.details?.goal,
      includeCount: domain.details?.includeCount,
      excludeCount: domain.details?.excludeCount,
      taskCount: domain.details?.taskCount,
      acceptanceCount: domain.details?.acceptanceCount,
      verificationCount: domain.details?.verificationCount,
    }).toEqual({
      title: web.title,
      goal: web.goal,
      includeCount: web.includeCount,
      excludeCount: web.excludeCount,
      taskCount: web.taskCount,
      acceptanceCount: web.acceptanceCount,
      verificationCount: web.verificationCount,
    });
    expect(domain.summary).toContain(`完整执行方案已生成：${web.title}`);
  });

  it.each([
    {
      name: "JSON 非法",
      content: "<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad}</pipeline-factory-plan>",
    },
    { name: "缺目标字段", content: protocol({ title: "只有标题" }) },
    // V1 扁平契约已经不再支持：两边都必须判非法。留在这张表里是为了钉住"两份实现结论一致"——
    // 它是**唯一**一条覆盖"历史上曾经合法的形状"的夹具。
    { name: "V1 扁平契约（已不再支持）", content: protocol(artifactV1) },
  ])("$name：两边都判为非法，提示语一致", ({ content }) => {
    const domain = domainActivitySummary(content);
    const web = parsePlanProtocolDisplay(content);

    expect(domain.details?.status).toBe("INVALID");
    expect(web.kind).toBe("invalid");
    expect(domain.summary).toContain("结构化计划校验失败，请继续完善。");
    if (web.kind === "invalid") expect(web.text).toContain("结构化计划校验失败，请继续完善。");
  });

  it("还在流式（没有闭合块）时两边都判为「正在整理」", () => {
    const content = '<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{"title":"Personal';
    const domain = domainActivitySummary(content);
    const web = parsePlanProtocolDisplay(content);

    expect(domain.details?.status).toBe("GENERATING");
    expect(web.kind).toBe("generating");
  });

  it("没有协议标签时两边都原样透传", () => {
    const domain = domainActivitySummary("普通消息");
    const web = parsePlanProtocolDisplay("普通消息");

    expect(domain.summary).toBe("普通消息");
    expect(domain.details).toBeNull();
    expect(web).toEqual({ kind: "plain", text: "普通消息" });
  });
});
