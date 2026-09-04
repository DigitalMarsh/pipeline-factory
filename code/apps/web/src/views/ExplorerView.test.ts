import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const threadRailSource = readFileSync(fileURLToPath(new URL("../components/ThreadRail.vue", import.meta.url)), "utf8");

describe("Explorer policy notice surface", () => {
  it("does not render the redundant policy banner", () => {
    expect(explorerViewSource).not.toContain("thread-banner");
    expect(explorerViewSource).not.toContain("showThreadBanner");
    expect(explorerViewSource).not.toContain("dismissThreadBanner");
    expect(explorerViewSource).toContain("Manage read-only exploration without changing the repository.");
    expect(explorerViewSource).toContain("View policy");
  });
});

describe("Explorer project selector wiring", () => {
  it("loads the project catalog and delegates sidebar selections", () => {
    expect(explorerViewSource).toContain("api.projects()");
    expect(explorerViewSource).toContain(":projects=\"projects\"");
    expect(explorerViewSource).toContain("@select-project=\"switchProject\"");
    expect(explorerViewSource).toContain("projectPathForModule(\"explore\", selectedProjectId)");
    expect(explorerViewSource).toContain("@manage-projects=\"projectManagementOpen = true\"");
  });
});

describe("Explorer context panel wiring", () => {
  it("connects horizontal right-panel context tabs to a dynamic panel", () => {
    expect(explorerViewSource).toContain("contextPanel");
    expect(explorerViewSource).toContain("context-panel-nav");
    expect(explorerViewSource).toContain("data-context");
    expect(explorerViewSource).toContain('key: "candidate"');
    expect(explorerViewSource).toContain('key: "dispatched"');
    expect(explorerViewSource).toContain('key: "active"');
    expect(explorerViewSource).toContain('key: "attention"');
    expect(explorerViewSource).toContain("needsAttentionCount");
    expect(explorerViewSource).toContain("Needs attention");
    expect(explorerViewSource).toContain("contextPanel === 'attention'");
    expect(explorerViewSource).toContain("selectContextPanel");
    expect(explorerViewSource).toContain("context-panel-content");
    expect(explorerViewSource).toContain("DISPATCHED PLANS");
    expect(explorerViewSource).toContain("ACTIVE RUNS");
    expect(explorerViewSource).not.toContain(":context-selection=\"contextPanel\"");
    expect(explorerViewSource).not.toContain("@select-context=\"selectContextPanel\"");
  });

  it("uses compact button content instead of long menu descriptions", () => {
    expect(explorerViewSource).toContain("context-nav-label");
    expect(explorerViewSource).toContain("context-nav-count");
    expect(explorerViewSource).not.toContain("context-nav-copy");
    expect(explorerViewSource).not.toContain("{{ item.description }}");
  });

  it("renders the context choices as a horizontal tablist", () => {
    expect(explorerViewSource).toContain('role="tablist"');
    expect(explorerViewSource).toContain('role="tab"');
    expect(explorerViewSource).toContain(":aria-selected=");
    expect(explorerViewSource).toContain("context-nav-tab");
  });
});

describe("Explorer thread switching", () => {
  it("reloads the current conversation when the selected thread changes", () => {
    expect(explorerViewSource).toContain("async function selectExplorer(explorerId: string)");
    expect(explorerViewSource).toContain("query: { explorerId }, hash: \"\" });");
    expect(explorerViewSource).toContain("watch(() => route.query.explorerId, () => { if (mounted.value) reloadExplorer(); });");
    expect(explorerViewSource).toContain("api.getExplorerTurns(requestProjectId, selected.id)");
  });
});

describe("Explorer project management wiring", () => {
  it("opens an in-place project management dialog from the project rail", () => {
    expect(explorerViewSource).toContain("projectManagementOpen");
    expect(explorerViewSource).toContain("@manage-projects=\"projectManagementOpen = true\"");
    expect(explorerViewSource).toContain("ProjectManagementDialog");
    expect(explorerViewSource).not.toContain('void router.push("/projects")');
  });
});

describe("Explorer project settings wiring", () => {
  it("opens project settings in a modal without leaving the Explorer", () => {
    expect(explorerViewSource).toContain("projectSettingsOpen");
    expect(explorerViewSource).toContain("ProjectSettingsDialog");
    expect(explorerViewSource).toContain("@open-settings=\"openProjectSettingsDialog\"");
    expect(explorerViewSource).not.toContain("/settings`);");
  });
});

describe("Explorer provider loop layout", () => {
  it("places long diagnostics in a flexible second row", () => {
    expect(explorerViewSource).toContain('<div class="agent-loop-summary">');
    expect(explorerViewSource).toContain('class="agent-loop-status"');
    expect(explorerViewSource).toContain('class="agent-loop-action"');
    expect(explorerStylesSource).toContain(".agent-loop-strip { display: grid;");
    expect(explorerStylesSource).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(explorerStylesSource).toContain(".agent-loop-status {");
    expect(explorerStylesSource).toContain("overflow-wrap: anywhere;");
  });
});

describe("Explorer thread memory removal", () => {
  it("removes the obsolete thread memory entries and drawer", () => {
    expect(threadRailSource).not.toContain("THREAD MEMORY");
    expect(threadRailSource).not.toContain("Successor threads");
    expect(threadRailSource).not.toContain("Context summary");
    expect(explorerViewSource).not.toContain("memoryPanel");
    expect(explorerViewSource).not.toContain("#summary");
    expect(explorerViewSource).not.toContain("#successors");
    expect(explorerViewSource).not.toContain("closeMemoryPanel");
    expect(explorerViewSource).not.toContain("setMemoryPanelOpen");
  });
});

describe("Explorer header actions", () => {
  it("does not render a standalone new Explorer button", () => {
    expect(explorerViewSource).not.toContain('class="new-thread-button"');
    expect(explorerViewSource).not.toContain('aria-label="新建 Explorer"');
  });
});
