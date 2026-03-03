# Optimisation Ideas — Round 2

**Date:** 3 March 2026
**Author:** zeta (analysis agent)
**Prerequisite:** Round 1 (`docs/optimisation-ideas.md`) covered 14 ideas. Status of those:
- **Implemented:** filter+limit fusion (#6), scan subsumption (#9), tag semi-join shortcut (#5), project-exclusion skip (#9), adaptive enrichment (#8), column pruning improvements (#4b/#4c/#4a), mergeSemiJoins pass (#7-adjacent), JXA JSON cycle skip (#12), ForEach body pruning (#4a)
- **Investigated and ruled out:** native AE count/exists for filtered queries — confirmed infeasible; native count fast-path for unfiltered queries is now implemented
- **Deferred:** AppleScript codegen (#3 — bridge tax not reproducible), pre-compute active filter bitmask (#10 — statefulness concern)

This document covers a second pass of ideas, going deeper on areas not yet addressed.

---

## 1. WON'T WORK Parallel JXA Execution for Independent Units

**Impact: High** | **Complexity: Medium**

### Observation

The orchestrator (`executeTargetedPlan`) currently executes all JXA units strictly serially, even when two units have no dependency relationship. The `fuseSchedule` pass groups consecutive JXA units into a single fused `osascript` call, but this fusion only applies to units whose deps are all already satisfied at the point the batch is formed. Two JXA units that are both ready simultaneously are fused — but if Plan A has two independent JXA leaves that happen to land in the same "ready wave", they're fused. The question is: are there plans where independent JXA units cannot be fused (because they are not consecutive after scheduling)?

Looking at current plan shapes: most queries produce a single JXA unit (one fused script), so there's nothing to parallelize. But `or()` predicates (`Union` in SetIR) produce two independent sub-scans, and after lowering these may produce two JXA units with no dependency between them. Currently `fuseSchedule` will fuse them when both are ready, which is correct and efficient.

However, there is a category where parallel execution would genuinely help: **two entirely independent queries** submitted by an agent in rapid succession. The MCP server handles one request at a time today. This is a protocol-level constraint, not a planner limitation.

Within a single query, the real opportunity is for `container()` / `containing()` predicates that produce two independent entity scans (e.g. tasks scan + tags scan for a `container('tag', ...)` predicate). After CSE and scan subsumption, these are typically already fused into a single JXA script by the existing `executeFusedJxaUnits` path.

### What it would take

Confirming the status: `container('tag', pred)` produces:
1. `Get(Elements(doc, flattenedTask))` + property reads
2. `Get(Elements(doc, flattenedTag))` + property reads

These are independent and are currently **already fused** by `executeFusedJxaUnits` when they appear consecutively in the schedule. The fusion produces a single `osascript` call with both element reads in the same script — which is already the optimal outcome. A parallel `Promise.all([osascript1, osascript2])` would not help; fusing saves more by amortising the ~100ms IPC floor into one call.

**Concurrent `osascript` invocations**: Apple Events is a synchronous protocol over a single Mach port per app connection. Concurrent AE calls from two simultaneous `osascript` processes would likely be serialised by OmniFocus's event queue, not parallelised. The net gain would be process startup parallelism (~17ms), not AE round-trip parallelism. Not worth pursuing.

### Verdict

Not applicable within a single query — the fusion mechanism already achieves the optimal batching. For multi-query parallelism (concurrent MCP requests), the server would need request-level concurrency, which is an MCP protocol concern, not a query engine concern. The ordering constraints (Apple Events serialised by OmniFocus) make true parallel AE reads impossible.

**Priority: Skip.** Fusion already handles this correctly.

---

## 2. OK BUT SEEMS MARGINAL Algebraic Predicate Simplification

**Impact: Low-Medium** | **Complexity: Easy-Medium**

### Observation

The engine has `normalizeAst.ts` (not read, but referenced throughout the codebase) which handles some canonicalization. This idea examines what additional simplifications are not currently applied.

**2a. Constant folding**: Predicates that reduce to a constant at parse time. Examples:
- `between(5, 3, 10)` → `true` (compile-time computable)
- `eq('flagged', 'flagged')` → `true` (literal string equality — rare in practice since both sides are usually var/literal)
- `and(true, P)` → `P` — already handled by `normalizeAst`?
- `or(false, P)` → `P`
- `not(false)` → `true`

These would only trigger if the user sends a degenerate predicate (unlikely in practice) or if a generated predicate has constants due to computed-var expansion.

**2b. Double-negation elimination**: `not(not(P))` → `P`. Likely already in `normalizeAst`.

**2c. De Morgan rewriting for filter pushdown**: `not(and(A, B))` → `or(not(A), not(B))`. This could open up additional Intersect→Union rewrites in the SetIR. However, De Morgan rewrites increase AST size and complicate SetIR lowering — the benefit is unclear without concrete examples that trigger it.

**2d. Tautology / contradiction detection**: If a predicate is provably always-true or always-false for an entity (e.g. `eq({var: 'effectivelyCompleted'}, {var: 'effectivelyDropped'})` on tasks — both booleans but unrelated), the plan can be short-circuited. Detecting this requires type analysis. Complex; not worth building.

**2e. Duplicate branch elimination in `or`**: `or(P, P)` → `P`. Could arise from predicate construction code.

**2f. Redundant `in` with single element**: `{in: [{var:'x'}, ['a']]}` → `{eq: [{var:'x'}, 'a']}`. The `in` op checks array membership; a single-element array is equivalent to an equality check. `eq` may be more efficiently handled in some backends.

### What it would take

Add additional cases to `normalizeAst.ts`:
- 2a: Add constant-propagation rules (trivial)
- 2e/2f: Add structural pattern-match rules (trivial)

### Verdict

Low individual impact since degenerate predicates are rare. But 2f (single-element `in` → `eq`) is a 5-line change that would activate the tag semi-join shortcut for `{container: ['tag', {in: [{var:'name'}, ['Work']]}]}` queries (currently the shortcut only fires for `eq`, not `in`). That is a meaningful win for a common query pattern.

**Priority: 2f specifically is worth doing (2 hours, unlocks tag shortcut for `in` predicates).**

---

## 3. WON'T WORK Scan Range Constraints via OmniFocus Forecast/Perspective API

**Impact: Medium** | **Complexity: Hard**

### Observation **USER: [Not]() applicable - this doesn't work unless the GUI shows the right page!**

For date-range predicates — "tasks due in the next 7 days", "tasks deferred until today" — the engine currently does a full bulk read of all tasks and filters by date in Node. OmniFocus has a built-in concept of "forecast" and "available" tasks that pre-filters by date server-side. Specifically:

- `flattenedTasks.whose({dueDate: {_greaterThan: date1, _lessThan: date2}})` — a `.whose()` predicate with two conditions
- OmniFocus perspectives (Forecast, Due Soon) expose pre-filtered task sets

The benchmark (§5) shows that `.whose()` costs ~150ms — roughly the same as a single bulk property read. For a date-range query, the current path reads 3 properties (~375ms: id + dueDate + effectivelyCompleted) and filters in Node. If `.whose()` could pre-filter to, say, 12 tasks instead of 2,137, the subsequent property reads on those 12 tasks via `byIdentifier()` would be cheaper than bulk-reading all 2,137.

**The crossover calculation:**
- Current path: 3 bulk reads × ~160ms = ~480ms
- Whose + byIdentifier path: `whose(dueDate, range)` (~150ms) + 12 items × byIdentifier (~7ms each) = ~234ms for 5 properties

For highly selective date-range queries (few matching tasks), the `.whose()` path wins. The breakeven is when `N × 7ms + 150ms = propertyCount × 160ms`, solving: N ≈ (propertyCount × 160ms - 150ms) / 7ms. For 5 properties: N ≈ 93 items.

### Constraints

- `.whose()` with a date range requires AppleScript date literal construction, which is not straightforward in JXA. The `_greaterThan`/`_lessThan` compound predicates work in JXA but require building the date values.
- The existing `.whose()` infrastructure in EventPlan (`Whose` specifier node) only supports simple `eq`/`contains` predicates. Extending to date ranges requires adding `gt`/`lt`/`gte`/`lte`/`between` variants to the `Whose` specifier type.
- OmniFocus's `.whose()` evaluation is a linear scan of all tasks (no indexing), so even with a range condition, it still reads all 2,137 task dates internally. The "pre-filter" saves on the AppleScript→Node serialisation side (only sending 12 items), not on the OmniFocus-side evaluation cost.
- High variance: chain reads and `.whose()` both show high variance (~3× range), making the crossover unreliable.

### Alternative: Perspective-scoped queries

The `queryPerspectives.ts` primitive already reads perspective task lists via OmniJS. A "Forecast" perspective gives the next N days of tasks. If a user queries "tasks due today", routing through the Forecast perspective's task list would be cheaper for date-bounded queries. This is already available as `entity: 'perspectives'` in the query tool. The engine would need to recognise date-range predicates and suggest/use the perspective route.

### Verdict

The `.whose()` date-range path has moderate potential for selective date queries, but the complexity of extending the EventPlan IR and the high variance of `.whose()` make it risky. **Not recommended** for the general case. The perspective-routing idea is a better approach for common date-bounded queries (due today, due this week) — but requires understanding which perspective covers which date range.

**Priority: Low. Investigate perspective-routing as a separate query hint mechanism if frequently requested.**

---

## 4. POTENTIALLY A RICH AREA ALSO FOR FINDING FAST WHOSE CONSTRAINTS. LONGER TERM THOUGH. Schema Statistics Cache for Plan-Time Decisions

**Impact: Low-Medium** | **Complexity: Medium**

### Observation

The planner currently makes no decisions based on collection sizes. This matters for:

1. **Deferred enrichment threshold**: Currently uses a fixed `DEFERRED_ENRICH_MAX_ROWS = 50`. This is calibrated for a ~2,000-task database. For a user with 10,000 tasks, the enrichment crossover moves to ~150+ items (since bulk reads become more expensive relative to byIdentifier). The threshold should scale with collection size.

2. **Tag semi-join shortcut**: The shortcut replaces `tagIds` bulk read + tag name filter with `.whose(name)` + relationship traversal. For a tag with 1,500 tasks (like a ubiquitous "Work" tag), the shortcut produces 1,500 task IDs from `tag.tasks.id()` which then feeds a SemiJoin. The bulk-read + node-filter path may be cheaper when the tag is large. The shortcut should be conditional on tag cardinality.

3. **`containing()` direction choice**: For `containing('tasks', pred) on projects`, the engine does a forward scan (scan all tasks, filter, extract projectIds, restrict projects). If there are 10,000 tasks and only 20 projects, a backward scan (for each project, count matching tasks via byIdentifier) could be cheaper. This is a join direction choice that relational databases make via statistics.

### What would be needed

A lightweight statistics cache:
```typescript
interface SchemaStats {
  taskCount: number;
  projectCount: number;
  folderCount: number;
  tagCount: number;
  timestamp: number;  // ms since epoch
}
```

Populated once per MCP session (or lazily on first query) via the native count fast-path (already implemented: ~12ms per entity). Cache TTL: 60 seconds (good enough for planning; stale stats don't break correctness, only efficiency).

The orchestrator already has `executeNativeCount` — a stats cache would call it for each entity at startup.

### Verdict

The deferred enrichment threshold adjustment is the most concrete win. Changing `DEFERRED_ENRICH_MAX_ROWS` from a fixed 50 to `Math.round(taskCount / 40)` would auto-calibrate for different database sizes. This is a 2-line change after adding a stats fetch.

The join direction and tag cardinality decisions are more complex and would require propagating stats into the optimizer passes.

**Priority: Medium for the threshold auto-calibration (simple). Low for join direction (complex). Collect stats lazily at startup.**

---

## 5. DEFER UNTIL AFTER SWIFT REWRITE - ALSO CONSIDER IN ANY CASE. MOST AGENTS WORKING WITH OF END UP CHANGING THINGS SO INVALIDATION IS A CONCERN Incremental / Cached Results

**Impact: Medium** | **Complexity: Hard**

### Observation

MCP agents often issue repeated identical or near-identical queries in a session. For example, an agent that calls `query` with the same parameters twice in 5 seconds gets no benefit from the second call — OmniFocus is queried identically both times.

### Invalidation semantics

OmniFocus provides `defaultDocument.modificationDate` — a document-level modification timestamp that changes when any item is added, edited, or deleted. A result cache keyed on `(queryHash, modificationDate)` would be safe: if the modification date hasn't changed, no data has changed, and cached results are valid.

```typescript
interface CacheEntry {
  result: unknown;
  modDate: Date;
  queryHash: string;
}
```

The modification date costs one AE round-trip (~100ms) to check. This is cheaper than re-running a full query (~400–750ms) but more expensive than a cache hit with no revalidation.

### Short-TTL approach (no revalidation)

A simpler model: cache results for 5 seconds with no revalidation. MCP agents that call `query` multiple times within 5 seconds get a free result. After 5 seconds, the cache is invalidated unconditionally. This is wrong if a mutation happened in those 5 seconds, but:
- Mutations via this MCP server are tracked (we know if we mutated)
- Background OmniFocus changes (sync, manual edits) would not be reflected

A hybrid: invalidate the cache on any mutation from this server, and also on a 5-second TTL.

### Constraints

- The MCP server is stateless between calls (each tool call is independent). A process-level cache (module-level `Map`) would survive within a process lifetime. For `npx @modelcontextprotocol/inspector` or long-running server processes, this is effective.
- Cache key: hash of `{entity, op, where, select, sort, limit, includeCompleted}`. JSON.stringify is sufficient.
- Memory: a Map with 10 cached query results × ~500KB per result (2,000 rows × 12 columns) = ~5MB. Acceptable.

### Verdict

For an agent that does exploratory "give me tasks, then filter, then requery with a different predicate" workflows, a 5-second cache with mutation-based invalidation would eliminate redundant AE reads in common patterns. This is a meaningful quality-of-life improvement.

**Priority: Medium. Implement as a module-level LRU cache (max 20 entries, 5s TTL, invalidate on mutation). ~100 lines.**

---

## 6. WE SHOULD ABSOLUTELY FOLD THE WRITE PIPELINE INTO THE AST/QUERY GENERATOR - NEEDS SET, COMMAND, MOVE, DELETE OPERTAIONS AS FIRST-CLASS AST MEMBERS Write-Back Pipeline Optimisations

**Impact: Low-Medium** | **Complexity: Easy**

### Observation

The mutation path (`batchEdit.ts`, `batchMove.ts`) generates and executes an AppleScript per batch. Looking at the current implementation:

**6a. Name lookup on every mutation**: `batchEdit.ts` generates a script that reads the `name` of each item after setting it (for the results array). If the caller is setting the name, the result already has it. If not, it's a round-trip purely for reporting. The result summary could be computed from the input params + known IDs rather than re-reading from OmniFocus.

However, looking at the script structure more carefully: the script does one `tell` block per item, doing the set operations inside. It reads `name of workItem` for the result report. This is a per-item property read inside the script — cheap since it's within the same script body (no extra IPC round-trips).

**6b. Tag name resolution**: `addTags`/`removeTags` in batchEdit resolve tag names via `.whose({name:})` inside the AppleScript script body. This is correct but linear in the number of unique tags. If the same tag name appears in 50 items' addTags list, it's resolved once per item (50 `.whose()` calls). Better: resolve unique tag names once at the top of the script, then reference the tag specifiers.

Looking at the generated script structure (inferred from `generateEditScript`): it likely generates `a reference to first flattened tag whose name is "X"` inline per item. Hoisting unique tag references to the top of the script would reduce `.whose()` evaluations from N_items × N_tags to N_unique_tags.

**6c. Sequential vs parallel moves**: `batchMove.ts` moves items one at a time within a script. OmniFocus's `move` command may not support array targets, so sequential is necessary. No improvement here.

**6d. Missing: write verification**: The current mutation path doesn't verify that items were actually changed (e.g., that a mark-complete on an already-completed task was a no-op). This is a correctness concern, not a performance one.

**6e. Read-before-write for offset operations**: Offset operations (`offset: {dueDate: {days: 3}}`) need to read the current date before adding the offset. The current implementation reads the date inside the AppleScript script (`get due date of workItem`). For a batch of 50 items, this is 50 reads inside one script — acceptable. No improvement needed.

### Verdict

6b (unique tag name deduplication) is the most concrete improvement: for bulk edits that add/remove the same tag from many items, this reduces `.whose()` evaluations from O(n_items) to O(n_unique_tags). Implementation: collect unique tag names in the TypeScript layer, pre-generate `set tagN to first flattened tag...` lines at the top of the script.

**Priority: 6b is Low-Medium (2-4 hours). Others are Low or not actionable.**

---

## 7. THIS WOULD BE GREAT IF WHOSE WAS GOOD, BUT EVEN FOR IDS, IT ISN'T ForEach-Free Per-Item Enrichment (AE ByID specifier)

**Impact: Medium** | **Complexity: Medium**

### Observation

The current Enrich path in `lowerSetIrToEventPlan.ts` uses a `ForEach` loop to read per-item properties via `ByID` specifier:
```javascript
// Emitted JXA:
for (var id of idArray) {
  var item = Application('OmniFocus').defaultDocument.flattenedTasks.byId(id);
  result.push({ id: item.id(), note: item.note() });
}
```

This is N per-item Apple Events round-trips inside one script (serialised in the JXA runtime, all within one osascript process). Each iteration accesses the OmniFocus bridge once for the byId specifier and once per property.

An alternative pattern: batch the byId lookups using a different AE construct. OmniFocus supports `get properties of every item whose id is in {id1, id2, ...}` in AppleScript, which is a single AE call returning all requested items. In JXA, there's no direct equivalent — `whose` is still a linear scan.

However, there's a JXA pattern that avoids the per-item loop: construct an array of byId specifiers and read their properties in bulk:
```javascript
// Hypothetical:
var items = ids.map(id => doc.flattenedTasks.byId(id));
var names = items.map(item => item.name());  // Does this batch or per-item?
```

The `items.map(item => item.name())` would be N sequential AE property reads — same as the ForEach. The issue is that `items` is an array of specifiers, not a collection specifier, and bulk property reads only work on collection specifiers (`doc.flattenedTasks.name()` — not an array of individual specifiers).

A possibly faster alternative is to use `whose`:
```javascript
doc.flattenedTasks.whose({id: {_oneOf: ids}}).note()
```

OmniFocus supports `_oneOf` as a compound AE predicate. If it works, this would be a single AE call returning notes for all matching items. Testing needed — the benchmark (§5) shows `.whose({id: x})` for a single ID costs ~150ms; for a set of IDs with `_oneOf`, the cost might be similar or higher (still a linear scan, but batched).

### What it would take

1. Test whether `doc.flattenedTasks.whose({id: {_oneOf: ['id1', 'id2', ...]}}).note()` works in JXA and returns an aligned array.
2. If it works: add a new EventPlan node `WhoseEnrich` or reuse `Get(Whose(_oneOf), Property)` and add it as an alternative Enrich lowering.
3. Apply when result set is in the 1–50 item range (where ForEach is slow due to per-item IPC).

### Verdict

High potential if `_oneOf` works as a bulk batch predicate. The benchmark data suggests individual `.whose()` costs ~150ms regardless of dataset size (server-side linear scan), but the key question is whether `_oneOf` with 20 IDs costs ~150ms (one scan) or ~3,000ms (20 scans). Needs empirical testing.

**Priority: Medium. Requires benchmarking before implementing. Could save 1-3 seconds on enrichment queries with 10-50 items.**

---

## 8. Predicate Pushdown into Restriction Lookups

**Impact: Medium** | **Complexity: Medium**

### Observation

(This was investigated as Task #47.) For queries like `container('project', {eq: [{var: 'name'}, 'Work']})` on tasks, the SetIR produces:
```
Restriction(
  Scan(tasks, [id, projectId]),
  fkColumn: 'projectId',
  lookup: Filter(Scan(projects, [id, name]), eq(name, 'Work'))
)
```

The lookup is a filtered scan of projects. The engine reads ALL project properties then filters in Node. Since there are only 366 projects (all at the AE floor: ~100ms each), this is already fast.

But for a more selective lookup — say, finding tasks in projects matching complex predicates — the lookup itself becomes expensive. Could we push the filter into the AE layer via `.whose()`?

The benchmark (§5) shows `.whose({name: 'Work'})` on projects costs ~125ms — essentially the same as reading all 366 projects' names (~140ms). For small collections, `.whose()` is never better than bulk-read + Node filter. The only case where it wins is when the collection is large AND the filter is highly selective, but projects/tags/folders are all small collections in practice.

### Verdict

Not worth pursuing given current collection sizes. If project counts grew to 10,000+, this would warrant revisiting.

**Priority: Skip.**

---

## 9. CACHE INVALIDATION MADNESS - NO Active Filter Caching within a Single Query

**Impact: Low-Medium** | **Complexity: Easy**

### Observation

Every task query reads `effectivelyCompleted` and `effectivelyDropped` as part of the active filter. These are computed boolean properties (~164–195ms each). Together they cost ~350ms on every task query.

Within a single query execution, these values never change (OmniFocus doesn't modify data during a query). The column pruner already tries to eliminate unnecessary reads — but these two properties are explicitly requested by the active filter injection in `queryOmnifocus.ts`, so they're never pruned.

An optimisation: if the active filter is always applied (which it is by default), and the bulk read of `effectivelyCompleted` and `effectivelyDropped` is always done, could we cache those two arrays for the duration of a session and reuse them across queries?

The challenge is cache invalidation. OmniFocus data can change between queries. However, a very short TTL (1 second) would likely be safe for multi-query agent interactions — the user can't complete/drop tasks in <1 second between MCP calls.

### Alternative: read once per session

A "session" could be defined as the span of a single MCP request handler. Within one MCP request, there's only ever one query, so there's nothing to cache. The value would be for future "batch query" operations or repeated queries within one tool call.

### Verdict

The real win here is in combination with the result cache (idea #5): if the cache is warm, the active filter reads are part of the cached result and don't need to be re-read. Implementing the result cache makes this moot.

**Priority: Skip — superseded by result cache (#5).**

---

## 10. BEAUTIFUL IN THEORY Ordered Scan Exploitation for Sort + Limit

**Impact: Medium** | **Complexity: Hard**

### Observation

For queries with `sort: {by: 'creationDate', direction: 'asc'}` and `limit: 10`, the engine:
1. Reads ALL task properties (including creationDate) — ~300ms+
2. Filters to active tasks — ~N matching rows
3. Sorts all matching rows by creationDate
4. Takes the first 10

OmniFocus's `flattenedTasks` collection is ordered by position in the task hierarchy, not by any date property. So there's no inherent ordering to exploit for date-based sorts — you can't ask OmniFocus for "the 10 earliest tasks by creationDate" directly.

However, for certain sorts OmniFocus's internal ordering IS the desired order. `flattenedTasks` returns tasks in document order (by position). If the sort key matches document order, a limit could be applied at the AE level.

For `sort: {by: 'id'}` (which correlates with creation order in OmniFocus) and `limit: N`, the engine could read just the first N IDs and properties, then verify they pass the active filter — potentially avoiding reading the full collection. But the filter (active filter) may eliminate some of those first N items, requiring a "read more until you have N valid rows" approach. This is a sliding-window scan — complex to implement correctly.

### Verdict

Very limited applicability. `sort: {by: 'id'}` is an unlikely sort key. For all other sort keys, document order is irrelevant. **Skip.**

---

## 11. NODE MICRO-OPS ARE NOT A PRIORITY Enrich Result Format Cleanup: Delete vs Selective Assignment

**Impact: Low** | **Complexity: Easy**

### Observation

In `executeDeferredEnrichment` (orchestrator.ts:730-754), after merging enriched columns into filter rows, the code projects the result to the requested select columns using a `delete row[key]` loop:

```typescript
for (const key of Object.keys(row)) {
  if (!selectSet.has(key)) {
    delete row[key];   // mutates the original row object in place
  }
}
```

This mutates the row objects in place, which is fine here since the rows were created in this function. However, `delete` on a v8 object converts it from a "fast" to a "slow" (dictionary-mode) object, which can have downstream performance implications for any code that iterates the resulting row objects.

A better pattern: construct a new object with only the selected keys rather than deleting from an existing object.

### Verdict

Micro-optimisation. The number of rows is bounded by `DEFERRED_ENRICH_MAX_ROWS = 50`, so this loop runs at most 50 × N_columns times. Not measurable in practice.

**Priority: Skip.**

---

## 12.DON'T WE ALREADY DO THIS? IF NOT WORTH EXPLORING Multi-Entity Queries (Cross-Entity JOIN at the API Level)

**Impact: High** | **Complexity: Hard**

### Observation

Currently, the query tool handles one entity at a time. An agent needing "tasks and their project names, filtered by project status" must:
1. Query projects with status filter → get project IDs
2. Query tasks in those projects → join manually or use `container('project', pred)`

The `containing()` and `container()` ops enable cross-entity filtering, and chain properties like `projectName` handle one level of enrichment. But a query like "tasks with their project name and folder name" requires:
1. tasks scan (for task properties)
2. tasks.containingProject scan (chain prop)
3. tasks.containingProject.container.name (for folder name — chain through two hops)

Currently `folderName` on tasks would require two chain hops, which is not supported — it's classified as `expensive` and would go through per-item Enrich. The two-hop chain `task.containingProject.container.name()` would need to be expressed as a new chain type in `aeProps.ts`.

### What it would take

For the specific case of `task → project → folder` (a known two-hop chain), a new chain property like `taskFolderName` with a `kind: 'doubleChain'` specifier type in aeProps could avoid the per-item Enrich for this common pattern.

AE expression: `doc.flattenedTasks.containingProject.container.name()` — worth benchmarking if it returns an aligned array. It may or may not work depending on OmniFocus's object model (the container of a project can be the document root, not a folder). Already handled in `aeProps.ts` via a `joinSpec` that falls back to a HashJoin for null containers.

### Verdict

The existing chain property + joinSpec mechanism already handles the most important case (project → folder) via a HashJoin. The question is whether there's a bulk chain path for `task.containingProject.container.name()`. **Worth a 30-minute benchmark to test**: `doc.flattenedTasks.containingProject.container.name()`.

**Priority: Low-Medium. Benchmark the double-chain first; implement if it works and the join path is measurably slower.**

---

## 13. AGREED WORTH IT Project-Scoped Task Scan

**Impact: High** | **Complexity: Medium**

### Observation

For `container('project', pred)` queries on tasks, the current pipeline:
1. Scans all tasks for `[id, projectId, ...]`
2. Scans all projects for `[id, ...]`, filters by `pred`
3. Restriction: keep tasks whose `projectId` ∈ filtered project IDs

This reads all ~2,000 tasks even when only a handful of projects match the
predicate. Once you have the matching project AE specifiers, `project.flattenedTasks`
(not `project.tasks` — `flattenedTasks` includes nested subtasks) gives you only
that project's tasks. For ≤N matching projects:

```javascript
// Hypothetical — once project specifiers are in hand:
for (const proj of matchingProjects) {
  names.push(...proj.flattenedTasks.name());
  ids.push(...proj.flattenedTasks.id());
}
```

Each `project.flattenedTasks.property()` is a bulk AE read scoped to one project.
For a project with 15 tasks, that's ~15 rows instead of ~2,000 from the global scan.

### Adaptive strategy

The key question is the crossover point N (max matching project count where scoped
reads beat global scan):

- Global scan: ~160ms per property × number of properties (always, regardless of filter)
- Scoped scan: `project.flattenedTasks.property()` per matching project × N_projects

If `flattenedTasks.property()` on a project costs ~50ms (per round-trip, independent
of task count within the project), then for 3 properties:
- Global: 3 × 160ms = 480ms
- Scoped (N projects): N × 3 × 50ms = 150ms × N

Crossover: N < 3.2 → scoped is better for 1–3 matching projects; global wins for 4+.

**Adaptive implementation**: execute the project lookup first (cheap — ~100ms for
all projects), count the result, and if count ≤ N_threshold, switch to per-project
scoped reads. This is the same adaptive logic as deferred enrichment.

### What it would take

1. Benchmark `project.flattenedTasks.property()` cost per project (does it scale
   with task count or is it a fixed IPC floor?).
2. Add a new SetIR or EventPlan node for scoped entity reads: `ScopedScan(parent, entity, cols)`.
3. Add an optimizer pass that detects `Restriction(Scan(tasks,...), 'projectId', lookup)`
   and, after executing `lookup`, decides whether to substitute a ScopedScan.

Or, more pragmatically: implement it as a post-SetIR adaptive path in the orchestrator
(execute project lookup → check count → if ≤ threshold, emit scoped JXA instead of
the standard EventPlan).

### Verdict

Significant potential for highly-selective project-constrained task queries (e.g.,
"tasks in the 'Work' project"). Zero benefit for broad queries (many matching projects).
The adaptive threshold is empirical — requires benchmarking `project.flattenedTasks`
cost model before implementing.

**Priority: High. Benchmark `project.flattenedTasks.property()` cost model first (~30 min). The practical trigger threshold is ≤5 matching projects — above that, the global scan's fixed cost is amortised well enough. The implementation is self-contained in the orchestrator: execute the project lookup, check `results.length ≤ 5`, and if so dispatch a scoped JXA script that loops over project specifiers and reads `proj.flattenedTasks.property()` for each. No IR changes required for the initial implementation.

Note: `project.tasks` only returns direct children. Always use `project.flattenedTasks` to include nested action group subtasks — this is what the global `flattenedTasks` scan returns, so the scoped and global paths must be consistent.**

---

## Summary Table

| # | Idea | Impact | Complexity | Priority |
|---|------|--------|-----------|----------|
| 5 | Result cache (5s TTL + mutation invalidation) | Medium | Medium | 1 (quality of life, ~100 lines) |
| 2f | Single-element `in` → `eq` rewrite (unlocks tag shortcut) | Low-Med | Easy | 2 (~5 lines) |
| 6b | Tag name deduplication in batch edit scripts | Low-Med | Easy | 3 (2-4 hours) |
| 4 | Schema stats cache for adaptive thresholds | Low-Med | Medium | 4 (calibrate enrichment threshold to DB size) |
| 7 | `_oneOf` AE predicate for batch Enrich | Medium | Medium | 5 (benchmark first) |
| 12 | Double-chain property benchmark (`task.containingProject.container.name()`) | Low-Med | Easy | 6 (30-min benchmark) |
| 13 | Project-scoped task scan for container-constrained queries | High | Medium | 2 (benchmark first, then orchestrator-only change) |
| 3 | Perspective-routing for date-bounded queries | Medium | Hard | 8 (investigate after #4) |
| 1 | Parallel JXA execution | N/A | — | Skip — already handled by fusion |
| 2a-e | Predicate constant folding (general) | Low | Easy | Low (degenerate predicates rare) |
| 8 | Predicate pushdown into restrictions | Skip | — | Not worth it — collections too small |
| 9 | Active filter caching | Skip | — | Superseded by #5 |
| 10 | Ordered scan for sort+limit | Skip | — | Insufficient applicability |
| 11 | Enrich row object cleanup | Skip | — | Immeasurable |

**Highest-value quick wins**: #2f (5 lines, unlocks tag shortcut for `in` predicates) and #5 (result cache, meaningful for agent workflows).

**High-impact after benchmarking**: #13 (project-scoped scan — potentially saves ~300–400ms on single-project queries, orchestrator-only change once the cost model is confirmed).

**Benchmark first before implementing**: #7 (does `_oneOf` work and is it faster?), #12 (does double-chain bulk read work?), and #13 (what does `project.flattenedTasks.property()` cost vs task count?).
