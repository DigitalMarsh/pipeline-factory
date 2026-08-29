import { describe, expect, it } from "vitest";
import { useDismissibleNotice } from "./dismissibleNotice";

describe("useDismissibleNotice", () => {
  it("hides the notice after it is dismissed", () => {
    const notice = useDismissibleNotice();

    expect(notice.visible.value).toBe(true);

    notice.dismiss();

    expect(notice.visible.value).toBe(false);
  });
});
