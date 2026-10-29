// @vitest-environment jsdom
/**
 * 测试职责：推理块只有两种合法形态——有正文的可折叠块、没有正文的一行说明。
 *
 * 重点锁住：运行中默认展开；空正文且 Provider 报过时说明「未提供正文」；没有 Provider 标记的
 * 空正文不摆一个点开是空白的折叠区；正文经过脱敏。
 */
import { createApp, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ChatReasoningRow from "./ChatReasoningRow.vue";

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => {
  mounted.splice(0).forEach(({ app, host }) => {
    app.unmount();
    host.remove();
  });
});

type ReasoningProps = {
  body: string;
  running: boolean;
  meta?: string | null;
  unreadableLabel?: string | null;
  label?: string;
};

function mount(props: ReasoningProps) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ChatReasoningRow, props) });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

describe("ChatReasoningRow", () => {
  it("有正文：可折叠块，运行中默认展开", () => {
    const host = mount({ body: "先看现有的活动", running: true });

    const details = host.querySelector("details.chat-reasoning") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(true);
    expect(host.querySelector("summary")?.textContent).toContain("推理");
    expect(host.querySelector(".chat-reasoning-body")?.textContent).toContain("先看现有的活动");
  });

  it("有正文但已结束：默认收起，仍可展开", () => {
    const host = mount({ body: "先看现有的活动", running: false });

    const details = host.querySelector("details.chat-reasoning") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("没有正文且 Provider 报过：一行「推理 · 未提供正文」，不摆折叠区", () => {
    const host = mount({ body: "", running: false, unreadableLabel: "未提供正文" });

    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector(".chat-reasoning-inline")?.textContent?.replace(/\s+/g, " ").trim()).toBe("推理 · 未提供正文");
  });

  it("没有正文也没有 Provider 标记：只写「推理」，不编句子", () => {
    const host = mount({ body: "", running: false });

    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe("推理");
  });

  it("正文经过脱敏与截断", () => {
    const host = mount({ body: "token=abc123 看看这个", running: false });

    const text = host.querySelector(".chat-reasoning-body")?.textContent ?? "";
    expect(text).toContain("token=[REDACTED]");
    expect(text).not.toContain("abc123");
  });
});
