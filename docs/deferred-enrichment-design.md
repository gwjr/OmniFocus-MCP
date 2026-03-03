# Deferred Enrichment via byIdentifier() — Design Investigation

**Date:** 3 March 2026
**Task:** #36
**Status:** Investigation complete — recommends phased implementation

---

## 1. Problem Statement

For highly selective queries with output columns that differ from filter columns, the current pipeline bulk-reads ALL rows for the output columns even when only a few survive the filter.

Example: `"tasks where inInbox = true, select name, dueDate, note, projectName"`

Current pipeline:
1. Bulk-scan tasks for `[id, inInbox]` — ~300ms (2 AE reads, 2137 rows)
2. Node-side filter → ~9 rows
3. Intersect(output Scan, filter result) → bulk-scan for `[id, name, dueDate, projectName]` — ~400ms
4. Enrich for note (per-item ForEach) — ~70ms (9 items x 7.6ms)
5. Total: ~770ms

With deferred enrichment:
1. Bulk-scan tasks for `[id, inInbox]` — ~300ms
2. Node-side filter → ~9 rows
3. byIdentifier() for 9 items x 4 props — ~180ms (9 x ~7ms + ~120ms overhead)
4. Note per-item — ~70ms
5. Total: ~550ms (~220ms saving)

The saving grows with more output columns and fewer matching rows.

---

## 2. Current Architecture Analysis

### How output columns are attached today

In `lowerToSetIr` (step 2), for `op:'get'` with `select`:

```
outputScan = Scan(entity, cheapOutputCols)
plan = Intersect(outputScan, filterPlan)
```

The `optimizeSetIr` merge-scan pass then merges this Intersect:
- If the filter plan is also a Scan/Filter over the same entity → single merged Scan(entity, filterCols ∪ outputCols)
- This merged scan bulk-reads all rows with all columns in one pass

The merge is correct but eliminates the separation between "columns needed for filtering" and "columns needed for output". After merging, every row carries all columns regardless of whether it passes the filter.

### Existing Enrich path

The pipeline already has per-item enrichment for "expensive" variables (note, folderName, parentName, projectCount):

```
SetIR:    Enrich(filteredPlan, entity, [note])
EventPlan: ColumnValues(ids) → ForEach(ByID → Get props) → HashJoin
```

This runs per-item via JXA `ByID` specifiers (not OmniJS byIdentifier). Each item requires an AE round-trip within a ForEach loop. Cost: ~75-150ms per item (per benchmark section 5, `.whose({id:x})` costs ~76ms in a loop).

**Key insight:** The existing Enrich path uses JXA ForEach, not OmniJS byIdentifier. The ForEach loop generates AE `ByID` specifiers, which are slower than OmniJS byIdentifier (~76ms/item vs ~7ms/item) but avoid cross-bridge overhead.

### Where the decision would need to be made

The current pipeline is fully pre-planned:

```
buildSetIrPlan → optimizeSetIr → lowerSetIrToEventPlan → CSE → prune → merge → execute
```

Selectivity (how many rows survive the filter) is unknown at plan time. Two architectural options exist:

1. **Plan-time heuristic** — use static signals (limit clause, op:exists, name-equality filter)
2. **Runtime adaptive** — execute filter first, inspect result count, then generate enrichment plan

---

## 3. Feasibility Assessment

### Option A: Plan-time heuristic (Enrich instead of output Scan when limit is small)

**When applicable:** The query has `limit <= 50`, or `op:'exists'` (limit=1).

**Mechanism:** In `lowerToSetIr`, when `op === 'get'` and `limit` is present and `<= THRESHOLD`:
- Instead of `Intersect(outputScan, filterPlan)`, emit `Enrich(filterPlan, entity, cheapOutputCols)`
- The existing Enrich → ForEach lowering handles the per-item reads

**Pros:**
- No architectural changes to the pipeline
- Enrich path already exists and is tested
- Decision is static — no runtime branching

**Cons:**
- JXA ForEach ByID is expensive (~76ms/item), not OmniJS byIdentifier (~7ms/item)
- At 50 items x ~76ms = ~3.8s — WORSE than bulk scan (~500ms)
- Only profitable below ~7 items with the JXA path (7 x 76ms = 532ms ≈ bulk scan)
- The `limit` signal is unreliable — most queries don't specify a limit

**Verdict: Not viable with the current JXA ForEach path.** The per-item cost is too high. byIdentifier (OmniJS) would be needed to make this worthwhile.

### Option B: OmniJS byIdentifier enrichment at plan time

**Mechanism:** Same as Option A, but lower Enrich to an OmniJS evaluateJavascript call that uses `Task.byIdentifier(id)` instead of JXA ForEach ByID.

**Pros:**
- byIdentifier cost: ~7ms/item + ~120ms overhead (benchmark section 8)
- At 50 items: ~470ms — comparable to bulk scan (~500ms)
- At 10 items: ~190ms — clear win over bulk scan
- At 5 items: ~155ms — significant win

**Cons:**
- OmniJS unit was just deleted (Task #24) — would need to be reintroduced (or a simpler variant)
- Cross-bridge data flow: OmniJS runs inside OmniFocus, returns data via `evaluateJavascript()`. Need to serialize IDs in and results out.
- Not the full omniJsUnit — only need a targeted "fetch these IDs with these columns" function
- Only useful when output columns significantly exceed filter columns (per user annotation on idea #8)

**Verdict: Viable but requires re-introducing OmniJS evaluation.**

### Option C: Runtime adaptive two-phase execution

**Mechanism:**
1. Execute the filter phase normally (bulk scan + node-side filter)
2. After filter execution, check result count
3. If count <= threshold: generate a focused enrichment plan for just those IDs
4. If count > threshold: execute the pre-planned bulk output scan

**Pros:**
- Adapts to actual selectivity, not guesses
- Could use byIdentifier for the enrichment phase
- No wasted work when selectivity is low

**Cons:**
- Requires splitting the EventPlan into phases
- The current `executeQueryFromAst` compiles the entire plan before execution
- Would need to either: (a) compile two alternative plans and choose at runtime, or (b) compile the enrichment plan dynamically after the filter phase
- Architectural complexity is high — crosses the planning/execution boundary

**Verdict: Architecturally invasive. Not recommended for a single task.**

### Option D: Split output columns at SetIR level, keep bulk scan but narrower

**Mechanism:** In `lowerToSetIr`, only merge output columns into the filter scan when they overlap. Non-overlapping output columns get their own Scan that is Intersected separately:

```
Before: Scan(tasks, [id, inInbox, name, dueDate, projectName])  -- all merged
After:  Intersect(
          Scan(tasks, [id, name, dueDate, projectName]),  -- output cols
          Filter(Scan(tasks, [id, inInbox]), pred)         -- filter cols
        )
```

**Wait — this is what the pipeline already does BEFORE the merge-scan optimizer collapses it.** The merge is the "problem" — it combines everything into one scan because it's structurally an Intersect of same-entity scans.

To prevent the merge, we would need to mark the output Intersect as "do not merge" — but that defeats the optimizer's purpose and would require IR annotations.

**Verdict: Fighting the optimizer. Not a clean path.**

---

## 4. Recommended Approach: Targeted OmniJS Enrichment Function

Rather than reintroducing the full omniJsUnit, add a lightweight utility function:

```typescript
// src/utils/omniJsEnrich.ts
async function enrichByIdentifier(
  entity: EntityType,
  ids: string[],
  columns: string[],
): Promise<Row[]>
```

This generates and executes a single OmniJS evaluateJavascript call:

```javascript
(function() {
  var ids = ["id1", "id2", ...];
  var results = [];
  for (var i = 0; i < ids.length; i++) {
    var item = Task.byIdentifier(ids[i]);
    if (item) results.push({ id: ids[i], name: item.name, ... });
  }
  return JSON.stringify(results);
})()
```

**Integration point:** In `executeQueryFromAst` (orchestrator.ts), after the main plan executes:

```typescript
export async function executeQueryFromAst(params: QueryPlanParams): Promise<OrchestratorResult> {
  // If limit <= THRESHOLD and select has non-filter columns:
  //   Plan 1: filter-only plan (minimal columns)
  //   Execute plan 1 → get matching IDs
  //   If result count <= threshold: enrich via byIdentifier
  //   Else: fall back to full plan

  // Otherwise: current path (full plan)
}
```

### Subtask decomposition

1. **Subtask A: `enrichByIdentifier()` utility** — standalone function that takes entity, IDs, columns and returns enriched rows via OmniJS. ~50 lines. Test with mock data.

2. **Subtask B: Split select into filter-columns vs output-only-columns** — in `executeQueryFromAst`, analyze which select columns are already present in the filter scan (overlap) vs only needed for output (output-only). This determines whether deferred enrichment would save anything.

3. **Subtask C: Adaptive enrichment in orchestrator** — when `limit` is specified and `<= 50`, generate a filter-only plan first. After execution, check count. If small enough, call `enrichByIdentifier` for output-only columns. Otherwise, fall through to the full plan.

4. **Subtask D: Heuristic triggers beyond `limit`** — detect patterns like name-equality that are likely highly selective, and trigger deferred enrichment without an explicit limit.

---

## 5. Cost-Benefit Summary

| Scenario | Current | With deferred enrichment | Saving |
|----------|--------:|-------------------------:|-------:|
| limit:5, 10 output cols | ~700ms (bulk) | ~300ms (byId) | ~400ms |
| limit:1 (exists+select) | ~700ms | ~250ms | ~450ms |
| No limit, 5 results, 10 cols | ~700ms | ~300ms | ~400ms |
| No limit, 500 results, 10 cols | ~700ms | ~3.6s (byId) | -2.9s (WORSE) |
| No limit, 2000 results | ~700ms | N/A (use bulk) | 0 |

**The optimisation is only profitable for result sets <50 rows.** This is common for:
- Explicit `limit: N` with N < 50 (common in "show me a few tasks" queries)
- `op:'exists'` with select (rare — exists usually doesn't need output columns)
- Highly selective filters (name equality, specific project, specific tag)

**The optimisation is NOT profitable for:**
- Unfiltered queries (all tasks)
- Low-selectivity filters (flagged, status:active)
- Queries where filter and output columns overlap significantly

---

## 6. Implementation Complexity Assessment

| Subtask | Complexity | Dependencies | Risk |
|---------|-----------|-------------|------|
| A: enrichByIdentifier utility | Easy | executeJXA (existing) | Low — isolated function |
| B: Column overlap analysis | Easy | collectVarNames (existing) | Low |
| C: Adaptive orchestrator | Medium | A, B | Medium — two-phase execution |
| D: Heuristic triggers | Hard | C | High — false positives waste time |

**Total estimated effort:** Subtasks A+B+C are a reasonable single-session project. Subtask D should be deferred — start with explicit `limit` as the trigger and gather data on which queries would benefit from heuristics.

---

## 7. Decision

Subtasks A+B+C are implementable cleanly. The key simplification: only trigger deferred enrichment when the query has an explicit `limit <= 50` AND the output column set significantly exceeds the filter column set (at least 3 output-only columns). This avoids heuristic false positives and keeps the implementation bounded.

The `enrichByIdentifier` utility does not require reintroducing the full omniJsUnit — it's a single function that constructs an OmniJS script string and calls `evaluateJavascript()` via the existing `executeJXA` path (which already supports OmniJS via `app.evaluateJavascript()`).

### Important: OmniJS property name mapping

OmniJS uses different property names from Apple Events in some cases:

| Internal var | AE property | OmniJS property |
|-------------|------------|-----------------|
| status (tasks) | (computed) | `taskStatus` (enum: Task.Status.Available etc) |
| status (projects) | effectiveStatus | `status` (enum: Project.Status.Active etc) |
| containingProject | containingProject | `containingProject` (same) |
| effectivelyCompleted | effectivelyCompleted | `effectivelyCompleted` (same) |
| childCount | numberOfTasks | `children.length` or similar |

The `enrichByIdentifier` function will need a property-name mapping layer from internal var names to OmniJS accessor expressions. This is a small, bounded mapping table — not the full aeProps.ts fourCC table, but a parallel OmniJS accessor registry.
