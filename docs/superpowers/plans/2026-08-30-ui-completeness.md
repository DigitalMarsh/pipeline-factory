# UI Completeness and Flow Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify every reachable web control and user flow in the Pipeline Factory console, repair invalid navigation or empty/blocked states found by evidence, and finish with a repeatable browser and code verification pass.

**Architecture:** Keep the existing Vue Router/API architecture. Fix only defects that are reproduced in the current UI, add small regression tests at the closest pure boundary, and verify behavior in the running local API/Web application. Destructive execution controls are exercised only on disposable or already isolated local state.

**Tech Stack:** Vue 3, TypeScript, Vue Router, Element Plus, Vite, Vitest, vue-tsc, local Fastify API, in-app Browser.

**Spec:** Confirmed in chat on 2026-08-30; this plan is the scoped execution contract for the full UI button and flow audit.

## Global Constraints

- Preserve existing modified files unless a reproduced defect directly overlaps them.
- Do not stage or modify unrelated `.codegraph/`, `.idea/`, `.pnpm-store/`, or other user-owned changes.
- A visible empty state must explain why it is empty and provide a valid next action.
- A control is valid only when its click produces an observable intended navigation, state change, feedback, or persistence effect.
- Every implementation defect gets a failing regression test before production code changes.
- Do not claim completion until fresh tests, typecheck, build, and browser regression evidence are recorded.

---

### Task 1: Prevent invalid project routes during asynchronous Explorer loading

**Files:**
- Modify: `code/apps/web/src/components/ThreadRail.vue`
- Create: `code/apps/web/src/utils/projectRoutes.ts`
- Test: `code/apps/web/src/utils/projectRoutes.test.ts`

**Interfaces:**
- Produces a route guard/helper that never emits project-scoped links when the project identifier is absent.

**Steps:**
- [ ] Write a test proving an absent project id produces no project route and a valid id produces the expected Explorer/Plan/Settings routes.
- [ ] Run the focused test and confirm it fails for the missing guard behavior.
- [ ] Implement the smallest guard in ThreadRail and reuse the tested route helper if needed.
- [ ] Run the focused test, web typecheck, and browser reload while capturing console warnings.

**Acceptance:** No `/projects//...` route is rendered during the initial Explorer loading state; after data loads all ThreadRail links retain their intended destinations.

### Task 2: Complete live control and state-flow audit

**Files:**
- Modify only files directly implicated by reproduced browser defects.
- Test each changed behavior in its nearest existing or new test file.

**Steps:**
- [ ] Re-run global navigation and Project Catalog controls, including validation, create, archive/activate, and settings entry points.
- [ ] Re-run Explorer drawers, timeline anchors, status popover, Composer, input request, candidate-plan, and Explorer history controls.
- [ ] Re-run Plan Center filters, search, refresh, empty CTA, queued Start run, and terminate confirmation paths.
- [ ] Re-run Run Detail controls across blocked, running, verification, review, and merge states using isolated local data.
- [ ] Re-run Settings tabs, field controls, command add/remove, hooks, Git validation, save, and back navigation.
- [ ] Capture and inspect accepted screenshots for each major route/state and record any named blocker.

**Acceptance:** Each reachable control has an observable intended effect or is visibly and semantically disabled with an explanatory state; no route is blank or lacks a next action.

### Task 3: Final automated and browser verification

**Files:**
- No code changes unless a final regression exposes a new defect; then return to Task 1/2 TDD steps.

**Steps:**
- [ ] Run focused regression tests.
- [ ] Run the complete workspace test suite.
- [ ] Run web typecheck and build.
- [ ] Re-run the full browser matrix from a fresh page load and inspect console errors/warnings.
- [ ] Run `git diff --check` and verify only owned, directly related paths changed.

**Acceptance:** Fresh command output shows zero test failures, zero type/build errors, clean diff-check output, and browser evidence for all required routes and flows; environment-only limitations are reported separately.
