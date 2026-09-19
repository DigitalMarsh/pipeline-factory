// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { CodexRateLimitsStatus } from "../types";
import ProviderUsageFooter from "./ProviderUsageFooter.vue";

function mountFooter() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(defineComponent({
    setup() {
      return () => h(ProviderUsageFooter, {
        model: "gpt-5.6-luna",
        context: "1,234 tokens",
        contextNote: "provider exact",
      });
    },
  }));
  app.mount(host);
  return { app, host };
}

function mockRateLimits(rateLimits: CodexRateLimitsStatus = {
  available: true,
  fiveHour: { remainingPercent: 81, resetAt: "2026-09-19T12:00:00.000Z" },
  sevenDay: { remainingPercent: 79, resetAt: "2026-09-22T12:00:00.000Z" },
  reason: null,
}) {
  vi.spyOn(api, "codexRateLimits").mockResolvedValue({ rateLimits });
}

async function settleRateLimits(): Promise<void> {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ProviderUsageFooter", () => {
  it("renders thread-specific model and Context alongside inline limits", async () => {
    mockRateLimits();
    const mounted = mountFooter();
    await settleRateLimits();

    expect(mounted.host.querySelector(".provider-usage-fact")?.textContent).toContain("gpt-5.6-luna");
    expect(mounted.host.textContent).toContain("1,234 tokens");
    expect(mounted.host.textContent).toContain("provider exact");
    expect(mounted.host.querySelector(".provider-usage-limits")).not.toBeNull();
    expect(mounted.host.querySelector(".provider-usage-status-trigger")).toBeNull();
    expect(mounted.host.querySelector(".provider-usage-popover")).toBeNull();

    mounted.app.unmount();
  });

  it("renders the two account-level limits directly without repeated thread facts", async () => {
    mockRateLimits({
      available: true,
      fiveHour: { remainingPercent: 77, resetAt: "2026-09-19T12:00:00.000Z" },
      sevenDay: { remainingPercent: 66, resetAt: "2026-09-22T12:00:00.000Z" },
      reason: null,
    });
    const mounted = mountFooter();
    await settleRateLimits();

    const limits = mounted.host.querySelectorAll(".provider-usage-limit");
    expect(limits).toHaveLength(2);
    const fiveHour = limits.item(0);
    const sevenDay = limits.item(1);
    expect(fiveHour).not.toBeNull();
    expect(sevenDay).not.toBeNull();
    expect(fiveHour?.textContent).toContain("5 小时限额");
    expect(fiveHour?.textContent).toContain("剩余 77%");
    expect(fiveHour?.textContent).toContain("重置时间: 09-19 12:00");
    expect(fiveHour?.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-19T12:00:00.000Z");
    expect(sevenDay?.textContent).toContain("7 天限额");
    expect(sevenDay?.textContent).toContain("剩余 66%");
    expect(sevenDay?.textContent).toContain("重置时间: 09-22 12:00");
    expect(mounted.host.textContent).not.toContain("会话/对话串");
    expect(mounted.host.querySelector(".provider-usage-status-trigger")).toBeNull();

    mounted.app.unmount();
  });

  it("keeps unavailable rate-limit telemetry explicit", async () => {
    mockRateLimits({ available: false, fiveHour: null, sevenDay: null, reason: "未提供精确限额" });
    const mounted = mountFooter();
    await settleRateLimits();

    expect(mounted.host.textContent).toContain("Unavailable");
    expect(mounted.host.textContent).toContain("Not provided");
    expect(mounted.host.querySelector(".provider-usage-limits")?.getAttribute("title")).toContain("未提供精确限额");

    mounted.app.unmount();
  });
});
