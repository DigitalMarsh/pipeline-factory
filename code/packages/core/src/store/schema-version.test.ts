/**
 * 测试职责：SQLite 结构版本的**前进兼容护栏** —— 新库标记当前版本，更新的库拒绝被旧程序打开。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqlitePipelineStore } from "./sqlite-store.js";
import { CURRENT_SCHEMA_VERSION } from "./schema-version.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-schema-version-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

describe("SQLite schema version", () => {
  it("stamps a fresh database with the current version", () => {
    const path = databasePath();
    const store = new SqlitePipelineStore(path);
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    store.close();
  });

  it("refuses to open a database written by a newer build", () => {
    const path = databasePath();
    const store = new SqlitePipelineStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => new SqlitePipelineStore(path)).toThrow(/SCHEMA_TOO_NEW/);
  });
});
