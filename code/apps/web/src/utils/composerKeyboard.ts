/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type ComposerKeyboardEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">;

/** 仅在 Meta/Ctrl+Enter 时提交，普通 Enter 保留为多行输入。 */
export function shouldSubmitComposer(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
