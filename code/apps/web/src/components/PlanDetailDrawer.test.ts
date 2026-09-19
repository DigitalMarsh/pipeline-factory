import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drawerSource = readFileSync(fileURLToPath(new URL("./PlanDetailDrawer.vue", import.meta.url)), "utf8");

describe("PlanDetailDrawer execution read-only mode", () => {
  it("supports hiding Plan lifecycle mutations for execution-thread callers", () => {
    expect(drawerSource).toContain("readOnly?: boolean");
    expect(drawerSource).toContain('v-if="readOnly"');
    expect(drawerSource).toContain('class="drawer-readonly-note"');
    expect(drawerSource).toContain('v-else class="drawer-actions"');
  });
});
