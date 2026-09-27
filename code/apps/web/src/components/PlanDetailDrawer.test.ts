import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const drawerSource = readFileSync(fileURLToPath(new URL("./PlanDetailDrawer.vue", import.meta.url)), "utf8");
const contentSource = readFileSync(fileURLToPath(new URL("./PlanDetailContent.vue", import.meta.url)), "utf8");

describe("PlanDetailDrawer execution read-only mode", () => {
  it("supports hiding Plan lifecycle mutations for execution-thread callers", () => {
    expect(drawerSource).toContain("readOnly?: boolean");
    expect(drawerSource).toContain(':read-only="props.readOnly"');
    expect(contentSource).toContain('v-if="readOnly"');
    expect(contentSource).toContain('class="drawer-readonly-note"');
    expect(contentSource).toContain('v-else class="drawer-actions"');
  });

  it("renders generated V2 details before a resolved execution contract exists", () => {
    expect(contentSource).toContain("props.plan?.generatedSpec");
    expect(contentSource).toContain("generated?.objective.goal");
    expect(contentSource).toContain("generated.value?.scope.includePaths");
    expect(contentSource).toContain("generated.value?.tasks");
    expect(contentSource).toContain("generated ? 'Generated V2'");
    expect(contentSource).toContain("generated?.execution.toolPolicy");
  });
});
