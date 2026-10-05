// @vitest-environment jsdom
/**
 * 测试职责：锁住用量栏的三件事 —— **agent 与模型分开显示**、缺 agent 时不留空占位、
 *   以及"这行值是哪来的"来源说明只在该说的时候出现。
 *
 * 为什么值得挂真实组件测："哪个 agent + 哪个模型 + 上下文占了多少"是排障第一问，而这三格
 *   很容易在改版里悄悄合并或留空。执行页还要靠 `sourceNote` 区分"跑过的记录"与"配置里要用的"——
 *   不标来源就等于把配置当事实展示。
 */
import { createApp, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ProviderUsageFooter from "./ProviderUsageFooter.vue";

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => { mounted.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); }); });

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ProviderUsageFooter, { model: "gpt-5.6-luna", context: "191,197 tokens", ...props }) });
  app.mount(host);
  mounted.push({ app, host });
  return host;
}

describe("ProviderUsageFooter", () => {
  it("keeps agent and model as separate facts", () => {
    const host = mount({ backend: "codex-app-server" });

    expect(host.textContent).toContain("Agent");
    expect(host.textContent).toContain("codex-app-server");
    expect(host.textContent).toContain("模型");
    expect(host.textContent).toContain("gpt-5.6-luna");
    expect(host.textContent).toContain("上下文");
    expect(host.textContent).toContain("191,197 tokens");
  });

  it("drops the agent cell instead of leaving an empty one", () => {
    const host = mount({});

    expect(host.textContent).not.toContain("Agent");
    expect(host.querySelectorAll(".provider-usage-fact")).toHaveLength(2);
  });

  it("only claims a source when the caller says the value did not come from a run", () => {
    expect(mount({}).querySelector(".provider-usage-source")).toBeNull();
    expect(mount({ sourceNote: "按本 Run 冻结的项目配置" }).querySelector(".provider-usage-source")?.textContent).toBe("按本 Run 冻结的项目配置");
  });
});
