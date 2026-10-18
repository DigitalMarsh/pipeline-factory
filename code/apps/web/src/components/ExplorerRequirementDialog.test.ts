// @vitest-environment jsdom
/**
 * 测试职责：「新增需求」对话框的**输入契约**——什么时候能提交、提交出去的是什么、快捷键的边界、
 * 以及出错的展示方式。
 *
 * 这里不测"建需求"本身：那一步在 ExplorerView（`createRequirement`）里，这个组件只负责
 * 收集一段纯文本并用 `submit` 交出去。
 */
import { createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExplorerRequirementDialog from "./ExplorerRequirementDialog.vue";

// jsdom 没有 object URL；对话框只是用它做本地预览，替换成常量即可。
Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:requirement-preview"), configurable: true, writable: true });
Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });

const ElDialogStub = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () =>
      props.modelValue ? h("div", { class: "requirement-dialog" }, [slots.header?.(), slots.default?.(), slots.footer?.()]) : null;
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

function mountDialog(props: { modelValue?: boolean; threadTitle?: string; saving?: boolean; error?: string | null } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const submitted: string[] = [];
  const submittedFiles: File[][] = [];
  const visibility: boolean[] = [];
  createApp(ExplorerRequirementDialog, {
    modelValue: props.modelValue ?? true,
    threadTitle: props.threadTitle ?? "20261001-10:40:52-添加甘特图展示进度",
    saving: props.saving ?? false,
    error: props.error ?? null,
    onSubmit: (description: string, files: File[]) => {
      submitted.push(description);
      submittedFiles.push(files);
    },
    "onUpdate:modelValue": (value: boolean) => visibility.push(value),
  })
    .component("el-dialog", ElDialogStub)
    .component("el-button", ElButtonStub)
    .mount(host);
  return { host, submitted, submittedFiles, visibility };
}

function textarea(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>("textarea")!;
}

function submitButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-requirement-dialog-action="submit"]')!;
}

async function type(host: HTMLElement, value: string): Promise<void> {
  const input = textarea(host);
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

/** 模拟在描述框里粘贴一张图：粘贴事件从 textarea 冒泡到 AttachmentComposer。 */
async function pasteImage(host: HTMLElement, file: File): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { files: File[] } };
  event.clipboardData = { files: [file] };
  textarea(host).dispatchEvent(event);
  await nextTick();
  await nextTick();
}

describe("新增需求对话框", () => {
  it("空的描述提交不了：按钮禁用，快捷键也不发", async () => {
    const { host, submitted } = mountDialog();
    expect(submitButton(host).disabled).toBe(true);

    // 纯空白同样不算"填了"——判据只有 canSubmit 一处。
    await type(host, "   \n  ");
    expect(submitButton(host).disabled).toBe(true);

    textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(submitted).toEqual([]);
  });

  it("提交的是**去掉首尾空白**的那段文本", async () => {
    const { host, submitted } = mountDialog();
    await type(host, "  添加任务时提示所属项目不合法，希望归属到当前项目。  ");
    expect(submitButton(host).disabled).toBe(false);

    submitButton(host).click();
    expect(submitted).toEqual(["添加任务时提示所属项目不合法，希望归属到当前项目。"]);
  });

  it("`⌘/Ctrl + Enter` 提交，**单独 Enter 不提交**——多行描述要能换行", async () => {
    const { host, submitted } = mountDialog();
    await type(host, "第一行\n第二行");

    textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submitted).toEqual([]);

    textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(submitted).toEqual(["第一行\n第二行"]);
  });

  it("错误写在对话框里，而不是弹个会消失的提示", () => {
    const { host } = mountDialog({ error: "新建需求失败：500" });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("新建需求失败：500");
  });

  it("粘贴的截图随 submit 一起交出去，并在提交后清空本地预览", async () => {
    const { host, submitted, submittedFiles } = mountDialog();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    await pasteImage(host, file);
    await type(host, "按这张截图修一下");

    expect(host.querySelectorAll("[data-attachment-key]")).toHaveLength(1);
    submitButton(host).click();
    await nextTick();

    expect(submitted).toEqual(["按这张截图修一下"]);
    expect(submittedFiles).toHaveLength(1);
    expect(submittedFiles[0]!.map((item) => item.name)).toEqual(["shot.png"]);
    // File 引用已经交出去，预览应清空——否则发送失败后重试会重复带图。
    expect(host.querySelectorAll("[data-attachment-key]")).toHaveLength(0);
  });

  it("提交中：按钮禁用、**关不掉**（否则请求还在飞、对话框已经没了）", async () => {
    const { host, visibility } = mountDialog({ saving: true });
    expect(submitButton(host).disabled).toBe(true);

    // 取消按钮点下去也不该关。
    host.querySelector<HTMLButtonElement>(".requirement-dialog-footer-actions button")!.click();
    expect(visibility).toEqual([]);
  });

  it("标题旁写的是**所属线程**（容器），不是「加到某条需求」——它新建的是需求，不是并进去", () => {
    const { host } = mountDialog({ threadTitle: "20261001-10:40:52-添加甘特图展示进度" });
    const chip = host.querySelector(".requirement-dialog-thread");
    expect(chip?.textContent).toContain("所属线程");
    expect(chip?.textContent).toContain("20261001-10:40:52-添加甘特图展示进度");
    expect(host.querySelector(".requirement-dialog-footer-hint")?.textContent).toContain("新建");
  });
});
