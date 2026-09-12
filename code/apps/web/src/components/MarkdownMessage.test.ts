/**
 * 测试职责：验证 MarkdownMessage 的渲染结果与流式节流表现。
 * 设计说明：沿用仓库既有的 createApp 挂载方式，不引入额外的测试依赖。
 * 维护提示：组件 props 或流式指示变化时，应同步调整这些场景。
 */
// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarkdownMessage from "./MarkdownMessage.vue";

function mountMessage(source: Ref<string>, streaming: Ref<boolean>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({ setup: () => () => h(MarkdownMessage, { source: source.value, streaming: streaming.value }) }));
  app.mount(host);
  return { host, unmount: () => { app.unmount(); host.remove(); } };
}

describe("MarkdownMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders markdown structure instead of raw markers", () => {
    const view = mountMessage(ref("## 问题清单\n\n| # | 位置 |\n| --- | --- |\n| A1 | L32 |"), ref(false));

    expect(view.host.querySelector(".markdown-body h2")?.textContent).toBe("问题清单");
    expect(view.host.querySelector(".markdown-body table")?.textContent).toContain("L32");
    expect(view.host.textContent).not.toContain("---");
    expect(view.host.querySelector(".processing-dots")).toBeNull();

    view.unmount();
  });

  it("shows the streaming indicator while the turn is running", () => {
    const view = mountMessage(ref("正在生成"), ref(true));

    expect(view.host.querySelector(".processing-dots")).not.toBeNull();
    expect(view.host.querySelector(".markdown-body")?.getAttribute("aria-live")).toBe("polite");

    view.unmount();
  });

  it("throttles streaming updates and renders the final text immediately", async () => {
    vi.useFakeTimers();
    const source = ref("第一段");
    const streaming = ref(true);
    const view = mountMessage(source, streaming);
    expect(view.host.textContent).toContain("第一段");

    source.value = "第一段 加长";
    await nextTick();
    expect(view.host.textContent).toContain("第一段 加长");

    source.value = "第一段 加长 继续";
    await nextTick();
    source.value = "第一段 加长 继续 结束";
    await nextTick();
    expect(view.host.textContent).toContain("第一段 加长");

    streaming.value = false;
    await nextTick();
    expect(view.host.textContent).toContain("第一段 加长 继续 结束");
    expect(view.host.querySelector(".processing-dots")).toBeNull();

    view.unmount();
  });
});
