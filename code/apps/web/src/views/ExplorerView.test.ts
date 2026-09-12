import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerViewSource = readFileSync(fileURLToPath(new URL("./ExplorerView.vue", import.meta.url)), "utf8");
const explorerStylesSource = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const explorerTimelineSource = readFileSync(fileURLToPath(new URL("../utils/explorerTimeline.ts", import.meta.url)), "utf8");
const threadRailSource = readFileSync(fileURLToPath(new URL("../components/ThreadRail.vue", import.meta.url)), "utf8");
const projectCatalogSource = readFileSync(fileURLToPath(new URL("./ProjectCatalogView.vue", import.meta.url)), "utf8");
const planCenterSource = readFileSync(fileURLToPath(new URL("../components/PlanCenterPanel.vue", import.meta.url)), "utf8");

describe("Explorer thread actions", () => {
  it("uses a real dropdown menu with rename, policy and refresh actions", () => {
    expect(explorerViewSource).not.toContain("thread-banner");
    expect(explorerViewSource).not.toContain("showThreadBanner");
    expect(explorerViewSource).not.toContain("dismissThreadBanner");
    expect(explorerViewSource).toContain("<el-dropdown");
    expect(explorerViewSource).toContain('popper-class="thread-action-popper"');
    expect(explorerViewSource).toContain('command="rename"');
    expect(explorerViewSource).toContain('command="policy"');
    expect(explorerViewSource).toContain('command="refresh"');
    expect(explorerViewSource).toContain("ExplorerRenameDialog");
    expect(explorerViewSource).toContain("api.renameExplorer");
    expect(explorerViewSource).not.toContain("Manage read-only exploration without changing the repository.");
    expect(explorerViewSource).not.toContain("thread-more-menu");
    expect(explorerViewSource).toContain("View policy");
  });

  it("provides focused styling hooks for the dropdown action rows", () => {
    expect(explorerStylesSource).toContain(".thread-action-popper");
    expect(explorerStylesSource).toContain(".thread-action-menu-item");
    expect(explorerStylesSource).toContain("focus-visible");
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
  it("keeps the current panel count in the compact context header", () => {
    expect(explorerViewSource).toContain('class="context-header-title"');
    expect(explorerViewSource).toContain('class="context-header-count"');
    expect(explorerViewSource).toMatch(/class="context-header-count"[^>]*>\{\{ contextPanelCount \}\}/);
    expect(explorerViewSource).not.toContain('class="context-panel-intro"');
    expect(explorerStylesSource).toContain(".context-header-title");
    expect(explorerStylesSource).toContain(".context-header-count");
  });

  it("connects the right entry rail to an independent dynamic panel", () => {
    expect(explorerViewSource).toContain("contextPanel");
    expect(explorerViewSource).toContain("context-panel-shell");
    expect(explorerViewSource).toContain("context-entry-rail");
    expect(explorerViewSource).toContain("context-entry-button");
    expect(explorerViewSource).not.toContain("context-panel-nav");
    expect(explorerViewSource).toContain("data-context");
    expect(explorerViewSource).toContain('key: "candidate"');
    expect(explorerViewSource).toContain('key: "confirmed"');
    expect(explorerViewSource).toContain('key: "dispatched"');
    expect(explorerViewSource).toContain('key: "active"');
    expect(explorerViewSource).toContain('key: "attention"');
    expect(explorerViewSource).toContain("needsAttentionCount");
    expect(explorerViewSource).toContain("Needs attention");
    expect(explorerViewSource).toContain("contextPanel === 'attention'");
    expect(explorerViewSource).toContain("selectContextPanel");
    expect(explorerViewSource).toContain("context-panel-content");
    expect(explorerViewSource).toContain("PLAN CANDIDATE");
    expect(explorerViewSource).toContain("CONFIRMED PLANS");
    expect(explorerViewSource).toContain("DISPATCHED PLANS");
    expect(explorerViewSource).toContain("ACTIVE RUNS");
    expect(explorerViewSource).toContain("NEEDS ATTENTION");
    expect(explorerViewSource).toContain("confirmedPlans");
    expect(explorerViewSource).toContain("api.explorerConfirmedPlans");
    expect(explorerViewSource).toContain("contextPanel === 'confirmed'");
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

  it("uses a semantic style hook for the confirmed entry", () => {
    expect(explorerViewSource).toContain("context-entry-confirmed");
    expect(explorerStylesSource).toContain(".context-entry-confirmed .context-entry-icon");
  });

  it("exposes enqueue action for READY plans in the confirmed panel", () => {
    const confirmedSection = explorerViewSource.match(/<section v-else-if="contextPanel === 'confirmed'"[\s\S]*?<\/section>/)?.[0] ?? "";
    const enqueueSource = explorerViewSource.match(/async function enqueuePlan[\s\S]*?\n\}/)?.[0] ?? "";

    expect(confirmedSection).toContain("plan.status === 'READY'");
    expect(confirmedSection).toContain('@click="enqueuePlan(plan)"');
    expect(confirmedSection).toContain("Enqueue plan");
    expect(enqueueSource).toContain("plan: Plan | null = candidate.value");
    expect(enqueueSource).toContain("const id = plan.id ?? plan.planId");
  });

  it("separates Enqueued from Dispatched and embeds Plan Center in the context rail", () => {
    const enqueuedSection = explorerViewSource.match(/<section v-else-if="contextPanel === 'enqueued'"[\s\S]*?<\/section>/)?.[0] ?? "";

    expect(explorerViewSource).toContain('key: "enqueued"');
    expect(explorerViewSource).toContain('key: "plan-center"');
    expect(enqueuedSection).toContain("plan.status === 'ENQUEUED'");
    expect(enqueuedSection).toContain('@click="startPlanRun(plan)"');
    expect(enqueuedSection).toContain("Start run");
    expect(explorerViewSource).toContain('<PlanCenterPanel :project-id="projectId"');
    expect(explorerViewSource).toContain("plan.dispatchedAt !== null");
  });

  it("makes configuration-blocked dispatched plans recoverable", () => {
    const dispatchedSection = explorerViewSource.match(/<section v-else-if="contextPanel === 'dispatched'"[\s\S]*?<\/section>/)?.[0] ?? "";

    expect(dispatchedSection).toContain("NEEDS_CONFIGURATION");
    expect(dispatchedSection).toContain("Configure verification commands");
    expect(dispatchedSection).toContain("Create updated revision");
    expect(explorerViewSource).toContain("api.revisePlanConfiguration");
    expect(planCenterSource).toContain("NEEDS_CONFIGURATION");
    expect(planCenterSource).toContain("Create updated revision");
    expect(planCenterSource).toContain("Configure verification commands");
  });

  it("uses the project-wide run projection for Active runs, including STARTING", () => {
    const activeSection = explorerViewSource.match(/<section v-else-if="contextPanel === 'active'"[\s\S]*?<\/section>/)?.[0] ?? "";

    expect(explorerViewSource).toContain("const projectRuns = ref<Run[]>([])");
    expect(explorerViewSource).toContain("api.projectRuns(requestProjectId)");
    expect(explorerViewSource).toContain('["STARTING", "IN_PROGRESS", "VERIFYING"].includes(run.status)');
    expect(activeSection).toContain('v-for="run in activeRuns"');
    expect(activeSection).toContain("Run {{ run.id }}");
    expect(activeSection).toContain('`/projects/${run.projectId}/runs/${run.id}`');
    expect(activeSection).toContain("Starting, running, and verifying runs across this project appear here.");
  });

  it("opens the same full-plan drawer from every context stage", () => {
    expect(explorerViewSource).toContain("const detailPlan = ref<Plan | null>(null)");
    expect(explorerViewSource).toContain("function openPlanDetail(plan: Plan)");
    expect(explorerViewSource).toContain('<PlanDetailDrawer v-model="drawerOpen" :plan="detailPlan"');
    expect(explorerViewSource).toContain('@click="openPlanDetail(candidate)"');

    for (const panel of ["confirmed", "enqueued", "dispatched", "attention"]) {
      const section = explorerViewSource.match(new RegExp(`<section v-else-if="contextPanel === '${panel}'"[\\s\\S]*?<\\/section>`))?.[0] ?? "";
      expect(section).toContain('@click="openPlanDetail(plan)"');
      expect(section).toContain("View full plan");
    }

    expect(planCenterSource).toContain("emit('view-plan', plan)");
    expect(planCenterSource).toContain("View full plan");
  });
});

describe("Explorer panel state independence", () => {
  it("keeps left navigation and right context selection as separate state", () => {
    expect(explorerViewSource).toContain('type LeftPanel = "projects" | "explorers"');
    expect(explorerViewSource).toContain('const leftPanel = ref<LeftPanel>("explorers")');
    expect(explorerViewSource).toContain('const contextPanel = ref<ContextPanel>("candidate")');
    expect(explorerViewSource).toContain('const confirmedPlans = ref<Plan[]>([])');
    expect(explorerViewSource).toContain("function syncPanelStateFromRoute()");
    expect(explorerViewSource).toContain("function panelStateQuery()");
    expect(explorerViewSource).toContain("function explorerRouteQuery");
    expect(explorerViewSource).toContain("...panelStateQuery()");

    const resetSource = explorerViewSource.match(/function resetProjectState\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).not.toContain("leftPanel.value");
    expect(resetSource).not.toContain('contextPanel.value = "candidate"');
  });

  it("keeps Explorer as the refresh default and removes left-panel persistence from navigation", () => {
    expect(explorerViewSource).toContain('const leftPanel = ref<LeftPanel>("explorers")');
    expect(explorerViewSource).toContain("function explorerRouteQuery");
    expect(explorerViewSource).not.toContain("const routeLeftPanel = route.query.leftPanel");
    expect(explorerViewSource).toMatch(/function panelStateQuery\(\) \{[\s\S]*?return \{ contextPanel: contextPanel\.value \};/);
  });
});

describe("Explorer candidate action layout", () => {
  it("does not offer manual candidate creation when the thread has no candidate", () => {
    const candidateSection = explorerViewSource.match(/<section v-if="contextPanel === 'candidate'"[\s\S]*?<\/section>/)?.[0] ?? "";

    expect(candidateSection).toContain("No candidate plan");
    expect(candidateSection).not.toContain("Create candidate plan");
    expect(explorerViewSource).not.toContain("candidateEmptyOpen");
    expect(explorerViewSource).not.toContain("candidateTitle");
    expect(explorerViewSource).not.toContain("createCandidate");
    expect(explorerViewSource).not.toContain("api.createExplorerCandidate");
  });

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

describe("Explorer message timeline", () => {
  it("uses one-line neutral time and type labels while retaining existing targets", () => {
    expect(explorerViewSource).toContain("const messageTimelineItems = computed<TimelineNavItem[]>(() => buildExplorerMessageTimeline");
    expect(explorerTimelineSource).toContain('label: "消息"');
    expect(explorerTimelineSource).toContain('label: "提问"');
    expect(explorerTimelineSource).toContain('label: "回答"');
    expect(explorerTimelineSource).not.toContain('label: "You"');
    expect(explorerTimelineSource).not.toContain('label: "Plan Explorer"');
    expect(explorerViewSource).toContain("{{ item.detail }} - {{ item.label }}");
    expect(explorerViewSource).toContain('@click="jumpToTimelineTarget(item.target, item.activationKey)"');
    expect(explorerStylesSource).toContain(".timeline-rail-messages .timeline-rail-item { align-items: center; min-height: 32px; padding-top: 5px; padding-bottom: 5px; }");
    expect(explorerStylesSource).toContain(".timeline-rail-messages .timeline-rail-copy { display: inline-flex;");
  });

  it("renders each bound plan only in its generating assistant message and inserts detached plans into the shared timeline", () => {
    expect(explorerViewSource).toContain("const planBindings = computed(() => buildPlanActivityBindings");
    expect(explorerViewSource).toContain("buildExplorerTimeline(visibleActivity.value, inputRequests.value, detachedPlans.value)");
    expect(explorerViewSource).toContain("v-else-if=\"item.kind === 'plan'\"");
    expect(explorerViewSource).not.toContain("syntheticPlanItems");
    expect(explorerViewSource).not.toContain("v-for=\"item in syntheticPlanItems\"");
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
    expect(explorerStylesSource).toContain(".context-entry-confirmed .context-entry-icon { color: #70d5a4; }");
    expect(explorerStylesSource).toContain(".context-entry-dispatched .context-entry-icon { color: #9ddcff; }");
    expect(explorerStylesSource).toContain(".context-entry-active .context-entry-icon { color: #75baf2; }");
    expect(explorerStylesSource).toContain(".context-entry-attention .context-entry-icon { color: #f19aa0; }");
  });
});

describe("Explorer thread switching", () => {
  it("reloads the current conversation when the selected thread changes", () => {
    expect(explorerViewSource).toContain("async function selectExplorer(explorerId: string)");
    expect(explorerViewSource).toContain("query: explorerRouteQuery(explorerId), hash: \"\" });");
    expect(explorerViewSource).toContain("void reloadSelectedExplorer();");
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
    expect(explorerTimelineSource).toContain("key: `message:${item.activity.id}`");
    expect(explorerViewSource).toContain("activeTimelineKey === item.target");
  });

  it("resets archived-thread visibility when switching projects", () => {
    expect(explorerViewSource).toContain('const showArchivedExplorers = ref(false)');
    expect(explorerViewSource).toContain('const explorerActionId = ref<string | null>(null)');
    const resetSource = explorerViewSource.match(/function resetProjectState\(nextProjectId = projectId\.value\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(resetSource).toContain("showArchivedExplorers.value = false");
  });

  it("keeps the directory visible when a selected thread projection fails", () => {
    expect(explorerViewSource).toContain("const explorerLoading = ref(true)");
    expect(explorerViewSource).toContain("const explorerError = ref<string | null>(null)");
    expect(explorerViewSource).toContain("async function loadExplorerDetails");
    expect(explorerViewSource).toContain("async function loadExplorerDirectory");
    const loadCatch = explorerViewSource.match(/async function loadExplorerDirectory[\s\S]*?\n\}/)?.[0] ?? "";
    expect(loadCatch).not.toContain("explorers.value = []");
  });

  it("loads route-selected threads without reloading the whole directory", () => {
    expect(explorerViewSource).toContain("loadExplorerDetails");
    expect(explorerViewSource).toContain("watch(() => route.query.explorerId");
    expect(explorerViewSource).toContain("routeExplorerId === thread.value?.id");
    expect(explorerViewSource).not.toContain("watch(() => route.query.explorerId, () => { if (mounted.value) reloadExplorer(); });");
  });

  it("keeps thread loading compatible with API instances without confirmed-plan projection", () => {
    const detailSource = explorerViewSource.match(/async function loadExplorerDetails[\s\S]*?\n\}/)?.[0] ?? "";
    const refreshSource = explorerViewSource.match(/async function refreshPlanProjection[\s\S]*?\n\}/)?.[0] ?? "";
    expect(detailSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, selected.id))");
    expect(detailSource).toContain("confirmedResponse?.items ?? []");
    expect(refreshSource).toContain("optional(() => api.explorerConfirmedPlans(requestProjectId, explorerId))");
    expect(refreshSource).toContain("confirmedResponse?.items ?? []");
  });

  it("wires directory state into ThreadRail and creates a selected thread", () => {
    expect(explorerViewSource).toContain(":explorer-loading=\"explorerLoading\"");
    expect(explorerViewSource).toContain(":explorer-error=\"explorerError\"");
    expect(explorerViewSource).toContain("explorers.value = [created.explorer");
    expect(explorerViewSource).toContain("thread.value = created.explorer");
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

describe("Explorer composer availability", () => {
  it("keeps the composer editable while a turn is running and only locks the send button", () => {
    expect(explorerViewSource).toContain(`<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused"`);
    expect(explorerViewSource).not.toContain(`<textarea v-model="draft" :disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || explorerPaused || busy"`);
    expect(explorerViewSource).toContain(`:disabled="!thread || thread?.state === 'ARCHIVED' || project?.status === 'ARCHIVED' || !draft.trim() || explorerPaused || busy"`);
  });

  it("explains why the send button is unavailable while the current turn is running", () => {
    expect(explorerViewSource).toContain(`:title="busy ? '当前回合执行中，完成后可发送' : 'Send message'"`);
    expect(explorerViewSource).toContain(`if (!content || busy.value || !thread.value || thread.value.state === "ARCHIVED"`);
  });
});

describe("Explorer markdown rendering", () => {
  it("renders message bodies through the shared Markdown component", () => {
    expect(explorerViewSource).toContain('import MarkdownMessage from "../components/MarkdownMessage.vue"');
    expect(explorerViewSource).toContain(`<MarkdownMessage :source="item.activity.kind === 'ASSISTANT_MESSAGE' ? readableAssistantText(item.activity.summary) : item.activity.summary" :streaming="item.activity.status === 'RUNNING'" />`);
    expect(explorerViewSource).not.toContain(`: item.activity.summary }}<span v-if="item.activity.status === 'RUNNING'" class="processing-dots"`);
  });
});
