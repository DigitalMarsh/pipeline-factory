import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **换行与缩进不是这些断言的判据**：Prettier 会把源码重排（一行拆成多行、缩进改变），而断言要证的是
 * "这里接上了某个东西"，不是"它是怎么排版的"。两边都先把连续空白压成单个空格再比——否则每次格式化
 * 都要回来把一批断言重打一遍，而它们本来就没打算测排版。
 */
const flat = (text: string) =>
  text
    .replace(/\s+/g, " ")
    // 断行会在**下一个 token 前面**留下一个空格（`foo(\n  bar,` -> `foo( bar,`）。只吃掉这些
    // "断行带进来的"空格：开括号/花括号之后，闭括号/花括号/方括号/分号/逗号/引号之前。
    // **不要**动别处——尤其别去掉 `(` 前面的空格：正则断言不会被折叠，`@media (max-width:` 那样
    // 一改就再也匹配不上。
    .replace(/([({])\s+/g, "$1")
    .replace(/\s+([)}\]);,"'])/g, "$1")
    .replace(/,([)}\]])/g, "$1")
    .trim();

const drawerSource = readFileSync(fileURLToPath(new URL("./PlanDetailDrawer.vue", import.meta.url)), "utf8");
const contentSource = readFileSync(fileURLToPath(new URL("./PlanDetailContent.vue", import.meta.url)), "utf8");

describe("PlanDetailDrawer execution read-only mode", () => {
  it("supports hiding Plan lifecycle mutations for execution-thread callers", () => {
    expect(flat(drawerSource)).toContain(flat("readOnly?: boolean"));
    expect(flat(drawerSource)).toContain(flat(':read-only="props.readOnly"'));
    expect(flat(contentSource)).toContain(flat('v-if="readOnly"'));
    expect(flat(contentSource)).toContain(flat('class="drawer-readonly-note"'));
    expect(flat(contentSource)).toContain(flat('v-else class="drawer-actions"'));
  });

  it("renders generated spec details before a resolved execution contract exists", () => {
    expect(flat(contentSource)).toContain(flat("props.plan?.generatedSpec"));
    expect(flat(contentSource)).toContain(flat("generated?.objective.goal"));
    expect(flat(contentSource)).toContain(flat("generated.value?.scope.includePaths"));
    expect(flat(contentSource)).toContain(flat("generated.value?.tasks"));
    expect(flat(contentSource)).toContain(flat('generated ? "生成的方案"'));
    // 执行角色与工具策略**不在模型契约里**（模型填了也没有消费方，会撒谎）：只从 resolved 读。
    expect(flat(contentSource)).toContain(flat("resolved?.execution.toolPolicy"));
    expect(contentSource).not.toContain("generated?.execution.toolPolicy");
  });

  it("offers the Factory-owned prerequisite plan picker only for editable candidates", () => {
    expect(flat(contentSource)).toContain(flat("canEditDependencies"));
    expect(flat(contentSource)).toContain(flat('emit("update-dependencies"'));
    expect(flat(contentSource)).toContain(flat("canEditDependencies || confirmedDependencies.length"));
    // 抽屉把这次编辑原样透传给视图；视图接的是 saveDependencies。
    expect(flat(drawerSource)).toContain(flat("@update-dependencies=\"emit('update-dependencies', $event)\""));
  });

  it("offers the verification subset picker from the Project tag vocabulary", () => {
    expect(flat(contentSource)).toContain(flat("canEditVerificationSuites"));
    expect(flat(contentSource)).toContain(flat("verificationSuiteOptions"));
    expect(flat(contentSource)).toContain(flat('emit("update-verification-suites"'));
    expect(flat(drawerSource)).toContain(flat("@update-verification-suites=\"emit('update-verification-suites', $event)\""));
    // 勾选项只来自项目登记的 tag：那一格里唯一的输入控件是对词表的复选框（没有手填 ID 的地方）。
    // 注意不要断言"内容里不出现 verificationCommandIds"——它在别处是**读**遗留投影，属于合法引用。
    expect(flat(contentSource)).toContain(flat("toggleSuite"));
    expect(flat(contentSource)).toContain(flat('type="checkbox"'));
  });
});
