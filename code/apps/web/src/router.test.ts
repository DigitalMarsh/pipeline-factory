import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const routerSource = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

describe("project workspace routes", () => {
  it("removes the global Workbench route but keeps project Execute", () => {
    expect(routerSource).not.toContain('path: "/workbench"');
    expect(routerSource).toContain('path: "/projects/:projectId/execute"');
  });
});
