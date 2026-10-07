#!/usr/bin/env node
/**
 * 模块职责：把"这一阶段没有弄坏任何东西"变成一条可执行断言，作为重构全程的门禁。
 *
 * 为什么不用一条 `&&` 链：`pnpm --recursive test` 默认首次失败即中止。domain 有一个
 *   P0 就存在的已知失败，于是 web 测试与环检测根本不会被执行——门禁永远是红的，
 *   而且红得没有信息量。这里改为串行跑完每个阶段再汇总。
 *
 * 判据（对应计划里的"任何新增失败 = 该阶段未完成"）：失败的用例必须逐条出现在
 *   scripts/test-baseline.json 的 knownFailures 里。**只看失败的名字，不看数量**——
 *   新增用例是本方案的正常产物，计数会一直变；而"某个已有用例开始失败"才是回归信号。
 *   为了让名字比对可靠，这里不解析 vitest 的文本输出，而是让它产出 JSON 报告。
 *
 * 阶段顺序即依赖顺序：domain 必须先 build，api/web 的 typecheck 才能读到它的 dist。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(HERE, "..");
const PACKAGES = ["@pipeline-factory/domain", "@pipeline-factory/api", "@pipeline-factory/web"];

const temporary = mkdtempSync(join(tmpdir(), "pipeline-factory-verify-"));
const allowlist = new Set(
  (readJson(join(HERE, "test-baseline.json"))?.knownFailures ?? []).map((entry) => `${entry.package}|${entry.test}`),
);

/** 所有失败项（阶段失败 + 未登记在案的用例失败），最后统一汇报。 */
const problems = [];
const counts = [];

try {
  runStage("domain build", "pnpm", ["--filter", "@pipeline-factory/domain", "build"]);
  runStage("typecheck", "pnpm", ["--recursive", "--no-bail", "typecheck"]);
  // 代码规范：ESLint 只报**不依赖类型信息**的那一层（见 eslint.config.js 的说明），所以它与上面的
  // typecheck 不重复，而是补上 tsc 看不见的那一类（未使用的声明、Vue 模板属性顺序、被吞掉的错误原因）。
  runStage("lint", "pnpm", ["lint"]);
  // 排版：`format:check` 而不是 `format`——门禁只判断"合不合格"，**不改文件**。
  // 这条是本轮全量格式化之后才加的（此前它对 267 个文件有意见，加进来只会让门禁永远是红的）。
  runStage("format", "pnpm", ["format:check"]);
  for (const pkg of PACKAGES) runTests(pkg);
  runStage("cycle check", process.execPath, [join(HERE, "check-cycles.mjs")]);
  // 运行库的完整性：**删除路径漏收一张表，界面上一点看不出来**——先例是真发生过的：
  // `agent_loop_steps` 按 loop_id 挂，按 id 名单删就漏了 288 行；9 月还留下 8 个父行早就没了的
  // 孤儿 loop。这两件事都不是测试能发现的，只有"指向不存在的行"这一个症状。
  // 没有运行库（新克隆、CI）时它自己跳过，不是失败。
  runStage("store integrity", process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "check-dangling-refs.mjs")]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("\n=== 汇总 ===");
console.log(counts.join("\n") || "  (没有采集到测试结果)");

if (problems.length) {
  console.error("\n验证未通过：");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\n若这是**有意**的行为变更，请把它登记进 scripts/test-baseline.json 并写明原因；");
  console.error("否则说明该阶段引入了回归，不要继续往下做。");
  process.exitCode = 1;
} else {
  // 不提"悬空引用"这一项：没有运行库时那个阶段是自己跳过的，写进这句就成了"没跑也算过"。
  console.log("\n验证通过：无新增失败，无新增 value 级循环依赖。");
}

/** 跑一个阶段并继承它的输出；失败只记录不中断，后面的阶段仍要给出结论。 */
function runStage(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: CODE_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    problems.push(`${label} 失败（exit ${result.status ?? "signal"}）`);
  }
}

/**
 * 用 JSON reporter 跑一个包的测试。stdout 被吞掉——json reporter 的原始输出是给机器看的，
 * 打出来只会淹没真正有用的信息；失败用例由上面的汇总统一列出。
 */
function runTests(pkg) {
  console.log(`\n=== tests: ${pkg} ===`);
  const outputFile = join(temporary, `${pkg.replace(/[^\w]/g, "_")}.json`);
  const result = spawnSync("pnpm", ["--filter", pkg, "exec", "vitest", "run", "--reporter=json", `--outputFile=${outputFile}`], {
    cwd: CODE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const report = readJson(outputFile);
  if (!report) {
    // 没有报告通常意味着收集阶段就炸了（语法/导入错误），这时 stderr 才是唯一线索。
    problems.push(`${pkg} 测试无法运行（exit ${result.status ?? "signal"}）`);
    console.error(`✗ ${pkg} 未产出测试报告`);
    console.error((result.stderr ?? "").trim().split("\n").slice(-25).join("\n"));
    return;
  }

  counts.push(
    `  ${pkg}: ${report.testResults.length} 文件 / ${report.numTotalTests} 用例（通过 ${report.numPassedTests}，失败 ${report.numFailedTests}）`,
  );
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === "failed" && !allowlist.has(`${pkg}|${test.fullName}`)) problems.push(`${pkg} → ${test.fullName}`);
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
