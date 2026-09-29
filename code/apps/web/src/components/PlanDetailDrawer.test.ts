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
    // 执行角色与工具策略**不在模型契约里**（模型填了也没有消费方，会撒谎）：只从 resolved 读。
    expect(contentSource).toContain("resolved?.execution.toolPolicy");
    expect(contentSource).not.toContain("generated?.execution.toolPolicy");
  });

  it("offers the Factory-owned prerequisite plan picker only for editable candidates", () => {
    expect(contentSource).toContain("canEditDependencies");
    expect(contentSource).toContain('emit("update-dependencies"');
    expect(contentSource).toContain("canEditDependencies || confirmedDependencies.length");
    // 抽屉把这次编辑原样透传给视图；视图接的是 saveDependencies。
    expect(drawerSource).toContain('@update-dependencies="emit(\'update-dependencies\', $event)"');
  });
});
