/**
 * 模块职责：检测三个包 src 目录下的模块导入环，把"值级环"和"类型环"分开报告。
 * 设计说明：值级环（至少一条边是运行时 import）是真正的循环依赖，靠 ESM hoisting 侥幸不炸，
 *   一旦模块换目录、顺序变化就会变成 undefined；类型环由 tsc 整条擦除，无害且不该强行消除。
 *   现有工具（madge/dpdm）默认把 type-only import 也算成边，会把无害的类型环混进真实环里，
 *   因此这里自研：只对相对路径与 @/ 别名建图，零依赖。
 * 维护提示：新增导出条件或路径别名时，同步更新 resolveSpecifier；新增包时同步更新 SCAN_ROOTS。
 *
 * 用法：
 *   node scripts/check-cycles.mjs                 比对基线，出现新的值级环则退出码 1
 *   node scripts/check-cycles.mjs --write-baseline 把当前值级环写进 scripts/cycle-baseline.json
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const baselinePath = join(here, "cycle-baseline.json");

/** 被扫描的源码根。web 的 @ 别名指向它自己的 src。 */
const SCAN_ROOTS = [
  { root: join(repoRoot, "packages/domain/src"), alias: null },
  { root: join(repoRoot, "apps/api/src"), alias: null },
  { root: join(repoRoot, "apps/web/src"), alias: "@" },
];

/** 测试文件是图的叶子（没有任何模块 import 它们），排除掉可以少建一批无意义的边。 */
const IGNORED = /\.test\.ts$|\.d\.ts$/;

function collectFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...collectFiles(path));
      continue;
    }
    if (/\.(ts|vue)$/.test(entry) && !IGNORED.test(entry)) found.push(path);
  }
  return found;
}

/** .vue 的 import 都在 script 块里，template 与 style 不参与模块图。 */
function moduleSource(filePath, text) {
  if (!filePath.endsWith(".vue")) return text;
  const blocks = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  return blocks.map((block) => block[1]).join("\n");
}

/** 去掉注释，避免注释里出现的 import 示例被当成真实边。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * 判断 `import { ... }` 的花括号里是否每个具名绑定都带 type 前缀。
 * 只看花括号：带默认导入或命名空间导入（`import Def, { ... }`）的一律算值级。
 */
function allNamedBindingsTyped(clause) {
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (!brace) return false;
  const beforeBrace = clause.slice(0, brace.index).trim();
  if (beforeBrace && !beforeBrace.startsWith("{")) return false;
  const names = brace[1].split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) return false;
  return names.every((name) => /^type\s/.test(name));
}

/**
 * 抽取一条语句引用的模块。specifier 只保留相对路径与 @ 别名——
 * 跨包 import（如 @pipeline-factory/domain）在本次重构范围内不会形成环。
 *
 * clause 用 `[^;]*?` 而不是 `[\s\S]*?` 卡住，这是必须的：真正的 import/export-from
 * 语句在 from 之前不可能出现分号。放宽成 `[\s\S]*?` 时，`export async function f() {...}`
 * 这类没有 from 的语句会一路吞到文件后面某个字符串字面量（实测吞到过一个 `"."`），
 * 而 `"."` 以点开头会被当相对路径解析成同级 index.ts，凭空造出一条环。
 */
function parseEdges(text) {
  const clean = stripComments(text);
  const edges = [];
  const statement = /(?:^|\n)[ \t]*(import|export)\b([^;]*?)(?:from\s*["']([^"']+)["']|["']([^"']+)["']\s*;)/g;
  let match;
  while ((match = statement.exec(clean))) {
    const clause = match[2];
    const specifier = match[3] ?? match[4];
    if (!specifier || !(specifier.startsWith(".") || specifier.startsWith("@/"))) continue;
    // `from "."` / `from "./"` 指向自身目录，在本仓不存在且会解析成同级 index.ts，直接排除。
    if (/^\.\/?$/.test(specifier)) continue;
    const typeOnly = /^\s*type\s/.test(clause) || allNamedBindingsTyped(clause);
    edges.push({ specifier, typeOnly });
  }
  return edges;
}

/** 把 specifier 解析到磁盘上的真实文件；解析不到（第三方、.vue 之外的资源）返回 null。 */
function resolveSpecifier(fromFile, specifier, alias) {
  let base;
  if (specifier.startsWith("@/") && alias) base = join(repoRoot, "apps/web/src", specifier.slice(2));
  else if (specifier.startsWith("@/")) return null;
  else base = resolve(dirname(fromFile), specifier);

  // NodeNext 的写法是 "./x.js"，磁盘上是 "./x.ts"；Vue 组件直接就是 .vue。
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.vue`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 建图。nodes 是所有被扫描到的文件，edges 分别按值级/类型级拆成两张图。 */
function buildGraphs() {
  const valueAdjacency = new Map();
  const typeAdjacency = new Map();
  const allFiles = [];

  for (const { root, alias } of SCAN_ROOTS) {
    for (const file of collectFiles(root)) {
      allFiles.push(file);
      const source = moduleSource(file, readFileSync(file, "utf8"));
      const valueTargets = new Set();
      const typeTargets = new Set();
      for (const edge of parseEdges(source)) {
        const target = resolveSpecifier(file, edge.specifier, alias);
        if (!target) continue;
        (edge.typeOnly ? typeTargets : valueTargets).add(target);
      }
      valueAdjacency.set(file, valueTargets);
      typeAdjacency.set(file, typeTargets);
    }
  }

  for (const file of allFiles) {
    if (!valueAdjacency.has(file)) valueAdjacency.set(file, new Set());
    if (!typeAdjacency.has(file)) typeAdjacency.set(file, new Set());
  }
  return { allFiles, valueAdjacency, typeAdjacency };
}

/** Tarjan 强连通分量。返回 size > 1 的分量以及自环，即所有环。 */
function findCycles(adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  const strongConnect = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }

    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    const selfLoop = component.length === 1 && (adjacency.get(node) ?? new Set()).has(node);
    if (component.length > 1 || selfLoop) cycles.push(component.map((file) => relative(repoRoot, file)).sort());
  };

  for (const node of adjacency.keys()) if (!index.has(node)) strongConnect(node);
  return cycles;
}

/** 环的指纹只由成员集合决定，与遍历起点无关，便于和基线比对。 */
const fingerprint = (cycle) => cycle.join(" | ");

const { valueAdjacency, typeAdjacency } = buildGraphs();
const valueCycles = findCycles(valueAdjacency);
const typeCycles = findCycles(typeAdjacency);

/**
 * 一个大强连通分量里往往有几十条边，只报成员列表等于没说该切哪里。
 * 这里把分量内部的边逐条列出来——那才是"要解环就得动这些 import"的清单。
 */
function internalEdges(cycle) {
  const members = new Set(cycle);
  const edges = [];
  for (const from of cycle) {
    for (const to of valueAdjacency.get(join(repoRoot, from)) ?? []) {
      const target = relative(repoRoot, to);
      if (members.has(target)) edges.push(`${from} → ${target}`);
    }
  }
  return edges;
}

console.log(`值级环（真实运行时循环依赖）：${valueCycles.length} 个强连通分量`);
for (const cycle of valueCycles) {
  console.log(`\n  [${cycle.length} 个模块]`);
  for (const member of cycle) console.log(`    ${member}`);
  console.log(`  分量内部的 ${internalEdges(cycle).length} 条值级边（要解环就得动这些）：`);
  for (const edge of internalEdges(cycle)) console.log(`    ${edge}`);
}
console.log(`\n类型环（tsc 擦除，无害）：${typeCycles.length} 个强连通分量`);
for (const cycle of typeCycles) console.log(`  - [${cycle.length}] ${cycle.join(", ")}`);

if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify({ valueCycles: valueCycles.map(fingerprint) }, null, 2)}\n`);
  console.log(`\n已写入基线 ${relative(repoRoot, baselinePath)}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.log("\n尚无基线文件，用 --write-baseline 生成。");
  process.exit(0);
}

const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")).valueCycles ?? []);
const introduced = valueCycles.filter((cycle) => !baseline.has(fingerprint(cycle)));
const resolved = [...baseline].filter((key) => !valueCycles.some((cycle) => fingerprint(cycle) === key));

if (resolved.length) console.log(`\n已消除的环：${resolved.length}（记得更新基线）`);
if (introduced.length) {
  console.error(`\n新增了 ${introduced.length} 个值级环：`);
  for (const cycle of introduced) console.error(`  - ${cycle.join(", ")}`);
  process.exit(1);
}
console.log("\n没有新增值级环。");
