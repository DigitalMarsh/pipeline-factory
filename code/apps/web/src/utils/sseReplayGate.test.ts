import { describe, expect, it } from "vitest";
import { createSseReplayGate } from "./sseReplayGate";

describe("createSseReplayGate", () => {
  it("ignores replayed events until the server declares the stream ready", () => {
    const gate = createSseReplayGate();

    expect(gate.accept("turn.text.delta")).toBe(false);
    expect(gate.accept("turn.completed")).toBe(false);
    expect(gate.accept("stream.ready")).toBe(false);
    expect(gate.ready).toBe(true);
    expect(gate.accept("turn.text.delta")).toBe(true);
  });

  it("can be marked ready when a provider does not emit a replay marker", () => {
    const gate = createSseReplayGate();

    gate.markReady();

    expect(gate.accept("turn.completed")).toBe(true);
  });
});
