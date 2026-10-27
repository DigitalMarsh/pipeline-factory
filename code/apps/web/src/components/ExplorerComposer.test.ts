// @vitest-environment jsdom
/**
 * 测试职责：输入区在"当前需求有回合在跑"时把发送按钮换成「停止」。
 *
 * 这里只锁**按钮位的切换与 emit**：停止请求、停止后的本地状态归视图（`ExplorerView`），
 * 不在这颗按钮里发。发送按钮原有的禁用判据也顺带确认没被换掉。
 */
import { createApp, defineComponent, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ExplorerComposer from "./ExplorerComposer.vue";

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean, type: String, circle: Boolean, plain: Boolean, size: String, text: Boolean },
  emits: ["click"],
  setup(props, { attrs, emit, slots }) {
    return () =>
      h(
        "button",
        {
          ...attrs,
          type: "button",
          disabled: props.disabled || props.loading,
          onClick: (event: Event) => emit("click", event),
        },
        slots.default?.(),
      );
  },
});

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];
afterEach(() => {
  mounted.splice(0).forEach(({ app, host }) => {
    app.unmount();
    host.remove();
  });
});

type ComposerProps = {
  modelValue?: string;
  disabled?: boolean;
  paused?: boolean;
  busy?: boolean;
  activePlanBusy?: boolean;
  activePlanWaitingForInput?: boolean;
  stoppable?: boolean;
  stopping?: boolean;
  sending?: boolean;
  pendingInput?: boolean;
};

function mountComposer(overrides: ComposerProps = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const sent: number[] = [];
  const stopped: number[] = [];
  const app = createApp({
    render: () =>
      h(ExplorerComposer, {
        modelValue: "补充一句",
        disabled: false,
        paused: false,
        busy: false,
        activePlanBusy: false,
        activePlanWaitingForInput: false,
        stoppable: false,
        stopping: false,
        sending: false,
        pendingInput: false,
        inputAnswerInFlight: null,
        inputSubmitting: false,
        attachmentItems: [],
        attachmentError: null,
        model: "gpt-5.6-luna",
        backend: "codex-app-server",
        context: "12k",
        onSend: () => sent.push(1),
        onStop: () => stopped.push(1),
        ...overrides,
      }),
  });
  app.component("el-button", ElButtonStub);
  // AttachmentComposer 的缩略图分支用到的两个组件：这里没有附件，给个空壳只为不让 Vue 报未解析。
  app.component(
    "el-image",
    defineComponent({
      setup:
        (_props, { attrs }) =>
        () =>
          h("img", attrs),
    }),
  );
  app.component(
    "el-icon",
    defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          h("span", slots.default?.()),
    }),
  );
  app.mount(host);
  mounted.push({ app, host });
  return { host, sent, stopped };
}

describe("探索输入区的停止按钮", () => {
  it("有可停止的回合时，发送按钮换成停止按钮，点击只 emit stop", () => {
    const { host, sent, stopped } = mountComposer({ activePlanBusy: true, stoppable: true });

    const stop = host.querySelector<HTMLButtonElement>(".composer-stop");
    expect(stop).not.toBeNull();
    expect(host.querySelector(".composer-send")).toBeNull();
    expect(host.textContent).toContain("可随时停止");

    stop!.click();

    expect(stopped).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("停止请求在途时按钮禁用（连点不会发第二次）", () => {
    const { host, stopped } = mountComposer({ activePlanBusy: true, stoppable: true, stopping: true });

    const stop = host.querySelector<HTMLButtonElement>(".composer-stop")!;
    expect(stop.disabled).toBe(true);
    stop.click();

    expect(stopped).toHaveLength(0);
  });

  it("没有可停止的回合时回到发送按钮", () => {
    const { host, sent, stopped } = mountComposer();

    const send = host.querySelector<HTMLButtonElement>(".composer-send");
    expect(send).not.toBeNull();
    expect(host.querySelector(".composer-stop")).toBeNull();

    send!.click();

    expect(sent).toHaveLength(1);
    expect(stopped).toHaveLength(0);
  });
});
