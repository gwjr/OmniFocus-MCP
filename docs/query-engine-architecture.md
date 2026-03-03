# Query Engine Architecture

The query engine compiles a compact JSON predicate syntax through a multi-stage IR pipeline, ultimately producing SSA-style execution plans that run against OmniFocus via Apple Events (JXA) and Node.

## Why this architecture?

OmniFocus exposes data via Apple Events, which has unusual performance characteristics:

- **Bulk property reads are fast.** `doc.flattenedTasks.name()` returns all 751 task names in ~150ms via a single IPC call.
- **Per-item reads are slow.** `task.tags()` requires one IPC call per task (~5ms each). At 751 tasks that's ~3.8s.
- **`.whose()` is catastrophically slow on large collections.** Filtering 751 tasks via `.whose({flagged: true})` takes ~31s (vs ~400ms for bulk-read + Node filter). Each predicate evaluation is a separate IPC round-trip.
- **OmniJS `evaluateJavascript` has ~880ms overhead** per invocation, regardless of query complexity.

These constraints make conventional database strategies (predicate pushdown, index scans) counterproductive. The optimal strategy is almost always: read everything in bulk via Apple Events, then filter/join in Node.

## Pipeline overview

```
Compact syntax           →  lower.ts              →  AST (LoweredExpr)
AST                      →  normalizeAst.ts        →  Normalized AST
Normalized AST           →  lowerToSetIr.ts        →  SetIR tree
SetIR tree               →  optimizeSetIr()        →  Optimized SetIR
Optimized SetIR          →  lowerSetIrToEventPlan() →  EventPlan (SSA IR)
EventPlan                →  cseEventPlan()         →  CSE-optimized EventPlan
CSE'd EventPlan          →  pruneColumns()         →  Column-pruned EventPlan
Pruned EventPlan         →  reorderEventPlan()     →  Reordered EventPlan
Reordered EventPlan      →  assignRuntimes()       →  TargetedEventPlan
TargetedEventPlan        →  splitExecutionUnits()  →  ExecutionUnit[]
ExecutionUnit[]          →  orchestrator           →  Results
```

The entry point is `queryOmnifocus.ts`, which lowers the compact syntax, injects the active filter, and delegates to `executeQueryFromAst` in the orchestrator.

### 1. Lowering (`lower.ts`)

Converts compact JSON syntax `{opName: [args]}` to normalized AST `{op, args}`.

### 2. AST normalization (`normalizeAst.ts`)

Transforms the lowered AST to canonical form for stable pattern matching. Transformations include:

- **Flatten:** `and(a, and(b, c))` to `and(a, b, c)` (same for `or`)
- **Collapse:** `and(x)` to `x`
- **Double negation:** `not(not(x))` to `x`
- **LHS canonicalization:** place `{var}` on the left, constant on the right; flip ordering ops as needed
- **Conjunct/disjunct sorting:** deterministic ordering by tier (simple comparisons < NOT < nested connectives < structural predicates < aggregates)

### 3. SetIR lowering (`lowerToSetIr.ts`)

`lowerToSetIr(params)` produces a tree of algebraic set operations from the normalized AST. This is purely structural — no cost analysis or optimization at lowering time.

Core rules:

| Pattern | SetIR |
|---------|-------|
| `and(A, B)` | `Intersect(lower(A), lower(B))` |
| `or(A, B)` | `Union(lower(A), lower(B))` |
| `not(P)` | `Filter(Scan(vars), not(P))` |
| simple predicate on var | `Filter(Scan(entity, [id, var]), pred)` |
| expensive var predicate | `Filter(Enrich(Scan(entity, [id]), [var]), pred)` |
| `container(type, pred)` | `Restriction(Scan(entity, [id, fk]), fk, lower(pred, containerEntity))` |
| `containing(child, pred)` | `Restriction(Scan(parent, [id]), 'id', childLookup, lookupColumn:fk)` |

Output columns are attached separately: cheap columns via `Intersect(Scan(cols), filterTree)`, expensive columns via `Enrich`.

After predicate lowering, `buildSetIrPlan` in the orchestrator adds:
- **Project exclusion** for task queries: `Difference(plan, Scan('projects', ['id']))` (because projects appear in flattenedTasks)
- **Terminal wrapping:** `Count` / `Limit` / `Sort` for the requested op

### 4. SetIR optimization (`optimizeSetIr`)

A bottom-up tree rewrite pass that merges redundant scans:

- `Intersect(Scan(A, c1), Scan(A, c2))` becomes `Scan(A, c1 + c2)`
- `Intersect(Filter(Scan(A, c1), p1), Filter(Scan(A, c2), p2))` becomes `Filter(Scan(A, c1 + c2), and(p1, p2))`
- Mixed `Intersect(Filter(Scan(...)), Scan(...))` variants similarly merge

Also applies algebraic Error rules: `Union(Error, R) = R`, `Intersect(Error, R) = Error`.

### 5. EventPlan lowering (`lowerSetIrToEventPlan.ts`)

Lowers the SetIR tree to a flat SSA-style EventPlan (array of `EventNode`, each at a numbered slot, values referenced by `Ref` index).

Key mappings:

| SetIR | EventPlan |
|-------|-----------|
| `Scan(entity, cols)` | `Get(Elements)` + `Get(Property)` per column + `Zip` |
| `Filter(src, pred)` | `Filter(src, pred)` |
| `Intersect(L, R)` | `SemiJoin(L, ColumnValues(R, 'id'))` |
| `Union(L, R)` | `Union(L, R)` |
| `Difference(L, R)` | `SemiJoin(L, ColumnValues(R, 'id'), exclude:true)` |
| `Enrich(src, cols)` | `ColumnValues(id)` + `ForEach(ByID + props)` + `HashJoin` |
| `Restriction(src, fk, lookup)` | `SemiJoin(src, ColumnValues(lookup, col), field:fk)` |
| `Count(src)` | `RowCount(src)` |
| `Sort` / `Limit` | `Sort` / `Limit` |
| `AddSwitch(src, col, cases)` | `AddSwitch(src, col, cases)` |

When `outputColumns` is provided, a `Pick` node is appended to project the result, enabling the column pruner to eliminate dead upstream reads.

### 6. Common subexpression elimination (`eventPlanCSE.ts`)

Unifies `Get` nodes whose specifiers are structurally identical, removing redundant Apple Events calls. Then compacts the node array, reindexing all refs.

### 7. Column pruning (`eventPlanColumnPrune.ts`)

Dead-column elimination: backward analysis from the result ref computes needed column sets at each node, then prunes `Zip` columns that are never consumed downstream. Unreachable nodes are removed and the plan is compacted.

Each dead bulk read avoids ~140ms of IPC overhead.

### 8. Node reordering (`eventPlanReorder.ts`)

Priority-queue topological sort with runtime-aware tie-breaking. Groups same-runtime operations together to reduce ExecutionUnit splits and IPC round-trips (each `osascript` invocation has ~50ms overhead).

### 9. Runtime targeting (`targetedEventPlanLowering.ts`)

**`assignRuntimes`**: Annotates every EventNode with a `RuntimeAllocation` — either `fixed` (from a hint set during lowering) or `proposed` (from `defaultRuntime(node)` heuristics). Produces a `TargetedEventPlan`.

**`splitExecutionUnits`**: Partitions the targeted plan into contiguous per-runtime `ExecutionUnit` subgraphs. Each unit knows its runtime, owned nodes, cross-unit input/output refs, and dependency links.

**`computeBindings`**: Determines how values cross unit boundaries — either as serialized JSON (`'value'`) or reconstructed AE specifiers (`'specifier'`).

### 10. Execution (`orchestrator.ts`)

The orchestrator executes units in dependency order:

1. **Topological sort** of ExecutionUnits by `dependsOn`
2. **JXA-first scheduling** (`fuseSchedule`): within each dependency wave, hoist JXA units ahead of Node units
3. **JXA fusion**: consecutive JXA units with satisfied dependencies are fused into a single composite `osascript` invocation, reducing IPC overhead
4. **Per-runtime execution**:
   - **jxaUnit** — emits a JXA script from the unit's EventNodes, runs via `osascript`
   - **omniJsUnit** — emits OmniJS script, wrapped in a JXA `evaluateJavascript()` call
   - **nodeUnit** — executes directly in Node against in-memory row arrays
5. **Result threading**: cross-unit values flow via a shared `results: Map<Ref, unknown>`

## SetIR node types

```
Leaf nodes (data sources):
  Scan              — Bulk Apple Events parallel-array read
  Error             — Algebraic bottom (impossible computation)

Unary transforms:
  Filter            — Node-side predicate evaluation
  Enrich            — Per-row column enrichment (by-id AE access)
  Sort              — Node-side sort
  Limit             — Truncate to N rows
  Count             — Row count (terminal — produces scalar)
  AddSwitch         — Computed column via prioritized case evaluation

Binary set ops (join on 'id'):
  Intersect         — AND semantics: left rows whose id appears in right
  Union             — OR semantics: all rows, deduped by id (left wins)
  Difference        — Anti-join: left rows whose id NOT in right

Relational join:
  Restriction       — FK-based semi-join with configurable key columns
```

## EventPlan node types

```
AE operations (jxa runtime):
  Get               — Read an AE specifier (bulk or by-id)
  Count             — Count elements at an AE specifier
  Set               — Write to an AE specifier
  Command           — Execute an AE command
  ForEach           — Iterate over a collection (loop body is nested EventNodes)

Node-side operations (node runtime):
  Zip               — Combine parallel arrays into row objects
  ColumnValues      — Extract a single column from a row array
  Flatten           — Flatten one level of array nesting
  Filter            — Row filter via compiled predicate closure
  SemiJoin          — Keep/exclude rows by id set membership
  HashJoin          — Equi-join with field mapping
  Sort              — Sort rows by column
  Limit             — Truncate to N rows
  Pick              — Project to a subset of columns
  Derive            — Add computed columns via derivation rules
  Union             — Set union with id-based dedup
  RowCount          — Count rows (produces scalar)
  AddSwitch         — Computed column via case evaluation
```

## Variable cost model

Variables are classified by how they are read from OmniFocus:

| Cost | How read | Examples |
|------|----------|---------|
| **easy** | Bulk Apple Events | name, flagged, dueDate, deferDate |
| **chain** | Chained bulk property | projectName, folderId, parentId |
| **per-item** | Individual AE calls | tags, folderName (join-based) |
| **expensive** | Only via Enrich | note |
| **computed** | Derived in Node | status, hasChildren |

Easy and chain variables become `Scan` columns. Per-item and expensive variables are handled via `Enrich` (ForEach + by-id reads) or join-based enrichment (bulk scan + HashJoin). Computed variables use `AddSwitch` nodes.

## Key traps

- **Never use `.whose()` for predicate pushdown** on entity collections. It's 77x slower than bulk-read + filter for 751 items.
- **`.whose()` IS safe** for small targeted lookups: finding a tag by name, scoping to a single project.
- **Tags on a tag object use `.tasks`** not `.flattenedTasks` (the latter throws -1728).
- **Apple Events status descriptors** are strings like `"active status"`, not enums. Must map via lookup table.
- **Chain properties** must use chained form (`items.containingProject.name()`) — 20x faster than per-item.
- **Projects ARE tasks.** Every project has a root task in `flattenedTasks`. Task queries subtract project IDs via a `Difference` node.
