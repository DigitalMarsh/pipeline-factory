import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, SqlitePipelineStore, mergeModelUsage, normalizeModelUsage, type ExecutionTelemetry } from "./index.js";

const telemetry: ExecutionTelemetry = {
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  startedAt: "2026-09-06T12:00:00.000Z",
  completedAt: "2026-09-06T12:00:03.250Z",
  durationMs: 3250,
  usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 12, totalTokens: 140 },
  usageSource: "provider",
  usageScope: "turn",
};

describe("execution telemetry domain", () => {
  it("normalizes Responses and App Server token field variants", () => {
    expect(normalizeModelUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } })).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    expect(normalizeModelUsage({ inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 })).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    expect(normalizeModelUsage({ text: "no usage" })).toBeNull();
  });

  it("sums per-turn usage but replaces repeated provider cumulative usage", () => {
    const first = { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 };
    const second = { inputTokens: 12, outputTokens: 6, reasoningTokens: 3, totalTokens: 18 };
    expect(mergeModelUsage(first, second, "turn")).toEqual({ inputTokens: 22, outputTokens: 11, reasoningTokens: 5, totalTokens: 33 });
    expect(mergeModelUsage(first, second, "total")).toEqual(second);
    expect(mergeModelUsage(second, second, "total")).toEqual(second);
  });

  it("keeps telemetry after SQLite close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pipeline-telemetry-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const first = new SqlitePipelineStore(databasePath);
      first.saveExecutionThread({ id: "thread-telemetry", runId: "run-telemetry", state: "COMPLETED", journal: [], telemetry });
      first.close();
      const reopened = new SqlitePipelineStore(databasePath);
      expect(reopened.getExecutionThread("thread-telemetry")?.telemetry).toEqual(telemetry);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a safe empty telemetry object for an old execution_threads table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pipeline-legacy-telemetry-"));
    const databasePath = join(directory, "factory.sqlite");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec("CREATE TABLE execution_threads (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, journal_json TEXT NOT NULL)");
      legacy.prepare("INSERT INTO execution_threads (id, run_id, state, journal_json) VALUES (?, ?, ?, ?)").run("legacy-thread", "legacy-run", "COMPLETED", "[]");
      legacy.close();
      const store = new SqlitePipelineStore(databasePath);
      expect(store.getExecutionThread("legacy-thread")?.telemetry).toBeNull();
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps InMemory Store read/write semantics aligned", () => {
    const store = new InMemoryPipelineStore();
    store.saveExecutionThread({ id: "memory-thread", runId: "memory-run", state: "ACTIVE", journal: [], telemetry });
    expect(store.getExecutionThread("memory-thread")?.telemetry).toEqual(telemetry);
  });
});
