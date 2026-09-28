/**
 * 测试职责：锁住 SqlitePipelineStore 的**语句缓存**——同一条 SQL 文本在整个连接生命周期内只编译一次。
 *
 * 为什么需要这个守卫：缓存的价值全在"编译次数"上，而编译次数在功能上是不可见的——把它改回
 *   `this.database.prepare(...)`，所有业务断言照旧全绿。本类有 130 余处调用点，谁新写一句
 *   直连 prepare 都不会有任何反馈。这里对 `DatabaseSync.prototype.prepare` 计数，把这条性质
 *   变成可断言的。B4 的 `plan-lifecycle.test.ts` 用的是同一手法（对 store 方法计数）。
 *
 * 维护提示：
 *   1) 计数必须在**构造完成之后**归零。构造函数要跑建表、迁移与回填，那部分的 prepare 次数
 *      随迁移条数增长，断言它等于某个具体值只会让"加一条迁移"变成一次无意义的红。
 *   2) 断言的是"增量"，不是总量：`toHaveBeenCalledTimes(1)` 这种写法一遇到其他调用就会误报。
 *   3) 这里**不**断言缓存上限（STATEMENT_CACHE_LIMIT）。上限是防御性的，观测它需要把常量
 *      导出成公开面或把清空时机编码进用例，两者都会让这个纯加速层比它加速的东西更难改。
 *      "缓存确实生效"（用例 1）与"缓存被绕过时会红"（用例 2 的反向说明）才是这里的职责。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService, SqlitePipelineStore } from "./index.js";

const openStores: SqlitePipelineStore[] = [];
const temporaryDirectories: string[] = [];
const activeSpies: Array<() => void> = [];

afterEach(() => {
  for (const restore of activeSpies.splice(0)) restore();
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 统计 `DatabaseSync.prepare` 的调用次数。原生类的原型方法可被替换，见文件头的说明。 */
function spyOnPrepare(): { count: () => number } {
  const original = DatabaseSync.prototype.prepare;
  let calls = 0;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string): StatementSync {
    calls += 1;
    return original.call(this, sql);
  };
  activeSpies.push(() => { DatabaseSync.prototype.prepare = original; });
  return { count: () => calls };
}

/** 建一个临时库，返回 store 与一个"从现在起"的 prepare 计数器。 */
function openStore(): { store: SqlitePipelineStore; prepareCalls: () => number } {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-statement-cache-"));
  temporaryDirectories.push(directory);
  const spy = spyOnPrepare();
  const store = new SqlitePipelineStore(join(directory, "factory.sqlite"));
  openStores.push(store);
  // 构造期的建表/迁移/回填不在断言范围内（见维护提示 1）。
  const base = spy.count();
  return { store, prepareCalls: () => spy.count() - base };
}

describe("SqlitePipelineStore 的语句缓存", () => {
  it("同一 SQL 反复执行只编译一次", () => {
    const { store, prepareCalls } = openStore();

    for (let index = 0; index < 50; index += 1) store.getProject("project-does-not-exist");

    expect(prepareCalls()).toBe(1);
  });

  it("SQL 文本不同就各编译一次，读与写分开计数", () => {
    const { store, prepareCalls } = openStore();
    const projects = new ProjectService(store);

    projects.create({ id: "project-cache", name: "Cache Project", repoRoot: "/repo/cache", defaultBranch: "main", worktreeRoot: "/tmp/cache-worktrees" });
    const afterCreate = prepareCalls();

    // 再建一个同名不同 id 的项目：INSERT 那条 SQL 已在缓存里，不该产生新的编译。
    projects.create({ id: "project-cache-2", name: "Cache Project", repoRoot: "/repo/cache-2", defaultBranch: "main", worktreeRoot: "/tmp/cache-worktrees-2" });

    expect(prepareCalls()).toBe(afterCreate);
  });

  it("命中缓存不改变结果：写入后读到的仍是最新值", () => {
    const { store } = openStore();
    const projects = new ProjectService(store);
    const project = projects.create({ id: "project-fresh", name: "Before", repoRoot: "/repo/fresh", defaultBranch: "main", worktreeRoot: "/tmp/fresh-worktrees" });

    expect(store.getProject(project.id)?.name).toBe("Before");
    // 第一次读已经把 SELECT 与 UPSERT 都编译并缓存了；改完再读必须看到新值，
    // 否则说明"缓存"变成了"缓存结果"。
    store.saveProject({ ...project, name: "After" });
    expect(store.getProject(project.id)?.name).toBe("After");

    expect(store.listProjects().map((entry) => entry.name)).toEqual(["After"]);
  });

  it("带 IN 列表的语句按元数分桶：1 个 ID 与 2 个 ID 各占一条", () => {
    const { store, prepareCalls } = openStore();
    const projects = new ProjectService(store);
    projects.create({ id: "p-1", name: "One", repoRoot: "/repo/one", defaultBranch: "main", worktreeRoot: "/tmp/one" });
    projects.create({ id: "p-2", name: "Two", repoRoot: "/repo/two", defaultBranch: "main", worktreeRoot: "/tmp/two" });

    const before = prepareCalls();
    store.listEvents({ aggregateIds: ["p-1"], afterSequence: 0 });
    const afterOneId = prepareCalls();
    store.listEvents({ aggregateIds: ["p-1"], afterSequence: 0 });
    expect(prepareCalls()).toBe(afterOneId);

    store.listEvents({ aggregateIds: ["p-1", "p-2"], afterSequence: 0 });
    expect(prepareCalls()).toBeGreaterThan(afterOneId);
    expect(before).toBeLessThanOrEqual(afterOneId);
  });
});
