// @vitest-environment jsdom
import { createApp, defineComponent, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ProviderUsageFooter from "./ProviderUsageFooter.vue";

function mountFooter() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({
    setup() {
      return () => h(ProviderUsageFooter, {
        model: "claude-opus-5",
        context: "1,234 tokens",
        contextNote: "provider exact",
      });
    },
  }));
  app.mount(host);
  return { app, host };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProviderUsageFooter", () => {
  it("renders the thread's model and context facts", () => {
    const mounted = mountFooter();

    expect(mounted.host.querySelector(".provider-usage-fact")?.textContent).toContain("claude-opus-5");
    expect(mounted.host.textContent).toContain("1,234 tokens");
    expect(mounted.host.textContent).toContain("provider exact");

    mounted.app.unmount();
  });

  it("renders no account-level quota at all", () => {
    // 5 小时 / 7 天额度已从页面与后端两侧移除（唯一数据源是 Codex 的账号额度接口）。
    // 这条断言防的是"顺手把面板加回来"：本组件不该再有任何按账号的窗口。
    const mounted = mountFooter();

    expect(mounted.host.querySelector(".provider-usage-limits")).toBeNull();
    expect(mounted.host.querySelectorAll(".provider-usage-limit")).toHaveLength(0);
    expect(mounted.host.textContent).not.toContain("限额");
    expect(mounted.host.textContent).not.toContain("剩余");

    mounted.app.unmount();
  });
});
