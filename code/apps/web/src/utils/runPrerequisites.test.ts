import { describe, expect, it } from "vitest";
import { parseMissingRunCommands } from "./runPrerequisites";

describe("run prerequisites", () => {
  it("extracts missing registered command ids from the API error", () => {
    expect(parseMissingRunCommands("RUN_PREREQUISITES_UNSATISFIED: missing registered commands: project.test, project.typecheck")).toEqual(["project.test", "project.typecheck"]);
  });

  it("ignores unrelated errors", () => {
    expect(parseMissingRunCommands("Run cannot be started")).toEqual([]);
  });
});
