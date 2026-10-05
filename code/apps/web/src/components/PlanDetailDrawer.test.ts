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

  it("renders generated spec details before a resolved execution contract exists", () => {
    expect(contentSource).toContain("props.plan?.generatedSpec");
    expect(contentSource).toContain("generated?.objective.goal");
    expect(contentSource).toContain("generated.value?.scope.includePaths");
    expect(contentSource).toContain("generated.value?.tasks");
    expect(contentSource).toContain("generated ? '生成的方案'");
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

  it("offers the verification subset picker from the Project tag vocabulary", () => {
    expect(contentSource).toContain("canEditVerificationSuites");
    expect(contentSource).toContain("verificationSuiteOptions");
    expect(contentSource).toContain('emit("update-verification-suites"');
    expect(drawerSource).toContain('@update-verification-suites="emit(\'update-verification-suites\', $event)"');
    // 勾选项只来自项目登记的 tag：那一格里唯一的输入控件是对词表的复选框（没有手填 ID 的地方）。
    // 注意不要断言"内容里不出现 verificationCommandIds"——它在别处是**读**遗留投影，属于合法引用。
    expect(contentSource).toContain("toggleSuite");
    expect(contentSource).toContain('type="checkbox"');
  });
});
