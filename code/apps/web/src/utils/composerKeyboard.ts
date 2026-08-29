export type ComposerKeyboardEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">;

export function shouldSubmitComposer(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
