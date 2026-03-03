# Session Changelog — 3 March 2026

All changes are uncommitted on `main`. Tests: **765 pass, 0 fail** (up from ~586 at session start). Benchmark database: 2,146 tasks, 369 projects, 31 tags, 33 folders (3 March 2026).

---

## Bug Fixes

- **#1 — container() sub-predicate stub rows.** `container('project', pred)` now provides full project field coverage to sub-predicates. Previously, the lookup scan only included `id`, causing predicates on `name` etc. to fail silently. (`lowerToSetIr.ts`)
- **#2/#3 — containing() active-filter omission.** `containing('project', pred)` now injects the active filter for the child entity (tasks), so completed/dropped tasks are excluded. Added `containingActiveFilter.test.ts`. (`lowerToSetIr.ts`)
- **#29 — false e2e test failure.** Diagnosed as stale `dist/` artifacts from concurrent agent work, not a code bug. No code change.
- **#50 — container() complex predicate coverage.** Added tests verifying `container('project', pred)` works with `or`, `not`, and multi-field predicates. All pass after the #1 fix.
- **#71 — ENTITY_TYPES exhaustiveness gap.** `lowerToSetIr.ts` had a switch on entity type that silently fell through for future entity additions. Tightened to exhaustive check with compile-time error.
- **#74 — Single-element `in` → `eq` rewrite.** New `normalizeAst.ts` pass rewrites `{in: [expr, [singleValue]]}` to `{eq: [expr, singleValue]}` before the query reaches the planner. Enables downstream optimisations that require equality form and eliminates degenerate set membership checks. (`normalizeAst.ts`, `test/normalizeAst.test.ts`)
- **#75/#77 — RowCount column pruner forces unnecessary `id` bulk read.** `pruneColumns()` was propagating `new Set(['id'])` into `RowCount`'s source, forcing an `id` bulk read even for pure count queries where `id` is never used. Fixed to propagate `new Set()` — Filter/SemiJoin nodes upstream add only the columns they actually need. (~140ms saved per filtered `op:count` query). Added end-to-end JXA script tests verifying: task-only predicates (`inInbox=true`) produce no `.id()` call; non-task-only predicates (`flagged=true`) correctly retain `.id()` for project exclusion SemiJoin.
- **#78 — inferEntity fallback in nodeUnit should throw.** `inferEntity()` in `nodeUnit.ts` was silently defaulting to `'tasks'` for nodes without an entity annotation. Changed to throw `"nodeUnit: cannot infer entity for ref %N"` so misbehaving plans surface immediately rather than producing silently wrong results.
- **Union column pruner correctness fix.** The Union case in `pruneColumns()` was silently dropping the `id` column needed by `execUnion` for row deduplication, causing Union queries to return duplicate rows. Fixed to always propagate `id` to both Union inputs regardless of what downstream requests.
- **Count EventPlan node `.length` → `.count()` fix.** `jxaUnit.ts` emitted `.length` on AE specifier references in the `Count` node, which returns `undefined` in JXA (JavaScript array property, not the AE `count` command). Fixed to emit `.count()` (dispatches `corecnte` natively). The `Count` node is not currently produced by the standard lowering path (SetIR `Count` → `RowCount`), so this was a latent bug rather than an active one.

## Refactoring

- **#4 — JOIN_PROPS into aeProps.** Moved join-based enrichment specs (`folderName`, `parentName`) from `lowerSetIrToEventPlan.ts` into `aeProps.ts` as `joinSpec` on `ChainProp`. Centralises all AE property metadata.
- **#5 — Computed var consolidation.** Eliminated duplication between `variables.ts` and `nodeUnit.ts` for computed var definitions (`status`, `hasChildren`, `folderStatus`). Single source of truth in `variables.ts`.
- **#6 — Better error messages.** `propSpec()` in `aeProps.ts` now distinguishes "known variable without AE mapping" from "completely unknown variable". Includes cost tier and suggestion to check `getVarRegistry()`.
- **#7 — Cost tier collapse.** Merged `per-item` cost tier into `expensive`. Two-tier model: cheap (`easy`/`chain`/`computed`) vs expensive (`expensive`). Removed dead `per-item` classification.
- **#8 — jxaUnit parentIsChain suppression.** Narrowed the `parentIsChain` transform in `jxaUnit.ts` to only suppress when the parent specifier is actually a chain property, not all Property nodes.
- **#24/#25 — OmniJS dead code deletion.** Removed `omniJsUnit.ts` (419 lines), `omniJsUnit.test.ts` (477 lines), and all OmniJS dispatch paths in `orchestrator.ts`. OmniJS was unreachable after the SetIR migration.

## Optimisations

- **#21 — CSE dedup for Zip/ColumnValues.** Fixed CSE to deduplicate `Zip` and `ColumnValues` nodes with identical structure, eliminating redundant Apple Events reads in `container(project)` + project-exclusion queries. (~100ms saved)
- **#22 — mergeSemiJoins pass.** New `eventPlanMergeSemiJoins.ts` collapses multiple Node-side SemiJoins (include + exclude on same source) into a single `SetOp` node. Added `SetOp` as first-class EventPlan node kind. (~1-2ms CPU)
- **#27 — Column pruner gaps.** Added `Union` and `RowCount` cases to `eventPlanColumnPrune.ts`. Union propagates needed columns (plus `id` for deduplication) to both sides; RowCount propagates empty set so intermediate Filter/SemiJoin nodes supply only what they need. (RowCount's `id` forcing subsequently fixed in #75.)
- **#28 — Scan subsumption.** New `widenScansToUnion` pass in `optimizeSetIr()` widens same-entity Scan nodes to the union of their column sets, enabling CSE to deduplicate them. (~100ms saved per deduplicated scan)
- **#30 — Skip project exclusion.** When a task predicate uses only task-specific variables (`flagged`, `inInbox`, etc.), the `Difference(plan, Scan(projects))` node is provably redundant and skipped. (~100ms saved)
- **#31 — Filter+Limit fusion.** `nodeUnit.ts` detects `Filter -> Limit(N)` patterns where the Filter has a single consumer and short-circuits after N matches. Key for `op:'exists'` (Limit(1)).
- **#32 — JXA fusion JSON cycle.** Eliminated redundant `JSON.stringify` -> return -> `JSON.parse` -> re-embed cycle when consecutive JXA execution units are fused into one `osascript` invocation. (~1-5ms saved per fused boundary)
- **#33 — Tag semi-join shortcut.** New `TagNameTaskIds` SetIR node + `tagNameShortcut` optimizer pass. Rewrites `contains(tags, 'literal')` at SetIR level to a targeted `.whose({name:}) -> .tasks.id()` membership scan (~140ms) instead of bulk-reading all tag IDs per task (~260ms + filter). Lowers to a `Get(Whose)` + `Get(Elements)` + `Get(Property)` chain in EventPlan.
- **#45 — Column pruner: ForEach body pruning.** Extended the column pruner to reach inside `ForEach` bodies. Prunes unused property Get nodes within the body and compacts body-local indices. Eliminates dead per-item round-trips for expensive columns that the final Pick doesn't need.
- **#55 — Skip `id` column in single-unit JXA scans.** When a Scan's `id` column is not needed by any downstream cross-unit consumer, it is removed from the Zip before emission, saving one bulk read (~140ms) in single-EU plans.
- **#58/#32 — JSON elimination in fused units.** When all JXA units in a batch are fused into a single `osascript` call, the intermediate JSON.stringify/parse cycle between units is eliminated. The composite script uses raw JS object passing instead. (~1-5ms per fused boundary)
- **#66 — Native count fast-path (~7× speedup).** Unfiltered `op:'count'` queries now use `doc.flattenedTasks.length` (a native AE count event) instead of bulk-reading all IDs. ~12ms vs ~200ms for the full pipeline. For tasks, subtracts `flattenedProjects.length` to exclude project root tasks. `buildNativeCountScript()` exported for unit testing.
- **#66 (addendum) — Native exists fast-path.** Unfiltered `op:'exists'` queries dispatch the native AE `exists` command (`coredoex`) via `.exists()` on the collection specifier for projects/folders/tags. For tasks, falls back to length arithmetic (`flattenedTasks.length - flattenedProjects.length > 0`) since `.exists()` on `flattenedTasks` would return `true` even when only project root tasks exist. `buildNativeExistsScript()` exported for unit testing.
- **EventPlan node reordering pass.** New `eventPlanReorder.ts` reorders EventPlan nodes using priority-queue topological sort with runtime-aware tie-breaking. Groups same-runtime operations together to reduce ExecutionUnit splits and IPC round-trips. Runs after CSE and column pruning, before runtime assignment.

## Infrastructure

- **#40 — enrichByIdentifier() utility.** New `src/utils/omniJsEnrich.ts` implements deferred enrichment via OmniJS `byIdentifier()` for small result sets (<50 items). 66 new tests in `test/omniJsEnrich.test.ts`.
- **#41 — analyseColumnOverlap() helper.** New utility for analysing column overlap between filter-only and output-only columns. Informs the deferred enrichment decision (which columns to read eagerly vs defer).
- **#44 — Adaptive deferred enrichment.** `orchestrator.ts` now detects queries with `limit ≤ 50` and ≥3 output-only columns and switches to a two-phase path: filter-only bulk scan → `enrichByIdentifier()` for surviving rows only. Skips reading expensive columns (e.g. `note`) for the ~2000 tasks that don't match. Decision logic: `DEFERRED_ENRICH_MAX_ROWS = 50`, `DEFERRED_ENRICH_MIN_OUTPUT_COLS = 3`.

## Investigations

- **#80 — containing() FK semi-join 3x slower than expected.** Investigated the `containing('project', pred)` path being ~3x slower than a direct task scan with predicate. Root cause: the containing path uses a HashJoin (FK lookup from tasks → projects), which requires two separate bulk scans. The performance gap is expected and not a bug — direct `container()` with same predicate uses a SemiJoin (single scan + lookup). Documented as expected behaviour.

- **#38 — AppleScript codegen for wide bulk reads.** Investigated generating AppleScript instead of JXA for 8+ property reads (motivated by benchmark data showing 2-4x JXA bridge tax). Verdict: not worth implementing — the bridge tax was not consistently reproducible in controlled retesting, and the complexity of maintaining two codegen backends outweighs the uncertain gains. Design note: `docs/applescript-codegen-design.md`.
- **#47 — Predicate pushdown into Restriction lookup nodes.** Investigated pushing filter predicates into Restriction's lookup side (e.g. pushing a tag-name filter into the tag scan before the join). Verdict: not worth implementing — the tag semi-join shortcut (#33) already handles the common case, and general pushdown would add complexity for marginal gains.
- **#57 — Native AE count/exists for filtered queries.** Investigated whether `whose()` + `.count()` could answer filtered count queries in one AE round-trip. Verdict: `whose()` is slow (~31s on 751 tasks) and AE count events are not atomic with filtering. Not implementable. Design note: `docs/native-ae-count-exists.md`.
- **#58 — JSON elimination in single-fused units.** Investigated skipping JSON.stringify/parse when a plan fits in a single fused JXA invocation. Implemented for the fused-multi-unit case (#32); design note documents single-unit case: `docs/json-elimination.md`.
- **#59/#60 — Reuse audit for Mail and DEVONthink MCP servers.** Reviewed whether the query engine could be extracted for reuse across MCP servers. Verdict: wait for a second concrete consumer before abstracting. Findings: `docs/mail-reuse-audit.md`, `docs/devonthink-reuse-audit.md`.

## Refactoring (continued)

- **#81 — compactPlan() shared utility.** Extracted the three-phase compaction pattern (survivors → remap → rewriteNode) shared by `eventPlanCSE.ts`, `eventPlanColumnPrune.ts`, and `eventPlanMergeSemiJoins.ts` into a single `compactPlan(nodes, result, survivors, errorTag?)` function in `eventPlanUtils.ts`. Removed the 40-line local `compact()` function from `eventPlanMergeSemiJoins.ts` (which also had its own incomplete reachability walk using raw field access instead of `collectRefs`). Pure refactor — no behaviour change.

## Architecture Reviews

- **#67 — Brainstorm: second-round optimisation opportunities.** Catalogued 10+ further optimisation ideas after round 1 was substantially implemented. `docs/optimisation-ideas-round2.md`. Top candidates: batch byIdentifier reads for Enrich, `in`→`eq` normalisation, predicate-aware sort elimination.
- **#68 — SetIR architecture critique.** Critical review of the SetIR layer: node type count, Restriction design, optimizer pass structure, lowering correctness. Findings: `docs/setir-architecture-critique.md`.
- **#69 — EventPlan IR architecture critique.** Critical review of the EventPlan IR: SSA ref tracking, runtime annotation, ForEach body index collision, Zip edge cases, CSE correctness, column pruner coverage, emission fragility. Findings: `docs/eventplan-architecture-critique.md`.

## Documentation

- **#14 — Architecture doc rewrite.** `docs/query-engine-architecture.md` fully rewritten for the current SetIR/EventPlan pipeline. Covers all 10 pipeline stages, SetIR node types, EventPlan node types, variable cost model.
- **#15 — Swift port hazards.** New `docs/swift-port-hazards.md` — analysis of risks for a future Swift rewrite (AE specifier construction, JXA bridge assumptions, Node-side evaluation).
- **#16 — Optimisation ideas.** New `docs/optimisation-ideas.md` — 14 prioritised optimisation opportunities with impact/complexity ratings.
- **#35/#48/#62 — Benchmark report updates.** `benchmark/REPORT.md` updated multiple times: replaced stale StrategyNode terminology, added Section 10 covering session optimisations, added fresh byIdentifier timing data (7ms/item for <50 items, bulk wins above ~100), added native count benchmark (~12ms vs ~200ms for unfiltered tasks count). Updated with 3 March 2026 data from full benchmark suite run (ae-costs, multi-prop-compare, chain-id-compare, json-bridge-compare, byIdentifier-compare) against database of 2,146 tasks/369 projects. Updated all timing tables in §1–9 with fresh medians. §4.2 (JXA bridge tax) explicitly maintained as "not reproducible" — three re-runs all showed high variance with no consistent JXA-vs-AS winner.
- **#54 — CLAUDE.md project layout update.** Updated project layout table for new files added since #14.
- **EventPlan reorder pass doc.** New `docs/eventplan-reorder-pass.md` documents the reordering algorithm, motivation, and interaction with the CSE/pruning/targeting pipeline.

## Housekeeping

- **#13/#34/#73/#79 — TODO.md.** Created `TODO.md` at repo root; removed stale in-code TODO/FIXME comments. Updated three times across the session as work completed and as architecture audits surfaced new known issues (inferEntity fallback, CSE effect check gap, ForEach body index design debt, column pruner RowCount gap, widenScansToUnion Restriction subtree gap).
- **#23 — Stale test files.** Rewrote `test/eventPlanColumnPrune.test.ts` (was importing removed modules). Rewrote `test/benchmark.js`. Deleted `test/omniJsUnit.test.ts`.
- **#43 — queryPerspectives.ts review.** Verified integration, docs, and test coverage for the untracked `queryPerspectives.ts`. Added inline comment clarifying defensive error-swallow.
- **#52 — .gitignore fixes.** Repaired malformed gitignore entry; added missing ignores for build artifacts, benchmark binaries, and worktree directories.

## New Files

| File | Purpose |
|------|---------|
| `CHANGELOG-session.md` | This file — session changelog for commit/PR preparation |
| `TODO.md` | Project-level known issues and next steps |
| `docs/applescript-codegen-design.md` | AppleScript codegen investigation: verdict and rationale (#38) |
| `docs/deferred-enrichment-design.md` | Design doc for byIdentifier() enrichment path (#36/#40/#41) |
| `docs/devonthink-reuse-audit.md` | Query engine reuse audit for DEVONthink MCP (#60) |
| `docs/eventplan-architecture-critique.md` | Critical review of EventPlan IR design (#69) |
| `docs/eventplan-reorder-pass.md` | Documentation for the EventPlan node reordering pass |
| `docs/json-elimination.md` | Investigation: JSON elimination in fused JXA units (#58) |
| `docs/mail-reuse-audit.md` | Query engine reuse audit for Mail MCP (#59) |
| `docs/native-ae-count-exists.md` | Investigation: native AE count/exists for filtered queries (#57) |
| `docs/optimisation-ideas.md` | Prioritised optimisation opportunities, round 1 (#16) |
| `docs/optimisation-ideas-round2.md` | Second-round optimisation ideas (#67) |
| `docs/setir-architecture-critique.md` | Critical review of SetIR design (#68) |
| `docs/swift-port-hazards.md` | Swift port risk analysis (#15) |
| `scripts/inspect-codegen.mjs` | Dev tool: dump EventPlan + emitted JXA for a query |
| `src/tools/query/aeProps.ts` | AE property/class code tables, extracted from `lowerSetIrToEventPlan` (#4) |
| `src/tools/query/eventPlanMergeSemiJoins.ts` | mergeSemiJoins optimisation pass (#22) |
| `src/tools/query/eventPlanReorder.ts` | EventPlan node reordering pass |
| `src/tools/query/normalizeAst.ts` | AST normalisation: single-element `in`→`eq`, dead-branch elimination (#74) |
| `src/utils/omniJsEnrich.ts` | enrichByIdentifier() utility for deferred enrichment (#40) |
| `test/containingActiveFilter.test.ts` | Tests for containing() active-filter injection (#2/#3) |
| `test/eventPlanMergeSemiJoins.test.ts` | Tests for mergeSemiJoins pass (#22) |
| `test/normalizeAst.test.ts` | Tests for AST normalisation pass (#74) |
| `test/omniJsEnrich.test.ts` | Tests for enrichByIdentifier() (66 tests) (#40) |
| `test/setIrPipeline.test.ts` | SetIR pipeline unit tests: op:count ordering, native fast-path eligibility and script generation |

## Deleted Files

| File | Reason |
|------|--------|
| `src/tools/query/executionUnits/omniJsUnit.ts` | OmniJS path unreachable; dead code (#24) |
| `test/omniJsUnit.test.ts` | Tests for deleted omniJsUnit (#24) |
| `docs/strategy-to-event-plan.md` | Documented removed StrategyNode pipeline |
