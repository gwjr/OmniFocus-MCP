# Optimisation Ideas for the OmniFocus MCP Query Engine

**Date:** 3 March 2026
**Author:** theta (analysis agent)
**Pipeline analysed:** `lowerToSetIr -> optimizeSetIr -> lowerSetIrToEventPlan -> cseEventPlan -> pruneColumns -> reorderEventPlan -> assignRuntimes -> splitExecutionUnits -> fuseSchedule -> execute`

---

## 1. Positional Alignment Skip (eliminate `id` from same-batch bulk reads)

**Impact: Medium** | **Complexity: Medium**

### Observation

When a JXA batch reads multiple properties from the same flattened collection (e.g. `flattenedTasks.name()`, `flattenedTasks.flagged()`, `flattenedTasks.dueDate()`), the resulting arrays are positionally aligned -- element `i` of every array refers to the same task. The current pipeline always includes `id` in the Scan columns so that cross-unit and cross-entity joins have a key to match on. But within a single fused JXA batch that reads from the same collection, `id` is unnecessary for alignment -- position suffices.

Each bulk property read costs ~55ms marginal (benchmark section 4.1). Eliminating the `id` read saves one round-trip per Scan when `id` is only used as a join/alignment key and not as a user-requested output column.

### What it would take

1. In `lowerScan()` (lowerSetIrToEventPlan.ts:53), `id` is unconditionally injected into the column set. This would need a conditional: only inject `id` when the column pruner determines it is consumed downstream.
2. The column pruner already identifies unused columns and removes them from Zip. But `id` is special: it is always injected, so the pruner currently sees it as "needed" by SemiJoin and HashJoin nodes. The fix is to allow the pruner to consider whether those consumers are *within the same JXA unit* and use positional alignment instead.
3. The Zip node in the node-side executor relies on column names, not positions. If `id` is pruned, the downstream SemiJoin must be told to match by array position rather than by column value.

### Risks

- **Cross-EU alignment breaks.** If two separate JXA batches read the same collection independently, their position arrays are independently aligned but NOT aligned to each other (collection order could differ between invocations). Today this cannot happen because CSE deduplicates the `Get(Elements)` specifier, ensuring both reads share the same collection reference within a batch. But if CSE is ever weakened or if a plan has two Scans of the same entity that are *not* CSE-deduplicated, positional alignment would silently produce wrong results.
- **OmniFocus collection order assumptions.** The benchmark shows consistent positional alignment, but this is an empirical observation, not a documented guarantee from OmniFocus. If OmniFocus ever changes the internal iteration order between two property reads in the same script (e.g. due to a sync completing mid-read), positional alignment would break.
- **Complexity vs savings.** The saving is ~55ms per query that has a Scan with `id` only used for alignment. Most queries already need `id` in the output (it's a common `select` column). The net benefit is probably limited to `count` and `exists` queries, which never output `id`. **User: not unless there is a cross-element join, we can normally exclude the id in an optimisation pass.**

### Verdict

Moderate saving on narrow queries (count/exists), but the correctness risk from relying on undocumented positional alignment makes this lower priority. A safer variant: mark `id` as "alignment-only" in the IR and let the column pruner remove it when the only consumers are positional (Zip within the same unit), but keep it when crossing unit boundaries. This narrows the correctness risk.

---

## 2. Limit Pushdown (early termination for `exists` and `limit`)

**Impact: High** | **Complexity: Medium**

### Observation

For `op:'exists'`, the pipeline wraps with `Limit(1)` at the SetIR level (`buildSetIrPlan`, orchestrator.ts:471). But this Limit is a node-side operation -- it runs *after* the full JXA bulk read has completed and all rows have been transferred. The JXA unit reads ALL 2,137 task properties regardless. For a query like "are there any tasks named 'Foo'?", the engine reads the full `name` array (~142ms) and the full `id` array (~163ms), zips them into 2,137 row objects, then takes the first one.

Similarly, `limit: 5` on a get query reads everything then slices.

### What it would take

There are two levels of pushdown:

**Level 1: JXA-side limit (easy).** After the Zip in the JXA codegen, emit a `.slice(0, N)` on the result array before JSON.stringify. This doesn't reduce AE reads but reduces serialisation cost (JSON.stringify of 5 rows vs 2,137). Saving: ~5-15ms for small limits (serialisation dominates at high row counts). Good idea.

**Level 2: AE-side limit via `.whose()` (hard, likely not worth it).** Apple Events `.whose()` is slow (~150ms = same as a bulk read), and there's no way to tell OmniFocus "stop after N matches". The AE model doesn't support LIMIT. So true pushdown to the AE layer is not feasible. **Agreed.**

**Level 3: Short-circuit filter + limit (medium).** For `Filter + Limit(N)`, the node-side executor could short-circuit: instead of `source.filter(pred)` then `.slice(0, N)`, use a loop that stops after N matches. This avoids creating the full filtered array. Saving: negligible for small result sets, but useful when the filter is highly selective and the first N matches appear early.

### Specific concern: `exists` short-circuit

The current `execLimit` in nodeUnit.ts:271 is just `source.slice(0, node.n)`. For `exists`, this is called on the full filtered row array. The filter has already iterated all rows. The optimisation would be to fuse Filter+Limit into a single pass:

```
// Instead of:  rows.filter(pred).slice(0, 1)
// Do:          for (const row of rows) { if (pred(row)) return [row]; }
```

This could be done at the EventPlan level by introducing a `FilterLimit` composite node, or at the nodeUnit level by detecting `Limit` whose source is a `Filter` ref with no other consumers.

### Verdict

Level 1 (JXA-side slice) is trivial and worth doing. Level 3 (Filter+Limit fusion in nodeUnit) is a modest win for `exists` on large datasets. Level 2 is not feasible.

---

## 3. AppleScript Codegen for Bulk Reads

**Impact: High** | **Complexity: Hard**

### Observation

The benchmark (section 4.2) shows JXA is 2.7x slower than AppleScript at 18 properties, and the crossover is around 8 properties. The current jxaUnit.ts generates JXA exclusively. For the common case of a task query selecting 8-15 properties, switching the BulkScan codegen to AppleScript would save 3-10 seconds.

### What it would take

1. New `asUnit.ts` emitter that generates AppleScript source instead of JXA.
2. The orchestrator would need to support running AppleScript via `osascript -e` (or better, pre-compiled `.scpt` files).
3. Result handling: AppleScript would need to output JSON. Either use AppleScript's `do shell script "echo ..."` to emit JSON, or convert the results via a small JXA wrapper that parses the AppleScript output.
4. Cross-unit data flow: AppleScript doesn't have JSON.parse/stringify natively. The JXA fusion model (where units share data as JS objects) wouldn't work. Would need a different serialisation strategy.

### Verdict

Highest potential single-query saving (3-10s on wide selects), but also the highest implementation complexity. The cross-unit data flow problem is the main blocker -- the current architecture assumes JXA throughout. A pragmatic intermediate step: generate AppleScript for "leaf" JXA units that have no cross-unit data dependencies (common for simple BulkScan + Filter queries). **Don't do this pending a decision to go/no-go on Swift rewrite (which would do this anyway)**

---

## 4. Column Pruning Gaps

**Impact: Medium** | **Complexity: Easy**

### Observation

The current pruner (`eventPlanColumnPrune.ts`) handles: Pick, Filter, Sort, Limit, SemiJoin, HashJoin, Derive, ColumnValues, Flatten, AddSwitch. Analysis of gaps:

**4a. ForEach body columns not pruned.**
The pruner (line 199-205) treats ForEach, Get, Count, Set, Command as terminals with no column propagation. ForEach nodes contain internal body Zip nodes that produce rows. If a ForEach's Zip produces columns that are never used downstream, those body Get nodes are wasted. The pruner would need to understand ForEach semantics (what the ForEach produces = its collect node's columns) and propagate needed-columns into the body.

ForEach is used by the Enrich lowering path (lowerSetIrToEventPlan.ts:146-225), which reads per-item columns via ByID lookups. If the enrich requests columns that are later pruned by a downstream Pick, the ForEach body still reads them.

**4b. Union column propagation.**
The `Union` node (line 199-205) falls through to the default case and gets no column propagation. Union preserves all columns from both sides. If downstream only needs a subset, the pruner should propagate that subset to both the left and right sources.

**4c. RowCount upstream columns.**
`RowCount` only needs the count of rows, not their columns. If the pruner saw a RowCount node, it could propagate an empty set of needed columns to its source, potentially pruning all property reads except the collection-size read. Currently RowCount falls through to the default case. (Note: the Count SetIR node becomes RowCount in EventPlan, and count queries are a real use case.)

### What it would take

- **4a**: Extend the pruner's backward walk to enter ForEach body, compute needed columns for the collect node, and propagate through body nodes. Medium complexity due to ForEach's scoped ref semantics.
- **4b**: Add a Union case that propagates `myNeeded` to both `node.left` and `node.right`. Trivial.
- **4c**: Add a RowCount case that propagates an empty `Set<string>` to `node.source`. Trivial. But needs care: the source Zip would become empty, and the Zip executor would return `[]` (length 0) rather than an array of the correct length. The fix is to ensure at least one column survives, or change RowCount to operate on the source array's length before zipping.

### Verdict

4b (Union) and 4c (RowCount) are easy wins. 4a (ForEach) is medium complexity but valuable for queries that enrich then project to a narrow set.

---

## 5. Tag Semi-Join Shortcut

**Impact: Medium** | **Complexity: Medium**

### Observation

The query `{container: ['tag', {eq: [{var:'name'}, 'Errands']}]}` on tasks currently:
1. Scans all tasks for `[id, tagIds]` -- 2 bulk reads (~300ms)
2. Scans all tags for `[id, name]` -- 2 bulk reads (~200ms)
3. Filters tags by name in Node
4. SemiJoin tasks on tagIds

This is 4 AE round-trips (~500ms total). An alternative:

1. `.whose({name: 'Errands'})` on tags -- 1 targeted lookup (~138ms) **Would need to check this is fast enough**
2. `tag.tasks.id()` -- 1 relationship traversal (~140ms)
3. SemiJoin tasks by ID set

This is 2 AE round-trips (~278ms) and avoids the expensive `tagIds` bulk read entirely. The saving is ~200ms.

### What it would take

This is a SetIR-level optimisation. When the pattern is:
```
Restriction(Scan(tasks, [id, tagIds]), fk='tagIds', Filter(Scan(tags, [id, name]), eq(name, 'literal')))
```
...rewrite to:
```
SemiJoin(Scan(tasks, [id]), ids=RelationshipTraversal(tag.whose({name:'literal'}).tasks.id()))
```

This requires:
1. Pattern-matching at the SetIR level to detect `Restriction + tagIds + literal tag name filter`.
2. A new EventPlan node (or use existing `Get(Whose)` + `Get(Elements)` + `Get(Property)` chain) to express the targeted lookup + relationship traversal.
3. Cardinality estimation to decide the scan direction: if the tag has many tasks (e.g. 500+), the current bulk-scan approach might be better (avoids the `tag.tasks.id()` traversal overhead). But tags typically have <100 tasks, making the shortcut almost always better.

### Risk

Multiple tags with the same name (unlikely but possible in nested tag hierarchies). `.whose({name:})` returns all matches, so this is safe -- the result is the union of their task sets.

### Verdict

Good optimisation for a common query pattern. The tag-by-name lookup is nearly universal in user queries. Implementation is moderately complex but well-bounded. **This is an example of a common issue, though rare for OF, of whether to dispatch a whose or do client-side filtering.**

---

## 6. Short-Circuit `exists`

**Impact: Low-Medium** | **Complexity: Easy**

### Observation

`op:'exists'` becomes `Limit(source, 1)` at the SetIR level (orchestrator.ts:471). After lowering to EventPlan, the Limit is a node-side operation. The full source (bulk read + filter) runs to completion, producing all matching rows, then Limit takes the first one.

The question is whether we can stop earlier.

### Current behaviour

- **JXA bulk reads**: Cannot short-circuit. `flattenedTasks.name()` always returns the full array. No AE equivalent of `LIMIT`.
- **Node-side filter**: `source.filter(pred).slice(0,1)` iterates all rows through the filter, then slices. This is the only place short-circuiting is possible.
- **Project exclusion**: The `Difference(taskPlan, Scan('projects', ['id']))` still reads all project IDs. This cannot be avoided (we need the full exclusion set).

### What it would take

Fuse `Filter + Limit` in nodeUnit to use a `for` loop with early break. This saves the cost of filtering the remaining rows after the first match. For a highly selective filter ("tasks named 'Buy milk'"), this could save iterating 2,000+ rows. For a non-selective filter ("flagged tasks"), saving is negligible since the first match is found quickly.

The saving is purely CPU time in Node, not AE round-trips. For a 2,137-row dataset, the filter loop is <1ms even without short-circuiting. The win is proportional to dataset size and filter selectivity.

### Verdict

Easy to implement, but the saving is tiny (<1ms for current dataset sizes). Worth doing as a correctness/clarity improvement more than a performance one. Would matter at 10,000+ tasks.

**Further point - once you have exists of a descriptor we're happy to dispatch as an event, you can just dispatch the exists command rather than a get/count**

**Similarly we could dispatch native AE count commands**

---

## 7. Scan Merging at EventPlan Level

**Impact: Medium** | **Complexity: Medium**

### Observation

The SetIR `optimizeSetIr` pass merges same-entity Scans when they appear in `Intersect` nodes (`mergeSameEntityScans`). But after lowering to EventPlan, the CSE pass (`cseEventPlan.ts`) only deduplicates identical `Get` nodes -- it cannot merge two `Get(Elements(flattenedTasks))` nodes that exist because they came from different SetIR Scans that weren't merged (e.g. because they were in different branches of a Union or under a Restriction).

Example: `or(eq(name,'A'), container('tag', eq(name,'B')))` produces:
- Branch 1: Scan(tasks, [id, name]) -- Get(Elements(flattenedTasks))
- Branch 2: Scan(tasks, [id, tagIds]) -- Get(Elements(flattenedTasks))
- Branch 3: Scan(tags, [id, name]) -- Get(Elements(flattenedTags))

CSE merges the two `Get(Elements(flattenedTasks))` into one. But each branch still emits separate `Get(Property(elems, name))` and `Get(Property(elems, tagIds))` calls -- and separate Zip nodes. The net result is 4 AE property reads (name, id, tagIds, id) instead of potentially 3 (name, id, tagIds) if the Zips could be merged.

### What it would take

An EventPlan-level pass that merges Zip nodes sharing the same set of source Get(Elements) refs. If two Zips both read from the same Elements ref but with different property subsets, merge them into a single Zip with the union of columns, then add downstream Pick nodes to project each consumer's subset.

This is structurally similar to what the SetIR merge-scan does but at the EventPlan level, catching cases the SetIR pass misses.

### Verdict

Medium value, medium complexity. The SetIR pass already handles the most common case (Intersect of same-entity Scans). This catches remaining cases in Union/Restriction branches. Worth doing after higher-priority items.

---

## 8. Deferred Enrichment via OmniJS `byIdentifier()` for Small Result Sets

**Impact: High** | **Complexity: Medium**

### Observation

The benchmark (section 8) shows `byIdentifier()` wins below ~50 IDs at 5 properties, and the crossover moves higher with more properties. The current pipeline always uses bulk reads (Scan), never `byIdentifier()`.

For queries with a highly selective filter + several output columns (e.g. "tasks named 'Buy milk', select name, dueDate, note, project, tags"), the pipeline:
1. Bulk-reads ALL tasks for filter columns (~300ms)
2. Filters to ~1-5 rows (~0ms)
3. Bulk-reads ALL tasks for output columns (~300-500ms)
4. (If note is selected) Enriches per-item (~16s)

Step 3 is wasteful: we know the result set is tiny, but we still read all 2,137 tasks. Using `byIdentifier()` for the output columns of the surviving rows would cost ~7ms/item x 5 items = 35ms vs ~500ms.

### What it would take

1. At the SetIR level, after `optimizeSetIr`, check if the output scan (added by `lowerToSetIr` step 2) could be replaced with an Enrich node when the estimated result set is small.
2. The estimate could come from: `limit` clause (explicit), `exists` op (always 1), or heuristic (name equality filter likely returns <5 rows).
3. `lowerSetIrToEventPlan` already handles Enrich via ForEach + ByID. The OmniJS unit can be used for this path.

### Verdict

High impact for selective queries, which are the most common user interaction pattern. The limit-clause case is straightforward (if `limit <= 50`, use Enrich for output columns). The heuristic case is harder but covers important patterns.

**NB this is only worth doing where the output column set substnatially exceeds the filter column set - otherwise you migth as well just get everything**

---

## 9. Avoid Double-Scanning for Project Exclusion

**Impact: Medium** | **Complexity: Easy**

### Observation

Every task query appends `Difference(taskPlan, Scan('projects', ['id']))` (orchestrator.ts:457-462) to exclude project root tasks. This adds a `Scan(projects, [id])` -- one AE round-trip (~245ms).

When the task plan already contains a project-related Restriction (e.g. `container('project', pred)`), the project IDs are already available from the Restriction's lookup scan. The exclusion scan is redundant -- we could reuse the already-scanned project IDs.

However, there's a subtlety: the container Restriction's lookup may be filtered (only projects matching `pred`), while the exclusion needs ALL project IDs. So the reuse is only valid when the lookup is unfiltered.

A simpler optimisation: for `count` and `exists` queries, the project-exclusion Difference could be pushed down. If the filter already excludes projects (e.g. by filtering on task-only properties like `inInbox` or `blocked`), the exclusion is redundant.

### What it would take

1. Check if the predicate already implies the result cannot contain projects (e.g. uses task-only properties).
2. If so, skip the Difference node.
3. For the general case: CSE the `Scan(projects, [id])` with any existing project scan in the plan.

### Verdict

CSE already handles this partially (if there's a `Scan(projects, [id])` elsewhere, the Get(Elements(flattenedProjects)) is deduplicated). The marginal improvement from skipping the Difference entirely is ~100ms (one less property read). Easy to implement for the "uses task-only vars" case.

---

## 10. Pre-compute Active Filter Bitmask

**Impact: Medium** | **Complexity: Medium**

### Observation

Many task queries apply the active filter: `not(effectivelyCompleted) AND not(effectivelyDropped)`. This requires two bulk property reads (~140ms each = ~280ms) plus a node-side filter. These two columns are read on nearly every task query.

If the server cached a bitmask of "active task indices" (refreshed on each query, or lazily), subsequent queries could skip these two bulk reads. The bitmask could be computed once from the first query's bulk reads and reused until OmniFocus data changes.

### Risks

- Cache invalidation: OmniFocus data changes between queries. The MCP server handles one query at a time, so the cache would only be valid within a single query execution. Cross-query caching would need a change-detection mechanism (e.g. `modificationDate` of the document).
- Complexity of maintaining a bitmask cache alongside the stateless pipeline.

### Verdict

Medium value, but introduces statefulness into what is currently a stateless pipeline. Better suited as a future "query session" feature where multiple queries run against a snapshot. **Keep stateless for now**

---

## 11. Hoist Sort Column into Filter Scan

**Impact: Low** | **Complexity: Easy**

### Observation

When a query has `sort: { by: 'dueDate' }` and the filter doesn't reference `dueDate`, the current pipeline produces:
1. `Scan(tasks, [id, ...filterCols])` -- filter scan
2. `Scan(tasks, [id, ...outputCols, dueDate])` -- output scan (includes sort column)

The merge-scan optimiser merges these if they Intersect. But if the output columns include `dueDate` anyway, there's no issue. The gap is when `dueDate` is needed for sorting but not in the output -- it still gets read in the output scan, which is correct but could have been included in the filter scan to avoid the output scan entirely.

### Verdict

Minor edge case. The merge-scan pass already handles the main scenario. Low priority.

---

## 12. Batch JSON Serialisation Optimisation

**Impact: Low-Medium** | **Complexity: Easy**

### Observation

Each fused JXA batch wraps unit outputs in `JSON.parse((unitScript))` then collects into an array and calls `JSON.stringify(_r)`. This means every unit's output is:
1. Serialised to JSON string by the inner `JSON.stringify`
2. Parsed by the outer `JSON.parse`
3. Re-serialised by the outer `JSON.stringify`

For large result sets (2,137 rows x 12 columns), this parse-reserialize cycle adds CPU time in the JXA bridge. A more efficient approach: have each inner unit return its JSON string directly (no parse), and concatenate the strings with commas + brackets to form the outer array.

### What it would take

Change the fusion wrapper from:
```js
_r[0] = JSON.parse((unit0Script));
_r[1] = JSON.parse((unit1Script));
return JSON.stringify(_r);
```
to:
```js
return '[' + (unit0Script) + ',' + (unit1Script) + ']';
```

Each unit script already returns `JSON.stringify(result)`, so the concatenation is valid.

### Verdict

Easy implementation. The saving is proportional to result size -- probably 5-20ms for typical queries, more for large ones. Low risk. **Also do we need to do JSON - worth checking**

---

## Summary Table

| # | Idea | Impact | Complexity | Priority |
|---|------|--------|-----------|----------|
| 3 | AppleScript codegen for bulk reads | High | Hard | 1 (highest absolute saving) |
| 8 | Deferred enrichment via byIdentifier() | High | Medium | 2 |
| 2 | Limit pushdown (Filter+Limit fusion) | High | Medium | 3 |
| 4c | RowCount column pruning | Medium | Easy | 4 |
| 4b | Union column propagation in pruner | Medium | Easy | 5 |
| 5 | Tag semi-join shortcut | Medium | Medium | 6 |
| 9 | Skip project exclusion when provably unnecessary | Medium | Easy | 7 |
| 12 | Batch JSON serialisation (skip parse-reserialise) | Low-Med | Easy | 8 |
| 7 | EventPlan-level scan merging | Medium | Medium | 9 |
| 1 | Positional alignment skip | Medium | Medium | 10 (correctness risk) |
| 4a | ForEach body column pruning | Medium | Medium | 11 |
| 6 | Short-circuit exists | Low-Med | Easy | 12 |
| 10 | Pre-compute active filter bitmask | Medium | Medium | 13 (statefulness concern) |
| 11 | Hoist sort column into filter scan | Low | Easy | 14 |

Quick wins (Easy + meaningful impact): **4b**, **4c**, **9**, **12**, **6**
High-value medium-effort: **2**, **5**, **8**
Strategic investment: **3** (AppleScript codegen)
