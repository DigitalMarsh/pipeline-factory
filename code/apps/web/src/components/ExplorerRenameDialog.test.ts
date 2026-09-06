// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ExplorerRenameDialog from "./ExplorerRenameDialog.vue";

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => props.modelValue ? h("div", { class: "explorer-rename-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
  },
});

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button", disabled: props.disabled }, slots.default?.());
  },
});

function mountDialog(props: { modelValue?: boolean; initialTitle?: string; saving?: boolean; error?: string | null } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const updates: boolean[] = [];
  const submitted: string[] = [];
  const app = createApp(ExplorerRenameDialog, {
    modelValue: props.modelValue ?? true,
    initialTitle: props.initialTitle ?? "Original thread",
    saving: props.saving ?? false,
    error: props.error ?? null,
    "onUpdate:modelValue": (value: boolean) => updates.push(value),
    onSubmit: (title: string) => submitted.push(title),
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
  it("prefills the title and focuses the input when opened", async () => {
    const mounted = mountDialog({ initialTitle: "  Current thread  " });
    await nextTick();
    await nextTick();

    const input = mounted.host.querySelector<HTMLInputElement>('input[aria-label="Thread name"]');
    expect(input?.value).toBe("  Current thread  ");
    expect(document.activeElement).toBe(input);
    expect(input?.maxLength).toBe(200);

    mounted.app.unmount();
  });

  it("rejects blank names and trims submitted names", async () => {
    const mounted = mountDialog();
    const input = mounted.host.querySelector<HTMLInputElement>('input[aria-label="Thread name"]');
    if (!input) throw new Error("rename input was not rendered");

    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    mounted.host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(mounted.submitted).toEqual([]);
    expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain("Thread name is required");

    input.value = "  Renamed thread  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    buttonByText(mounted.host, "Save name")?.click();
    await nextTick();

    expect(mounted.submitted).toEqual(["Renamed thread"]);

    mounted.app.unmount();
  });

  it("disables controls while saving and closes on cancel", async () => {
    const saving = mountDialog({ saving: true });
    expect(saving.host.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    expect([...saving.host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
    saving.app.unmount();

    const mounted = mountDialog();
    buttonByText(mounted.host, "Cancel")?.click();
    await nextTick();
    expect(mounted.updates).toEqual([false]);

    mounted.app.unmount();
  });
});
