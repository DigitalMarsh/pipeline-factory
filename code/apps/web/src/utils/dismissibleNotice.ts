/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { ref } from "vue";

/** 提供一次性关闭提示的最小响应式状态，不把 UI 偏好写入业务实体。 */
export function useDismissibleNotice(initialVisible = true) {
  const visible = ref(initialVisible);

  function dismiss() {
    visible.value = false;
  }

  return { visible, dismiss };
}
