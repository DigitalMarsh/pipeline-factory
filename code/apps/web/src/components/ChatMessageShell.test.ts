// @vitest-environment jsdom
/**
 * 测试职责：共享消息壳的三种形态——用户气泡、助手正文、无头像过程行。
 *
 * 这里锁的是**结构和属性落点**：锚点/data 属性必须在根节点上（时间线跳转与执行侧定位都靠它），
 * 用户/助手的左右镜像由 class 决定，不靠调用方各写一份模板。
 */
import { createApp, defineComponent, h, type Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ChatMessageShell from "./ChatMessageShell.vue";

const ElTagStub = defineComponent({
  props: { type: String, size: String, effect: String },
  setup:
    (_props, { slots }) =>
    () =>
      h("span", { class: "el-tag-stub" }, slots.default?.()),
});

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => {
  mounted.splice(0).forEach(({ app, host }) => {
    app.unmount();
    host.remove();
  });
});

function mount(props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ChatMessageShell as Component, props, slots) });
  app.component("el-tag", ElTagStub);
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

describe("ChatMessageShell", () => {
  it("用户消息：镜像网格、气泡、头像「你」、时间在脚注", () => {
    const host = mount(
      { side: "user", avatar: "user", time: "21:32", datetime: "2026-10-29T21:32:00.000Z" },
      { default: () => h("p", "改一下探索范围") },
    );

    const root = host.querySelector(".chat-message")!;
    expect(root.classList.contains("chat-message-user")).toBe(true);
    expect(root.classList.contains("chat-message-bubble")).toBe(true);
    expect(host.querySelector(".chat-avatar")?.textContent?.trim()).toBe("你");
    expect(host.querySelector(".chat-meta")).toBeNull();
    expect(host.querySelector(".chat-foot time")?.textContent).toBe("21:32");
    expect(host.querySelector(".chat-bubble")?.textContent).toContain("改一下探索范围");
  });

  it("助手消息：头像 + meta（名字/状态/时间），正文不套气泡", () => {
    const host = mount(
      {
        side: "assistant",
        avatar: "explorer",
        author: "Plan Explorer",
        statusLabel: "进行中",
        statusType: "warning",
        time: "21:31",
      },
      { default: () => h("p", "正文") },
    );

    expect(host.querySelector(".chat-avatar")?.textContent?.trim()).toBe("探");
    expect(host.querySelector(".chat-author")?.textContent).toBe("Plan Explorer");
    expect(host.querySelector(".chat-meta .el-tag-stub")?.textContent).toBe("进行中");
    expect(host.querySelector(".chat-time")?.textContent).toBe("21:31");
    expect(host.querySelector(".chat-message-bubble")).toBeNull();
  });

  it("过程行：没有头像，内容仍在内容栏（紧凑类）", () => {
    const host = mount({ side: "assistant", compact: true, headline: "工具调用", time: "21:30" }, { default: () => h("p", "Glob") });

    expect(host.querySelector(".chat-avatar")).toBeNull();
    expect(host.querySelector(".chat-message")?.classList.contains("chat-message-process")).toBe(true);
    expect(host.querySelector(".chat-headline")?.textContent).toBe("工具调用");
  });

  it("过程行：类型图标占头像栏，不画角色头像", () => {
    const IconStub = defineComponent({ setup: () => () => h("svg", { class: "stub-icon" }) });
    const host = mount(
      { side: "assistant", compact: true, icon: IconStub, headline: "工具调用", time: "21:30" },
      { default: () => h("p", "Glob") },
    );

    expect(host.querySelector(".chat-avatar")).toBeNull();
    expect(host.querySelector(".chat-process-icon svg.stub-icon")).not.toBeNull();
  });

  it("锚点与外部属性都落在根节点上", () => {
    const host = mount({
      side: "assistant",
      anchorId: "message-1",
      navKey: "message-1",
      "data-sequence": 7,
      title: "Turn #1",
    });

    const root = host.querySelector("article")!;
    expect(root.id).toBe("message-1");
    expect(root.getAttribute("data-nav-key")).toBe("message-1");
    expect(root.getAttribute("data-sequence")).toBe("7");
    expect(root.getAttribute("title")).toBe("Turn #1");
  });
});
