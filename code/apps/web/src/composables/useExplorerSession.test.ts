/**
 * 测试职责：锁住会话状态容器与**项目切换的请求令牌守卫**。
 *
 * 设计说明：composable 不用生命周期钩子，直接调用即可（无需组件、无需 jsdom）。
 * 状态 fixture 一律用**形状桩**（`as unknown as X`）——本 composable 只负责"存放与清空"
 * 这几份数据，从不读它们的字段，所以桩不会掩盖任何行为；要测数据语义请去
 * `utils/` 的配对测试或用到这些字段的 composable 测试。
 *
 * 维护提示：守卫的两条判据（令牌未过期 / 路由项目未切换）必须**分别**有用例。
 * 只留一条的实现在测试里会全绿，但在"路由已变、令牌尚未重签"的窗口里会放行过期响应——
 * 那是本文件要防的唯一一类真 bug。
 */
import { ref } from "vue";
import { describe, expect, it } from "vitest";
import type { ExplorerActivityItem, ExplorerThread, ExplorerTurn, Project, Run } from "../types";
import { useExplorerSession } from "./useExplorerSession";

const project = (id: string) => ({ id } as unknown as Project);
const thread = (id: string) => ({ id } as unknown as ExplorerThread);
const turn = (id: string) => ({ id } as unknown as ExplorerTurn);
const activity = (id: string) => ({ id } as unknown as ExplorerActivityItem);
const run = (id: string) => ({ id } as unknown as Run);

function setup(initialProjectId = "project-1") {
  const projectId = ref(initialProjectId);
  const session = useExplorerSession({ projectId });
  return { ...session, projectId };
}

describe("请求令牌守卫", () => {
  it("新签发的令牌在当前项目下有效", () => {
    const s = setup();
    const token = s.beginProjectScope("project-1");

    expect(s.isCurrentProjectScope("project-1", token)).toBe(true);
    expect(s.projectScopeToken()).toBe(token);
  });

  it("作废之后旧令牌不再有效", () => {
    const s = setup();
    const token = s.beginProjectScope("project-1");
    s.invalidateProjectScope();

    expect(s.isCurrentProjectScope("project-1", token)).toBe(false);
  });

  it("再次签发令牌后，旧令牌失效、新令牌有效", () => {
    const s = setup();
    const first = s.beginProjectScope("project-1");
    const second = s.beginProjectScope("project-1");

    expect(second).not.toBe(first);
    expect(s.isCurrentProjectScope("project-1", first)).toBe(false);
    expect(s.isCurrentProjectScope("project-1", second)).toBe(true);
    expect(s.projectScopeToken()).toBe(second);
  });

  it("令牌尚未过期、但路由上的项目已经切换时不放行", () => {
    // 这是本文件存在的理由：项目切换时路由先变、新令牌后签，
    // 中间这个窗口里旧令牌在 requestScope 看仍是有效的。
    const s = setup("project-1");
    const token = s.beginProjectScope("project-1");
    s.projectId.value = "project-2";

    expect(s.isCurrentProjectScope("project-1", token)).toBe(false);
  });

  it("在另一个项目下签发的令牌，拿到本项目来校验不放行", () => {
    const s = setup("project-2");
    const token = s.beginProjectScope("project-1");

    expect(s.isCurrentProjectScope("project-2", token)).toBe(false);
    expect(s.isCurrentProjectScope("project-1", token)).toBe(false);
  });

  it("不传令牌时默认用当前令牌", () => {
    const s = setup();
    const token = s.beginProjectScope("project-1");

    expect(s.isCurrentProjectScope("project-1")).toBe(true);
    s.invalidateProjectScope();
    expect(s.isCurrentProjectScope("project-1")).toBe(false);
    // `invalidate` 只让"当前令牌"过期，**不会改写它**：`projectScopeToken()` 仍返回 1，
    // 只是 `requestScope.isCurrent(1, …)` 从此为假。改名/改值的实现会让
    // "发起时捕获令牌、返回后比对"这条既有写法失效，所以这里把现值锁住。
    expect(s.projectScopeToken()).toBe(token);
  });

  it("尚未签发过任何令牌时，默认令牌不放行", () => {
    // 初始 activeRequestToken 为 0，而 requestScope 里没有活动项目。
    const s = setup();

    expect(s.isCurrentProjectScope("project-1")).toBe(false);
  });
});

describe("resetSessionState", () => {
  it("清空线程级字段", () => {
    const s = setup();
    s.thread.value = thread("explorer-1");
    s.turns.value = [turn("t1")];
    s.activity.value = [activity("a1")];

    s.resetSessionState();

    expect(s.thread.value).toBeNull();
    expect(s.turns.value).toEqual([]);
    expect(s.activity.value).toEqual([]);
  });

  it("不动项目级字段——切线程时左侧目录必须留着", () => {
    const s = setup();
    s.project.value = project("project-1");
    s.projects.value = [project("project-1")];
    s.explorers.value = [thread("explorer-1")];
    s.projectRuns.value = [run("run-1")];
    s.thread.value = thread("explorer-1");
    s.turns.value = [turn("t1")];
    s.activity.value = [activity("a1")];

    s.resetSessionState();

    expect(s.project.value?.id).toBe("project-1");
    expect(s.projects.value.map((item) => item.id)).toEqual(["project-1"]);
    expect(s.explorers.value.map((item) => item.id)).toEqual(["explorer-1"]);
    expect(s.projectRuns.value.map((item) => item.id)).toEqual(["run-1"]);
    // 只有 thread / turns / activity 被清掉。
    expect(s.thread.value).toBeNull();
    expect(s.turns.value).toEqual([]);
    expect(s.activity.value).toEqual([]);
  });
});
