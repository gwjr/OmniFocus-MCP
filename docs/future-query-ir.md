# Future Direction: Column Acquisition Model

> **Status (March 2026):** This document was written when the query engine used the StrategyNode pipeline (planner.ts → PlanNode tree → EventPlan). That pipeline has been replaced by the SetIR pipeline (lowerToSetIr → optimizeSetIr → lowerSetIrToEventPlan → EventPlan). The column acquisition *mental model* described here remains valid and informed the SetIR design, but specific references to StrategyNode types (BulkScan, FallbackScan, PerItemEnrich, MembershipScan) and to files like `planner.ts` are now historical. See `docs/query-engine-architecture.md` for the current pipeline.

## Background

This document captures a design direction explored in early 2026 for the query engine IR, informed by review from compiler, database, and Apple Events specialists.

## The Core Framing

The query engine's job is to decide, for each column in the output (and each column needed for filtering), **how to acquire it from Apple Events**.

### Acquisition Methods

Apple Events supports five distinct addressing patterns for collections, which map to five column acquisition methods:

| Method | AE form | Notes |
|---|---|---|
| `ColumnEvery(collection, prop)` | `get prop of every collection` | Whole-collection bulk read. Always safe; cost is dominated by one round-trip. |
| `ColumnWhere(collection, prop, pred)` | `get prop of every collection where pred` | AE-side filter. Degenerate in OmniFocus (~31s for 750 rows). Fast in some other apps for selective predicates. |
| `ColumnByName(collection, prop, name)` | `get prop of collection "name"` | **Object reference** — addresses a single item by name. Semantically distinct from `ColumnWhere` with `name = X`: this is a reference to one object, not a collection. |
| `ColumnByID(collection, prop, id)` | `get prop of collection id #id` | Object reference — addresses a single item by ID. Fast in OmniFocus (~7ms). Used for per-survivor enrichment. |
| `ColumnByIndex(collection, prop, n)` | `get prop of collection n` | Object reference — addresses by positional index. Rarely useful except where index encodes meaning (e.g., window 1 = frontmost). |

`ColumnByName`, `ColumnByID`, and `ColumnByIndex` produce **object references** (single items), not collections. `ColumnEvery` and `ColumnWhere` produce **collections**. This is a fundamental AE distinction, not a naming preference.

### The Dependency Graph

Column acquisitions form a dependency graph. To acquire an output column, you must first know **which rows** to acquire it for. That requires evaluating a filter. The filter references filter columns. Some filter columns have their own dependencies.

Example — "get name and note of flagged tasks tagged Work":

```
OutputColumn(name)     → ColumnEvery(tasks, name)       [cheap; batch with filter cols]
OutputColumn(note)     → ColumnByID(tasks, note, ids)   [expensive; filter first]
  └─ depends on: survivor ids
       └─ Filter(flagged = true AND isMember("Work"))
            ├─ FilterColumn(flagged)  → ColumnEvery(tasks, flagged)
            └─ FilterColumn(isMember) → ColumnByName(tags, tasks.id, "Work")
                                          [one AE call; hash-probe per row]
  └─ addressing key: ColumnEvery(tasks, id)              [already in batch]
```

Execution order falls out of dependency resolution + cost:
1. Batch all cheap column acquisitions (ColumnEvery, ColumnByName) into minimum AE round-trips
2. Apply cheap pre-filter → surviving row set
3. Acquire expensive columns per-survivor (ColumnByID)
4. Apply final filter

This is essentially the pattern the current pipeline produces: `Scan` (cheap columns) → `Filter` → `Enrich` (expensive columns) — derived from the dependency graph rather than explicitly constructed.

### Two Levels Within the IR

The DB specialist identified an important refinement: the **atomic unit of acquisition is a batch, not an individual column**.

`ColumnEvery(tasks, name)` and `ColumnEvery(tasks, flagged)` become one AE call:
`get {name, flagged, id} of every flattened task`. Each is a logical column reference;
the planner groups them into a single physical acquisition operation.

This suggests two levels:
- **Column references** (logical): "this filter/output needs property X of collection Y"
- **Acquisition operations** (physical): "read [X, Y, Z] of collection Y in one call"

The dependency graph is over column references. Batching into acquisition operations is a subsequent planning step.

### Join Types Are Separate From Access Path

`ColumnByName(tags, tasks.id, "Work")` is the access path — it fetches the task ID set for tag "Work".
What you do with that result is a separate join-type decision, driven by predicate position:

- `container("tag", "Work")` at top level or in AND → **SemiJoin**: filter rows to only members
- `container("tag", "Work")` inside OR or NOT → **ExistsJoin**: add boolean `isMember` column to all rows

Same access path, different join type. These should not be conflated in the IR.

## Why ColumnWhere Matters for Portability

OmniFocus has a degenerate cost model: `ColumnWhere` on `flattenedTasks` costs ~31s vs ~140ms for `ColumnEvery + Node-filter`. The planner never selects it for broad queries. But `ColumnWhere` on small collections (tags: ~31 items; projects: ~366 items) is fast and IS used today (via MembershipScan's `.whose()` call).

In other AE-based apps, `ColumnWhere` may be competitive with `ColumnEvery + Node-filter` for selective predicates. Keeping `ColumnWhere` as an explicit acquisition method in the model — even when it's never selected in OmniFocus — preserves the decision point for other apps and keeps the cost model from being hardcoded into the IR.

**Portability caveat**: the compiler specialist reviewed the DEVONthink MCP server and noted that DEVONthink uses `search()`, `classify()`, `compare()` as server-side primitives — fundamentally different from bulk-read-then-filter. The portable layer is the AST/LoweredExpr; acquisition strategy is app-specific. The column acquisition vocabulary applies within AE apps that follow the property-collection model, but is not a universal abstraction across all scriptable apps.

## Recommended Path Forward

**Do not add a new IR level now.**

The compiler specialist's recommendation: extend `VarDef` to carry multiple acquisition strategies with per-strategy costs. Use the column acquisition framing as a mental model to inform the pipeline, and to guide naming and structure of SetIR/EventPlan node types. (The original recommendation referenced adding this to StrategyNode; with the SetIR pipeline now in place, the natural home is the variable registry in `variables.ts`.)

```typescript
// Sketch — not yet implemented
interface VarDef {
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'array';
  nodeKey: string;
  strategies: AcquisitionStrategy[];
}

interface AcquisitionStrategy {
  method: 'every' | 'where' | 'byId' | 'byName' | 'computed';
  cost: number;      // app-specific, in ms
  deps?: string[];   // dependency columns (e.g., 'id' for byId)
}
```

**Wait for a second app** before deciding whether the dependency graph needs to be reified as an explicit IR. The right abstraction will be clearer with two concrete consumers.

**When the second app arrives**, the decision points are:
1. Does the app follow the property-collection AE model, or does it have server-side primitives (`search`, `classify`)?
2. If property-collection: same IR, different cost model in VarDef
3. If server-side primitives: different acquisition methods needed; the column reference layer is reusable but the acquisition operations are not

## Impact on Current Design

> **Note:** This section was written against the old StrategyNode layer. The SetIR pipeline has addressed several of these concerns. Updated mapping below.

The column acquisition framing maps to the current SetIR/EventPlan pipeline as follows:

- **`Scan` (SetIR)** issues multiple `ColumnEvery` calls (one per column, batched into one AE script via `Get(Elements)` + `Get(Property)` + `Zip`). The scan subsumption pass (`widenScansToUnion`) ensures that duplicate scans for the same entity are widened to the same column set, enabling CSE to deduplicate them.
- **`Restriction` (SetIR)** handles what was previously `MembershipScan` — FK-based semi-joins for `container()` predicates. The `.whose({name:})` lookup is emitted as a `Get(Whose)` EventPlan node.
- **`Enrich` (SetIR)** handles per-survivor enrichment — lowers to `ForEach` + by-id reads in the EventPlan. Used for expensive variables like `note`.
- **`FallbackScan` is eliminated.** All query paths now go through the SetIR → EventPlan pipeline.
- **`container`/`containing` inside OR/NOT** — not yet implemented as an ExistsJoin; currently handled by the Union/Intersect SetIR decomposition of `or()`/`not()` predicates.
