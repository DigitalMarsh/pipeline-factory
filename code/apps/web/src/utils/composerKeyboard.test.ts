import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composerKeyboard";

describe("shouldSubmitComposer", () => {
  it("only submits Enter when Cmd or Ctrl is pressed", () => {
    expect(shouldSubmitComposer({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(shouldSubmitComposer({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldSubmitComposer({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldSubmitComposer({ key: "Escape", metaKey: true, ctrlKey: true })).toBe(false);
  });
});
