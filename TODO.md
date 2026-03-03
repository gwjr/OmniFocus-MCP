# Open Items

## Stale dist artifacts

The StrategyNode pipeline was removed in commit `631c22e` but `tsc` doesn't
clean old `.js` outputs. The following stale dist files should be deleted:

- `dist/tools/query/strategy.js` (+ `.d.ts`)
- `dist/tools/query/strategyToEventPlan.js` (+ `.d.ts`)
- `dist/tools/query/planner.js` (+ `.d.ts`)
- `dist/tools/query/optimizations/` (entire directory)

## Optimisation opportunities (in progress)

- **AppleScript codegen for wide bulk reads** — JXA bridge tax is non-linear
  above ~8 properties; AppleScript scales linearly. (Task #38, in progress)

## Architecture / technical debt (from session audit)

- **Restriction node complexity** — `RestrictionNode` encodes five distinct usage
  patterns via optional flags (`fkColumn`, `lookupColumn?`, `arrayFk?`,
  `flattenLookup?`), with `arrayFk` and `flattenLookup` applying to opposite
  sides of the join. The 40-line compensating doc comment is itself a smell.
  Consider splitting into two node types (forward FK semi-join vs inverse FK
  restriction) or at minimum tightening the naming conventions.

- **Difference injection in orchestrator** — `buildSetIrPlan` (orchestrator.ts)
  injects the project-exclusion `Difference(plan, Scan(projects,[id]))` node
  outside `lowerToSetIr.ts`. The optimizer never sees it; `lowerToSetIr` tests
  don't cover project exclusion; the pipeline is split across two files. Consider
  moving into `lowerToSetIr.ts` or a dedicated SetIR pass.

- **ENTITY_TYPES exhaustiveness** — ~~`lowerToSetIr.ts` has a hardcoded
  `['tasks', 'projects', 'folders', 'tags']` array governing the `containing()`
  two-hop search. Add an exhaustiveness check.~~ **Fixed in Task #71.**

- **SetIR optimizer passes lack direct unit tests** — `mergeSameEntityScans`,
  `widenScansToUnion`, and `tagNameShortcut` are tested only through end-to-end
  EventPlan round-trips, not direct SetIR-level tree-shape assertions. A regression
  in the optimizer would manifest as a runtime failure, not a failing unit test.

## EventPlan IR — technical debt (from theta's architecture critique)

- **ForEach body index collision** — `ForEach` body nodes use a separate
  index namespace from plan-level `Ref`s, and the `ForEach` node's own
  plan-level index is reused inside the body to mean "current iteration item".
  Every pass (CSE, pruner, emitter, describer) must maintain an explicit
  `forEachStack` to handle this. Fix: narrow `body: EventNode[]` to a
  `body: ForEachBodyNode[]` discriminated union so the type system enforces
  the separation — or introduce `{ kind: 'plan'; idx }` / `{ kind: 'body'; idx }`
  / `{ kind: 'loopVar' }` scoped ref types.

- **Compaction pattern duplicated across four passes** — CSE, column pruner,
  node reorder pass, and `mergeSemiJoins` all implement their own variant of
  "compact a flat node array by dropping dead nodes and remapping refs".
  Extract a shared `compactPlan(nodes, survivors)` utility to reduce the
  surface area for index-arithmetic bugs.

- **`entity?` on Filter/AddSwitch should be required** — `nodeUnit.inferEntity`
  falls back to `'tasks'` when no `entity` field is present on the node, which
  is incorrect for project/folder/tag queries. Lowering already injects
  `entity` on every Filter and AddSwitch, so the fallback is dead code.
  Make `entity` required at the type level and remove the fallback (or throw).

- **HashJoin `'*'` magic key for count aggregation** — `execHashJoin` uses
  the string `'*'` as the join key when counting matching rows rather than
  extracting a field value. This is not documented at the IR level and is
  invisible to the type system. Consider a dedicated `CountAgg` node kind
  or at minimum add a doc comment on the `HashJoin` type explaining the
  `'*'` convention and where it is produced.

- **SetOp return type is `unknown` but carries `Set<string>`** — `execSetOp`
  returns `Set<string>`, but the IR dispatch signature is `unknown`. Nothing
  prevents a `SetOp` result from appearing in a non-id-consuming slot (e.g.,
  a Filter `source`), where it would produce confusing downstream behavior.
  The correct constraint is that SetOp output may only appear in a
  `SemiJoin.ids` slot. Enforce this via type narrowing or a validation pass.

- **jxaUnit chain accessor `split('.')[0]` is wrong for 3-level chains** —
  `emitParent` strips a chain accessor to its base via
  `chain.accessor.split('.')[0]`, which is correct for the current maximum
  chain depth of 2 (e.g. `containingProject.name` → `containingProject`).
  A 3-level chain (e.g. `a.b.c`) would silently produce wrong JXA output.
  The current deepest chain is 2 levels, so this is safe today, but adding
  any new chain property with depth ≥ 3 would trigger the bug without a
  compile-time or test-time signal. Document this constraint on `emitParent`
  and add an assertion or validation.

- **`collectBodySpecRefs` walks only one level deep in ForEach body** —
  the pruner's body reachability analysis calls `collectBodySpecRefs`, which
  checks the outer specifier's `parent` ref for body-local indices but does
  not recurse into chain specifier trees (Property-of-Property). In the
  current codebase, body Gets always root at `byIdRef` (body index 0) via
  the outer Property, so this is safe. A body Get with a chained specifier
  that references a body-local index in the inner Property would be
  incorrectly pruned. Add recursion or an assertion bounding body specifier
  depth.

## Optimisation opportunities (future)

- **Cross-node scan subsumption** — Task #28 added sibling-node scan merging
  in the SetIR optimizer. A further opportunity exists for subsumption across
  non-sibling nodes (e.g. a Scan inside a Restriction whose columns are a
  subset of a Scan at a different tree level).

- **Project-scoped task scan** — once a project AE specifier is in hand,
  `project.flattenedTasks.property()` reads only that project's tasks (including
  nested subtasks). For `container('project', pred)` queries that match ≤N
  projects, this could beat a global `flattenedTasks` scan + FK filter. Adaptive:
  execute the project lookup first, check result count, and if ≤N switch to
  per-project scoped reads. See `docs/optimisation-ideas-round2.md` for related
  ideas. N threshold needs empirical calibration.

## Multi-app reuse (from session audits)

- **Mail MCP re-use trigger** — the existing `contingency-mail-mcp` uses SQLite,
  not Apple Events, for reads. Any query engine reuse for Mail would need a
  `sqliteUnit.ts` execution backend. No shared library warranted until a third
  consumer exists (Mail + DEVONthink + OmniFocus). See `docs/mail-reuse-audit.md`.

- **DEVONthink re-use trigger** — the existing `mcp-server-devonthink` does no
  query compilation. A structured property-filter tool would be the trigger for
  reuse; the trigger condition is when per-record JXA iteration proves too slow.
  See `docs/devonthink-reuse-audit.md`.

## Documentation staleness

All secondary docs have been updated (Task #37):
- **docs/event-plan-ir.md** — StrategyNode references updated to SetIR
- **docs/strategy-to-event-plan.md** — deleted (documented removed code)
- **docs/cost-model.md** — pipeline diagram and node table updated; stale implementation increments replaced with status section
- **docs/next-steps.md** — rewritten; resolved items moved to "Resolved" section
- **docs/future-query-ir.md** — historical note added; "Impact on Current Design" section updated for SetIR pipeline

## Resolved this session

- container sub-predicate double-lower bug (Task #1)
- containing() active-filter omission (Tasks #2, #3)
- JOIN_PROPS duplication (Task #4 — moved to aeProps)
- Computed var spec duplication (Task #5 — consolidated)
- Error messages for Error node / propSpec failures (Task #6)
- Per-item vs expensive cost tier collapse (Task #7)
- parentIsChain transform suppression narrowed (Task #8)
- Architecture docs rewritten (Task #14)
- CSE miss: duplicate Zip([id]) (Task #21)
- Stale test files rewritten (Task #23)
- OmniJS dead code deleted (Task #24)
- Column pruner: Union propagation + RowCount gaps (Task #27)
- SetIR scan subsumption pass (Task #28)
- JXA fusion: redundant JSON parse-reserialise cycle eliminated (Task #32)
- Skip project-exclusion Difference for task-only predicates (Task #30)
- Filter+Limit fusion for op:exists (Task #31)
- SemiJoin collapsing into single Filter pass (Task #22)
- Deferred enrichment via byIdentifier investigation (Task #36)
- Benchmark REPORT.md updated (Task #35)
- Tag semi-join shortcut for tag-name filter queries (Task #33)
- Secondary docs updated / deleted (Task #37)
