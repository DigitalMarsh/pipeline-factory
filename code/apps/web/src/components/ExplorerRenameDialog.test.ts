// @vitest-environment jsdom
/**
 * 测试职责：改名对话框的骨架——预填+聚焦、空名拒绝、trim、保存中禁用、取消关闭。
 *
 * 它还兼一个职责：**线程改名与需求改名共用这一份**，差别只在 `copy`（几个字）。所以这里也要证
 * "字是 copy 说了算"，否则共用的代价就变成"两处文案各自猜"。
 */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ExplorerRenameDialog from "./ExplorerRenameDialog.vue";

type RenameCopy = { eyebrow: string; heading: string; fieldLabel: string; hint: string; submitLabel: string };

const THREAD_COPY: RenameCopy = {
  eyebrow: "线程操作",
  heading: "重命名线程",
  fieldLabel: "线程名称",
  hint: "新名字会出现在探索视图的标题与线程列表里。",
  submitLabel: "保存名称",
};

const REQUIREMENT_COPY: RenameCopy = {
  eyebrow: "需求操作",
  heading: "重命名需求",
  fieldLabel: "需求名称",
  hint: "新名字只改这条需求的显示名。",
  submitLabel: "保存名称",
};

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () =>
      props.modelValue ? h("div", { class: "explorer-rename-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

function mountDialog(
  props: { modelValue?: boolean; initialValue?: string; copy?: RenameCopy; saving?: boolean; error?: string | null } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const submitted: string[] = [];
  const app = createApp(ExplorerRenameDialog, {
    modelValue: props.modelValue ?? true,
    initialValue: props.initialValue ?? "Original thread",
    copy: props.copy ?? THREAD_COPY,
    saving: props.saving ?? false,
    error: props.error ?? null,
    "onUpdate:modelValue": (value: boolean) => updates.push(value),
    onSubmit: (value: string) => submitted.push(value),
  });
  app.component("ElDialog", ElDialogStub);
  app.component("ElButton", ElButtonStub);
  app.mount(host);
  return { app, host, updates, submitted };
}

function buttonByText(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("ExplorerRenameDialog", () => {
  it("prefills the value and focuses the input when opened", async () => {
    const mounted = mountDialog({ initialValue: "  Current thread  " });
    await nextTick();
    await nextTick();

    const input = mounted.host.querySelector<HTMLInputElement>('input[aria-label="线程名称"]');
    expect(input?.value).toBe("  Current thread  ");
    expect(document.activeElement).toBe(input);
    expect(input?.maxLength).toBe(200);

    mounted.app.unmount();
  });

  it("rejects blank names and trims submitted names", async () => {
    const mounted = mountDialog();
    const input = mounted.host.querySelector<HTMLInputElement>('input[aria-label="线程名称"]');
    if (!input) throw new Error("rename input was not rendered");

    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    mounted.host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(mounted.submitted).toEqual([]);
    expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain("线程名称不能为空");

    input.value = "  Renamed thread  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    buttonByText(mounted.host, "保存名称")?.click();
    await nextTick();

    expect(mounted.submitted).toEqual(["Renamed thread"]);

    mounted.app.unmount();
  });

  it("**字是 copy 说了算**：同一份骨架换成「需求」，标题、字段名、空名提示全跟着走", async () => {
    const mounted = mountDialog({ copy: REQUIREMENT_COPY, initialValue: "旧名字" });
    const input = mounted.host.querySelector<HTMLInputElement>('input[aria-label="需求名称"]');
    expect(mounted.host.textContent).toContain("需求操作");
    expect(mounted.host.textContent).toContain("重命名需求");
    expect(mounted.host.textContent).toContain("新名字只改这条需求的显示名。");
    expect(input).not.toBeNull();

    input!.value = "  ";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    mounted.host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain("需求名称不能为空");

    mounted.app.unmount();
  });

  it("disables controls while saving and closes on cancel", async () => {
    const saving = mountDialog({ saving: true });
    expect(saving.host.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect([...saving.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    saving.app.unmount();

    const mounted = mountDialog();
    buttonByText(mounted.host, "取消")?.click();
    await nextTick();
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
  });
});
