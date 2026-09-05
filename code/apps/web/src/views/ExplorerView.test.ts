import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const threadRailSource = readFileSync(fileURLToPath(new URL("../components/ThreadRail.vue", import.meta.url)), "utf8");
const projectCatalogSource = readFileSync(fileURLToPath(new URL("./ProjectCatalogView.vue", import.meta.url)), "utf8");

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
    expect(explorerViewSource).toContain(":panel=\"leftPanel\"");
    expect(explorerViewSource).toContain(":projects=\"projects\"");
    expect(explorerViewSource).toContain(":explorers=\"explorers\"");
    expect(explorerViewSource).toContain(":show-archived=\"showArchivedExplorers\"");
    expect(explorerViewSource).toContain(":explorer-action-id=\"explorerActionId\"");
    expect(explorerViewSource).toContain("@select-panel=\"leftPanel = $event\"");
    expect(explorerViewSource).toContain("@select-project=\"switchProject\"");
    expect(explorerViewSource).toContain("@select-explorer=\"selectExplorer\"");
    expect(explorerViewSource).toContain("@toggle-show-archived=\"showArchivedExplorers = $event\"");
    expect(explorerViewSource).toContain("@archive-explorer=\"toggleExplorerArchive\"");
    expect(explorerViewSource).toContain("@create-explorer=\"createExplorer\"");
    expect(explorerViewSource).toContain("@create-project=\"openProjectCreateDialog\"");
    expect(explorerViewSource).toContain("projectPathForModule(\"explore\", selectedProjectId)");
    expect(explorerViewSource).toContain("@open-project=\"switchProject\"");
  });

  it("renders Explorer threads inline without the history drawer", () => {
    expect(threadRailSource).toContain("explorer-list");
    expect(threadRailSource).toContain("class=\"left-panel-create\"");
    expect(explorerViewSource).not.toContain("ExplorerHistoryDrawer");
    expect(explorerViewSource).not.toContain("historyOpen");
    expect(explorerViewSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("open-history");
    expect(threadRailSource).not.toContain("thread-identity");
  });
});

describe("Explorer context panel wiring", () => {
  it("connects the right entry rail to an independent dynamic panel", () => {
    expect(explorerViewSource).toContain("contextPanel");
    expect(explorerViewSource).toContain("context-panel-shell");
    expect(explorerViewSource).toContain("context-entry-rail");
    expect(explorerViewSource).toContain("context-entry-button");
    expect(explorerViewSource).not.toContain("context-panel-nav");
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
    expect(explorerViewSource).toContain("PLAN CANDIDATE");
    expect(explorerViewSource).toContain("DISPATCHED PLANS");
    expect(explorerViewSource).toContain("ACTIVE RUNS");
    expect(explorerViewSource).toContain("NEEDS ATTENTION");
    expect(explorerViewSource).not.toContain(":context-selection=\"contextPanel\"");
    expect(explorerViewSource).not.toContain("@select-context=\"selectContextPanel\"");
  });

  it("uses compact button content instead of long menu descriptions", () => {
    expect(explorerViewSource).toContain("context-entry-label");
    expect(explorerViewSource).toContain("context-entry-count");
    expect(explorerViewSource).not.toContain("context-entry-copy");
    expect(explorerViewSource).not.toContain("{{ item.description }}");
  });

  it("renders the context choices as a vertical entry rail", () => {
    expect(explorerViewSource).toContain('role="tablist"');
    expect(explorerViewSource).toContain('role="tab"');
    expect(explorerViewSource).toContain(":aria-selected=");
    expect(explorerViewSource).toContain("context-entry-button");
  });

  it("keeps the right entry rail beside the content instead of inside its column", () => {
    expect(explorerViewSource).toMatch(/<div class="context-panel">[\s\S]*?<div class="context-panel-scroll">[\s\S]*?<\/div>\s*<\/div>\s*<nav class="context-entry-rail"/);
  });
});

describe("Explorer panel state independence", () => {
  it("keeps left navigation and right context selection as separate state", () => {
    expect(explorerViewSource).toContain('type LeftPanel = "projects" | "explorers"');
    expect(explorerViewSource).toContain('const leftPanel = ref<LeftPanel>("explorers")');
    expect(explorerViewSource).toContain('const contextPanel = ref<ContextPanel>("candidate")');
    expect(explorerViewSource).toContain("function syncPanelStateFromRoute()");
    expect(explorerViewSource).toContain("function panelStateQuery()");
    expect(explorerViewSource).toContain("query: panelStateQuery()");
    expect(explorerViewSource).toContain("...panelStateQuery()");

    const resetSource = explorerViewSource.match(/function resetProjectState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).not.toContain("leftPanel.value");
    expect(resetSource).not.toContain('contextPanel.value = "candidate"');
  });
});

describe("Explorer candidate action layout", () => {
  it("keeps right-panel plan actions on one equal-width row", () => {
    expect(explorerStylesSource).toMatch(/\.context-plan-card \.candidate-actions \{[^}]*flex-wrap: nowrap;/);
    expect(explorerStylesSource).toMatch(/\.context-plan-card \.candidate-actions \.el-button \{[^}]*flex: 1 1 0;[^}]*min-width: 0;[^}]*margin-left: 0;/);
  });
});

describe("Explorer rail layout", () => {
  it("gives both rails fixed entry columns while preserving timeline-only scrolling", () => {
    expect(explorerStylesSource).toContain(".left-entry-rail");
    expect(explorerStylesSource).toContain(".context-entry-rail");
    expect(explorerStylesSource).toContain(".context-panel-shell");
    expect(explorerStylesSource).toMatch(/grid-template-columns: 330px minmax\(560px, 1fr\) 360px;/);
    expect(explorerStylesSource).toContain(".timeline { flex: 1 1 auto;");
    expect(explorerStylesSource).toContain("overflow-y: auto;");
    expect(explorerStylesSource).toContain(".composer { flex: 0 0 auto;");
  });
});

describe("Explorer context panel dark theme", () => {
  it("uses the left navigation palette across the right panel surfaces", () => {
    expect(explorerStylesSource).toMatch(/\.context-panel-shell \{[^}]*background: #101827;/);
    expect(explorerStylesSource).toMatch(/\.context-panel-shell \.context-panel \{[^}]*background: #101827;/);
    expect(explorerStylesSource).toMatch(/\.context-entry-rail \{[^}]*border-left: 1px solid #29364d;[^}]*background: #101a2b;/);
    expect(explorerStylesSource).toMatch(/\.context-entry-button \{[^}]*border: 1px solid #293b58;[^}]*background: #16253d;[^}]*color: #91a5c0;/);
    expect(explorerStylesSource).toMatch(/\.context-entry-button\.active \{[^}]*border-color: #4c9cf0;[^}]*background: #24548b;[^}]*color: #fff;/);
    expect(explorerStylesSource).toMatch(/\.context-panel-shell \.context-plan-card \{[^}]*border: 1px solid #355b8b;[^}]*background: #16253d;/);
    expect(explorerStylesSource).toMatch(/\.context-panel-shell \.context-plan-row \{[^}]*border: 1px solid #293b58;[^}]*background: #16253d;/);
  });

  it("keeps dark-theme interaction states and semantic entry colors", () => {
    expect(explorerStylesSource).toMatch(/\.context-entry-button:hover, \.context-entry-button:focus-visible \{[^}]*border-color: #4f86d7;[^}]*background: #1b3559;[^}]*color: #dcecff;/);
    expect(explorerStylesSource).toContain(".context-entry-button:nth-child(2) .context-entry-icon { color: #70d5a4; }");
    expect(explorerStylesSource).toContain(".context-entry-button:nth-child(3) .context-entry-icon { color: #75baf2; }");
    expect(explorerStylesSource).toContain(".context-entry-button:nth-child(4) .context-entry-icon { color: #f19aa0; }");
  });
});

describe("Explorer thread switching", () => {
  it("reloads the current conversation when the selected thread changes", () => {
    expect(explorerViewSource).toContain("async function selectExplorer(explorerId: string)");
    expect(explorerViewSource).toContain("query: { explorerId, ...panelStateQuery() }, hash: \"\" });");
    expect(explorerViewSource).toContain("watch(() => route.query.explorerId, () => { if (mounted.value) reloadExplorer(); });");
    expect(explorerViewSource).toContain("api.getExplorerTurns(requestProjectId, selected.id)");
  });

  it("separates Explorer creation from turn busy state and clears stale thread data", () => {
    expect(explorerViewSource).toContain("const creatingExplorer = ref(false)");
    expect(explorerViewSource).toContain("if (creatingExplorer.value) return;");
    expect(explorerViewSource).not.toContain("async function createExplorer() {\n  if (busy.value) return;");
    expect(explorerViewSource).toContain("function resetThreadState()");
    expect(explorerViewSource).toContain("requestScope.invalidate();");
    expect(explorerViewSource).toContain(":creating-explorer=\"creatingExplorer\"");
  });

  it("keeps message navigation keys unique when a turn has multiple assistant activities", () => {
    expect(explorerViewSource).toContain("key: `message:${item.activity.id}`");
    expect(explorerViewSource).toContain("activeTimelineKey === item.target");
  });

  it("resets archived-thread visibility when switching projects", () => {
    expect(explorerViewSource).toContain('const showArchivedExplorers = ref(false)');
    expect(explorerViewSource).toContain('const explorerActionId = ref<string | null>(null)');
    const resetSource = explorerViewSource.match(/function resetProjectState\(nextProjectId = projectId\.value\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("showArchivedExplorers.value = false");
  });
});

describe("Explorer project management wiring", () => {
  it("uses inline project actions instead of a Manage Projects dialog", () => {
    expect(explorerViewSource).not.toContain("projectManagementOpen");
    expect(explorerViewSource).not.toContain("@manage-projects");
    expect(explorerViewSource).not.toContain("ProjectManagementDialog");
    expect(explorerViewSource).toContain("@open-project=\"switchProject\"");
    expect(explorerViewSource).toContain("@create-project=\"openProjectCreateDialog\"");
    expect(explorerViewSource).toContain("ProjectCreateDialog");
    expect(explorerViewSource).toContain("@open-project-settings=\"openProjectSettingsDialog\"");
    expect(explorerViewSource).toContain("@archive-project=\"toggleProjectArchive\"");
    expect(explorerViewSource).not.toContain('void router.push("/projects")');
  });

  it("opens project creation in the current Explorer dialog", () => {
    expect(explorerViewSource).toContain("projectCreateOpen");
    expect(explorerViewSource).toContain("function openProjectCreateDialog()");
    expect(explorerViewSource).not.toContain('void router.push("/projects/new")');
    expect(explorerViewSource).toContain("@project-created=\"handleProjectCreated\"");
  });

  it("preserves the project catalog while clearing the old Explorer projection", () => {
    const resetSource = explorerViewSource.match(/function resetProjectState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).not.toContain("projects.value = []");
    expect(explorerViewSource).toContain("projects.value.find((item) => item.id === nextProjectId)");
    expect(explorerViewSource).toContain("resetThreadState();");
  });
});

describe("Explorer project settings wiring", () => {
  it("opens project settings in a modal without leaving the Explorer", () => {
    expect(explorerViewSource).toContain("projectSettingsOpen");
    expect(explorerViewSource).toContain("ProjectSettingsDialog");
    expect(explorerViewSource).toContain("@open-project-settings=\"openProjectSettingsDialog\"");
    expect(explorerViewSource).not.toContain("/settings`);");
  });
});

describe("Project catalog project creation wiring", () => {
  it("uses the shared creation dialog instead of navigating to a standalone page", () => {
    expect(projectCatalogSource).toContain("ProjectCreateDialog");
    expect(projectCatalogSource).toContain("createOpen");
    expect(projectCatalogSource).not.toContain('void router.push("/projects/new")');
    expect(projectCatalogSource).toContain("@project-created=\"handleProjectCreated\"");
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
