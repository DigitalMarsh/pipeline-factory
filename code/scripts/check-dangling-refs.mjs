/**
 * 模块职责：扫**运行库里所有"指向不存在的行"的引用**——某个 Run 没了、它的 Run 还把 plan_id 指着它，
 *   这类残骸是删除路径漏收了某张表留下的唯一症状（删完之后界面照常，谁也看不出来）。
 *
 * 设计说明：
 *   1) **判据不是 id 名单，是"子列 → 父表"的对照表**。按 id 扫只能回答"我删的这几条干净了吗"，
 *      而这里要回答的是"库里此刻还有没有孤儿"——不管它是谁留下的、什么时候留下的。
 *      第一版靠 id 名单，代价是漏掉了按 `loop_id` 挂的 288 行 steps 与"owner 是回合"的那条 loop。
 *   2) **两类结论分开**：`悬空`（子行指着一个不存在的父行）会让这个检查**失败**；而对照表本身
 *      与库对不上（表没了 / 列改名了）算 `对照表过期`——表整个不在多半是那个功能没了（也意味着
 *      库比代码旧，启动一次 api 就会补上），列不在则是真的改了名，必须回来更新这张表。
 *   3) 只读打开，带 `busy_timeout`：dev api 正跑着也能扫（WAL 允许并发读）。
 *   4) **没有库就跳过**（新克隆、CI 里根本没有运行库），不是失败。
 *
 * 维护提示：新增一张挂在既有实体下面的表时，把它加进 REFERENCES；**owner 多态这类列**（`agent_loops.owner_id`
 *   指向 run 或回合）单独写在 `POLYMORPHIC` 里。这张表是手写的、也会过期，所以脚本自己会核对
 *   "表/列还在不在"，不靠人记得。
 *
 * 用法：
 *   node scripts/check-dangling-refs.mjs                      有悬空引用则退出码 1
 *   node scripts/check-dangling-refs.mjs --database=<路径>     扫另一个库（比如某份备份）
 */
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const configPath = join(repoRoot, "config/pipeline-factory.config.json");

/**
 * 子列 → 父表的对照。[子表, 子列, 父表, 父列]。
 * 可空的外键（`run_id` 之类）也一并列进来——`IS NOT NULL` 那一句会把空值放过。
 */
const REFERENCES = [
  ["explorer_threads", "candidate_plan_id", "candidate_plans", "id"],
  ["explorer_threads", "active_explorer_plan_id", "explorer_plans", "id"],
  ["explorer_threads", "active_revision_draft_id", "plan_revision_drafts", "draft_id"],
  ["explorer_threads", "last_assessed_turn_id", "explorer_turns", "id"],
  ["explorer_threads", "origin_thread_id", "explorer_threads", "id"],
  ["explorer_plans", "explorer_thread_id", "explorer_threads", "id"],
  ["explorer_plans", "candidate_plan_id", "candidate_plans", "id"],
  ["explorer_plans", "last_assessed_turn_id", "explorer_turns", "id"],
  ["explorer_turns", "thread_id", "explorer_threads", "id"],
  ["explorer_turns", "explorer_plan_id", "explorer_plans", "id"],
  ["explorer_input_requests", "thread_id", "explorer_threads", "id"],
  ["explorer_input_requests", "explorer_plan_id", "explorer_plans", "id"],
  ["candidate_plans", "source_explorer_thread_id", "explorer_threads", "id"],
  ["candidate_plans", "explorer_plan_id", "explorer_plans", "id"],
  ["candidate_plans", "run_id", "runs", "id"],
  ["candidate_plan_versions", "plan_id", "candidate_plans", "id"],
  ["plan_revisions", "plan_id", "candidate_plans", "id"],
  ["plan_revisions", "explorer_plan_id", "explorer_plans", "id"],
  ["plan_revision_drafts", "plan_id", "candidate_plans", "id"],
  ["plan_revision_drafts", "explorer_plan_id", "explorer_plans", "id"],
  ["plan_dispatch_states", "plan_id", "candidate_plans", "id"],
  ["plan_dispatch_states", "run_id", "runs", "id"],
  ["plan_query_projection", "plan_id", "candidate_plans", "id"],
  ["runs", "plan_id", "candidate_plans", "id"],
  ["runs", "execution_thread_id", "execution_threads", "id"],
  ["execution_threads", "run_id", "runs", "id"],
  ["execution_journal", "run_id", "runs", "id"],
  ["hook_executions", "run_id", "runs", "id"],
  ["verification_runs", "run_id", "runs", "id"],
  ["merge_requests", "run_id", "runs", "id"],
  ["merge_requests", "plan_id", "candidate_plans", "id"],
  ["run_guidance", "run_id", "runs", "id"],
  ["agent_loop_steps", "loop_id", "agent_loops", "id"],
  ["tool_calls", "loop_id", "agent_loops", "id"],
  ["change_proposals", "run_id", "runs", "id"],
  ["change_proposals", "plan_id", "candidate_plans", "id"],
  ["factory_projects", "current_explorer_thread_id", "explorer_threads", "id"],
];

/** 一个列指向**两张**可能的父表（按另一列的取值决定）。 */
const POLYMORPHIC = [
  { table: "agent_loops", column: "owner_id", discriminator: "owner_type", parents: { run: "runs", "explorer-turn": "explorer_turns" } },
];

const override = process.argv.find((argument) => argument.startsWith("--database="))?.slice("--database=".length);
const databasePath = override ? resolve(override) : resolve(dirname(configPath), readStoragePath() ?? "../pipeline-factory.sqlite");
if (!existsSync(databasePath)) {
  console.log(`没有运行库（${databasePath}），跳过。`);
  process.exit(0);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
database.exec("PRAGMA busy_timeout = 15000");
const schema = new Map(
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(({ name }) => [
      name,
      new Set(
        database
          .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
          .all()
          .map((column) => column.name),
      ),
    ]),
);
if (schema.size === 0) {
  console.log(`${databasePath} 还是个空库（一个表都没有），跳过。`);
  database.close();
  process.exit(0);
}

const dangling = [];
const stale = [];
const skipped = [];
for (const [table, column, parent, parentColumn] of REFERENCES) {
  if (!schema.has(table) || !schema.has(parent)) {
    skipped.push(`${table}.${column} → ${parent}.${parentColumn}（表不在库里）`);
    continue;
  }
  if (!schema.get(table).has(column) || !schema.get(parent).has(parentColumn)) {
    stale.push(`${table}.${column} → ${parent}.${parentColumn}（列不在表里）`);
    continue;
  }
  const { n } = database
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table}
        WHERE ${column} IS NOT NULL
          AND ${column} NOT IN (SELECT ${parentColumn} FROM ${parent} WHERE ${parentColumn} IS NOT NULL)`,
    )
    .get();
  if (n > 0) dangling.push(`${table}.${column} → ${parent}.${parentColumn}：${n} 行悬空`);
}
for (const { table, column, discriminator, parents } of POLYMORPHIC) {
  if (!schema.has(table) || !schema.get(table).has(column) || !schema.get(table).has(discriminator)) {
    stale.push(`${table}.${column}（多态，按 ${discriminator} 分派）`);
    continue;
  }
  for (const [kind, parent] of Object.entries(parents)) {
    if (!schema.has(parent)) {
      skipped.push(`${table}.${column}（${kind}）→ ${parent}.id（表不在库里）`);
      continue;
    }
    const { n } = database
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table}
          WHERE ${discriminator} = ? AND ${column} NOT IN (SELECT id FROM ${parent} WHERE id IS NOT NULL)`,
      )
      .get(kind);
    if (n > 0) dangling.push(`${table}.${column}（${kind}）→ ${parent}.id：${n} 行悬空`);
  }
}
database.close();

if (skipped.length) {
  console.log(`跳过 ${skipped.length} 条对照（库比代码旧，启动一次 api 会补上这些表）：`);
  for (const entry of skipped) console.log(`  · ${entry}`);
}

if (stale.length) {
  console.error(`\n对照表过期了 ${stale.length} 条——列不在了，多半是改了名。请同步 ${"scripts/check-dangling-refs.mjs"} 里的 REFERENCES：`);
  for (const entry of stale) console.error(`  - ${entry}`);
  process.exit(1);
}

if (dangling.length) {
  console.error(`\n发现 ${dangling.length} 类悬空引用：`);
  for (const entry of dangling) console.error(`  - ${entry}`);
  console.error("\n这是某条删除路径漏收了这些表留下的残骸：先查是哪条路径删的（多半在 run/scheduler.ts、");
  console.error("explorer/service.ts 的级联里），把它补上；存量按 .runtime 下的清理脚本单独处理。");
  process.exit(1);
}

console.log(`全库悬空引用：0 处（核对了 ${REFERENCES.length + POLYMORPHIC.length} 条对照）。`);

function readStoragePath() {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"))?.storage?.databasePath ?? null;
  } catch {
    return null;
  }
}
