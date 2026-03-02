# Query Engine Architecture

The query engine compiles a compact JSON predicate syntax into a tree of physical operators, applies optimization passes, and executes against OmniFocus via Apple Events (JXA).

## Why a plan tree?

OmniFocus exposes data via Apple Events, which has unusual performance characteristics:

- **Bulk property reads are fast.** `doc.flattenedTasks.name()` returns all 751 task names in ~150ms via a single IPC call.
- **Per-item reads are slow.** `task.tags()` requires one IPC call per task (~5ms each). At 751 tasks that's ~3.8s.
- **`.whose()` is catastrophically slow on large collections.** Filtering 751 tasks via `.whose({flagged: true})` takes ~31s (vs ~400ms for bulk-read + Node filter). Each predicate evaluation is a separate IPC round-trip.
- **OmniJS `evaluateJavascript` has ~880ms overhead** per invocation, regardless of query complexity.

These constraints make conventional database strategies (predicate pushdown, index scans) counterproductive. The optimal strategy is almost always: read everything in bulk via Apple Events, then filter/join in Node.

## Pipeline

```
Compact syntax       →  lower.ts     →  AST (LoweredExpr)
AST                  →  planner.ts   →  Plan tree (PlanNode)
Plan tree            →  optimize()   →  Optimized plan tree
Optimized plan tree  →  executor.ts  →  Rows
```

### 1. Lowering (`lower.ts`)

Converts compact JSON syntax `{opName: [args]}` to normalized AST `{op, args}`.

### 2. Planning (`planner.ts`)

`buildPlanTree(ast, entity, select, includeCompleted)` produces a tree of physical operators. The planner classifies variables by cost:

| Cost | How read | Examples |
|------|----------|---------|
| **easy** | Bulk Apple Events | name, flagged, dueDate, deferDate |
| **chain** | Chained bulk | projectName, folderId, parentId |
| **per-item** | Individual JXA calls | tags, status (tasks), folderName |
| **expensive** | Only in select | note |

Based on variable costs and query shape, the planner builds one of:

- **Broad path:** `BulkScan → Filter` — all easy/chain vars, ~150-500ms
- **Project-scoped:** `BulkScan(projectScope) → Filter` — narrowed scan, ~150ms
- **Two-phase:** `Filter → PerItemEnrich(threshold=20, fallback=OmniJS) → PreFilter → BulkScan`
- **OmniJS fallback:** `OmniJSScan` — ~1-7s, used when nothing else works

### 3. Optimization (`optimize(tree, passes)`)

Passes are `(root: PlanNode) => PlanNode` functions applied in order. Each uses `walkPlan(node, fn)` for bottom-up tree rewriting.

Current pipeline:

1. **`tagSemiJoinPass`** — Rewrites `contains(tags, 'literal')` to `SemiJoin(BulkScan, MembershipScan(tags→tasks))`. Avoids per-item tag reads entirely.

2. **`crossEntityJoinPass`** — Resolves per-item properties via parallel bulk reads + hash join:
   - `projects.folderName` → join on `folderId` chain var + folders bulk scan
   - `tags.parentName` → self-join on `parentId` chain var + tags bulk scan
   - `folders.projectCount` → aggregate count of projects grouped by `folderId`

3. **`selfJoinEliminationPass`** — When a CrossEntityJoin joins an entity with itself, eliminates the redundant lookup BulkScan.

4. **`normalizePass`** — Cleanup: merge adjacent Filters, drop empty PerItemEnrich, convert degenerate PreFilter to Filter.

### 4. Execution (`executor.ts`)

`executePlan(node)` recursively walks the tree, executing each node. Key behaviors:

- **BulkScan**: Generates JXA bulk-read script, executes via `osascript`
- **MembershipScan**: Generalized cross-entity lookup (tags→tasks, projects→tasks, folders→projects) returning ID sets
- **SemiJoin**: Executes source + lookup in parallel (`Promise.all`), filters by set membership
- **CrossEntityJoin**: Parallel source + lookup scans, O(n) hash join in Node
- **PerItemEnrich**: If source rows exceed threshold, abandons and executes fallback plan
- **Filter/PreFilter**: Compiles predicate to closure via `compileNodePredicate()`, filters rows

## Plan node types

```
Leaf nodes (data sources):
  BulkScan          — Apple Events parallel-array bulk read
  OmniJSScan        — OmniJS evaluateJavascript fallback
  MembershipScan    — Cross-entity relationship ID lookup

Unary transforms:
  Filter            — Exact Node-side predicate
  PreFilter         — Optimistic filter (stubs per-item vars as true)
  PerItemEnrich     — Per-item JXA reads, threshold-gated with fallback
  Sort              — Node-side sort
  Limit             — Truncate to N rows
  Project           — Select columns

Binary nodes:
  SemiJoin          — Keep source rows whose id exists in lookup idSet
  CrossEntityJoin   — Hash join on arbitrary keys, supports count aggregation
  SelfJoinEnrich    — Optimized self-join (single scan serves as both source and lookup)
```

## Performance

Benchmark suite (25 queries, median of 3 iterations):

| Category | Before optimization | After | Reduction |
|----------|-------------------|-------|-----------|
| Projects with folder | 6,800ms | 500ms | 93% |
| All folders | 1,900ms | 170ms | 91% |
| Tags with parent | 900ms | 100ms | 89% |
| Tag membership | 5,800ms (OmniJS) | 360ms | 94% |
| **Total suite** | **19,400ms** | **7,300ms** | **62%** |

## Adding a new optimization pass

1. Create `src/tools/query/optimizations/yourPass.ts`
2. Export `const yourPass: OptimizationPass`
3. Use `walkPlan(root, fn)` for bottom-up pattern matching
4. If you need new node types, add to `planTree.ts` (union + walkPlan + planPathLabel) and `executor.ts`
5. Add to the PASSES array in `queryOmnifocus.ts`
6. Write tests in `test/planTree.test.ts`
7. Run `npm run build && node --test test/*.test.ts`

## Key traps

- **Never use `.whose()` for predicate pushdown** on entity collections. It's 77x slower than bulk-read + filter for 751 items.
- **`.whose()` IS safe** for small targeted lookups: finding a tag by name, scoping to a single project.
- **Tags on a tag object use `.tasks`** not `.flattenedTasks` (the latter throws -1728).
- **Apple Events status descriptors** are strings like `"active status"`, not enums. Must map via lookup table.
- **Chain properties** must use chained form (`items.containingProject.name()`) — 20x faster than per-item.
