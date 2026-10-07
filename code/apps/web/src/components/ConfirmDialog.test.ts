// @vitest-environment jsdom
/**
 * 测试职责：确认框的骨架——它只有"确认"与"取消"两种出口、代价写在明面上、忙时关不掉。
 *
 * 为什么值得单独测：它替掉了 `ElMessageBox.confirm`，而后者有个别扭的地方——"取消"与
 * "点右上角 ×"是两个不同的 reject 值，每个调用方都得各写一遍（实测漏写一处就会把"关掉"
 * 当成"确认"）。现在两者都只是把 `modelValue` 置回 false，这条用例把这个性质钉住。
 */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ConfirmDialog from "./ConfirmDialog.vue";

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.modelValue ? h("div", { class: "confirm-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null);
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function mountDialog(
  props: {
    modelValue?: boolean;
    message?: string;
    details?: string[];
    tone?: "danger" | "primary";
    busy?: boolean;
    error?: string | null;
  } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const confirmed: number[] = [];
  const visibility: boolean[] = [];
  createApp(ConfirmDialog, {
    modelValue: props.modelValue ?? true,
    eyebrow: "需求操作",
    heading: "永久删除需求",
    message: props.message ?? "「某条需求」会被永久删除。",
    details: props.details ?? [],
    confirmLabel: "永久删除",
    cancelLabel: "取消",
    tone: props.tone ?? "danger",
    busy: props.busy ?? false,
    error: props.error ?? null,
    onConfirm: () => confirmed.push(1),
    "onUpdate:modelValue": (value: boolean) => visibility.push(value),
  })
    .component("el-dialog", ElDialogStub)
    .component("el-button", ElButtonStub)
    .mount(host);
  return { host, confirmed, visibility };
}

function confirmButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-confirm-dialog-action="confirm"]')!;
}

describe("确认框", () => {
  it("说清对谁做什么，并把连带代价逐条列出来", () => {
    const { host } = mountDialog({
      message: "「修一下归属校验」会被永久删除。",
      details: ["它的结构化 Plan、执行记录与执行日志一起删除，无法恢复", "已结束运行的本地 worktree 不会自动清理"],
    });

    expect(host.querySelector(".confirm-dialog-message")?.textContent).toContain("「修一下归属校验」会被永久删除。");
    const details = [...host.querySelectorAll(".confirm-dialog-details li")].map((li) => li.textContent);
    expect(details).toHaveLength(2);
    expect(details[0]).toContain("无法恢复");
  });

  it("没有连带影响时不渲染那块清单（不摆一个空框）", () => {
    const { host } = mountDialog({ details: [] });
    expect(host.querySelector(".confirm-dialog-details")).toBeNull();
  });

  it("**取消与关闭同义**：两者都只把 modelValue 置回 false，不发 confirm", async () => {
    const { host, confirmed, visibility } = mountDialog();
    expect(confirmed).toEqual([]);

    // 取消按钮
    host.querySelector<HTMLButtonElement>(".confirm-dialog-footer button")!.click();
    await nextTick();
    expect(visibility).toEqual([false]);
    expect(confirmed).toEqual([]);
  });

  it("按下确认才发 confirm——对话框只负责问，做不做是调用方的事", async () => {
    const { host, confirmed } = mountDialog();
    confirmButton(host).click();
    await nextTick();
    expect(confirmed).toEqual([1]);
  });

  it("失败留在框里（role=alert），不是弹个会消失的提示", () => {
    const { host } = mountDialog({ error: "这条需求还有在跑的 Run，先把它停掉再删。" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("先把它停掉");
  });

  it("忙时关不掉、确认也点不动", async () => {
    const { host, confirmed, visibility } = mountDialog({ busy: true });
    expect(confirmButton(host).disabled).toBe(true);

    host.querySelector<HTMLButtonElement>(".confirm-dialog-footer button")!.click();
    await nextTick();
    expect(visibility).toEqual([]);
    expect(confirmed).toEqual([]);
  });
});
