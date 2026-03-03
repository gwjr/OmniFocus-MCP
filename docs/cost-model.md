# Query Engine Cost Model & Optimisation Problem Space

## The Pipeline

```
User query (compact syntax)
  → lower.ts         AST: LoweredExpr (predicate tree: and/or/not/eq/contains/...)
  → planner.ts       PlanNode tree (physical operators: BulkScan, Filter, SemiJoin, ...)
  → optimizations/*  PlanNode tree (rewritten: tag semi-join, cross-entity join, ...)
  → compile.ts       CompiledQuery (fused scripts + slot map)
  → executor.ts      Rows
```

The optimisation problem: given an AST and entity type, produce the PlanNode tree that minimises wall-clock execution time. The cost is dominated by **sequential OSA phases** — the number of times we must call osascript, wait for results, then call osascript again.

## Execution Primitives

Four ways to get data from OmniFocus, each an OSA invocation (~100ms IPC floor):

### 1. Apple Events Bulk Read (BulkScan)

`doc.flattenedTasks.name()` → array of all values. Collection size barely matters (~100ms floor dominates).

| Factor | Cost |
|--------|------|
| Floor | ~100ms |
| First property | ~140–170ms total |
| Marginal property (JXA, ≤8 props) | ~55ms |
| Marginal property (JXA, 18 props) | ~770ms (non-linear bridge tax) |
| Marginal property (AppleScript) | ~30ms (linear, stable) |
| Chain property overhead | +~100ms |

**Backend crossover at ~8 properties.** Below: equivalent. Above: AS 2–4× faster.

### 2. OmniJS `byIdentifier()` (ByIdEnrich)

Given known IDs, look up items directly inside OmniFocus's JS environment. No AE serialisation per property.

| Factor | Cost |
|--------|------|
| Floor (evaluateJavascript) | ~120ms |
| Per item (amortised) | ~7ms |
| Crossover with bulk read (5 props) | ~50–100 IDs |

Runs through OSA (JXA calls evaluateJavascript). **Can be fused into the same script** as a MembershipScan if the IDs are produced in-script.

### 3. Apple Events `.whose()` (per-item lookup)

Server-side predicate: linear scan, ~150ms per call. **Never use for filtering.** Only for targeted name lookup before relationship traversal.

### 4. OmniJS Full Scan (OmniJSScan)

`evaluateJavascript()` with iteration + filtering inside OmniFocus. High variance (2.3s–15.9s for 500 items). **Last resort only** — hard-code as dominated except when no alternative exists (perspectives, expensive vars, complex containers).

### 5. Node-side operations (free)

Filter, Sort, Limit, SemiJoin, CrossEntityJoin, SelfJoinEnrich — all <1ms for <10K rows.

## The Modelling Unit: Phase Schedules

A plan subtree does not have "a cost" — it has a **phase schedule**: an ordered list of OSA invocations.

```typescript
type Phase = {
  backend: 'jxa' | 'applescript' | 'omnijs';
  floorMs: number;              // ~100 or ~120
  bulkProps?: number;           // for BulkScan
  chainProps?: number;          // subset that are chain
  byIdItems?: number;           // N for byIdentifier
  membershipWork?: number;      // relationship traversal
};

type Cost = {
  phases: Phase[];
  rowsOut: number;              // cardinality estimate
  idsOut?: number;              // for idSet branches
};
// msTotal computed from phases, never stored independently
```

Node-side operators (Filter/SemiJoin/Sort/Limit/Project) contribute **no phases**.

**"Fusing"** = multiple leaf OSA ops ending up in the same phase. The cost model and compiler must agree on what "fused" means.

### Phase boundaries

A new phase is required when an OSA operation depends on Node-computed results:

| Pattern | Phases | Why |
|---------|--------|-----|
| BulkScan → Filter | 1 | Filter is Node-side |
| BulkScan + MembershipScan → SemiJoin | 1 | Independent, fusible |
| BulkScan → Filter → ByIdEnrich | 2 | Enrichment needs filtered IDs |
| MembershipScan → ByIdEnrich (fused) | **1** | IDs produced in-script, no Node dependency |

**Phase fusion rule:** a subtree executes in one OSA phase iff all OSA leaves do not depend on Node results, and any join between them can be implemented inside the script or deferred to Node without a round-trip.

## Cardinality Estimation

Crude but compositional. Monotone estimates that get the direction right.

### Selectivity defaults by predicate shape

| Predicate | Selectivity |
|-----------|-------------|
| `eq(flagged, true)` | 0.01 |
| `eq(completed, false)` | 0.7 |
| `neq(dueDate, null)` | ~0.1 |
| `contains(name, "x")` | 0.1 |
| unknown predicate | 0.5 |
| conjunction (and) | multiply, cap at 1 |
| disjunction (or) | s1 + s2 − s1×s2, cap at 1 |
| negation (not) | 1 − s |

### Tag membership cardinality

Heuristic: average tag cardinality ~20, or `tasks / numTags` as naive baseline. Configurable.

### Collection sizes

Cached at server startup (one fused count query, ~200ms):
- tasks: ~2,137
- projects: ~366
- tags: ~31
- folders: ~33

## Bottom-Up Cost Computation

For each PlanNode, compute `rowsOut`/`idsOut` and `phases`:

| Node | Cardinality | Phases |
|------|-------------|--------|
| BulkScan | collectionSize(entity) | 1 phase: bulkProps = columns.length |
| MembershipScan | heuristic (~20) | 1 phase: membershipWork |
| ByIdEnrich | source cardinality | 1 phase: byIdItems = source.idsOut |
| OmniJSScan | collectionSize × 0.5 | 1 phase: omnijs (penalty) |
| Filter | source.rowsOut × selectivity(pred) | 0 phases |
| SemiJoin | min(source.rowsOut, lookup.idsOut) | merge child phases (fuse if independent) |
| CrossEntityJoin | source.rowsOut | merge child phases (fuse if independent) |
| Sort / Project | passthrough | 0 phases |
| Limit | min(source.rowsOut, N) | 0 phases |

## Rewrites Enabled by the Cost Model

### A. Replace PerItemEnrich with ByIdEnrich

**Always do it.** ByIdEnrich (~120ms + 7ms × N) strictly dominates PerItemEnrich (.whose loop at ~76ms/item) for N ≥ 2.

| Items | .whose loop | byIdentifier | Savings |
|------:|------------:|-------------:|--------:|
| 5 | 380ms | 155ms | 225ms |
| 10 | 760ms | 190ms | 570ms |
| 20 | 1,520ms | 260ms | 1,260ms |

This becomes a **planner default**, not an optimisation pass.

### B. Fuse MembershipScan + ByIdEnrich (collapse 2 phases → 1)

**When:** query predicate decomposes into `tagPart` + `restPart`, and `restPart` only references fields fetchable via byIdentifier.

**From (2 phases):**
```
SemiJoin(BulkScan(tasks, colsForRest), MembershipScan(tag))
→ Filter(restPart) in Node
```

**To (1 phase):**
```
ByIdEnrich(ids = MembershipScan(tag), fields = colsForRest ∪ selectFields)
→ Filter(restPart) in Node
```

**Decision hinge:** `tagCardinality × perIdCost` vs `bulkScanCost(cols)`. Most valuable when tag cardinality is small and property count is high.

**Precondition:** `restPart` must reference only fields available via byIdentifier — needs a per-entity "field capability" map.

### C. Backend Choice for BulkScan

Decide **per phase**, not globally:
- ≤8 properties → JXA
- \>8 properties → AppleScript
- Very high → pre-compiled AppleScript

If a phase fuses multiple BulkScans, pick one backend for the whole phase based on total property count.

### D. "Predicate pushdown" is really id-set acquisition + enrichment

The only reason to do in-script filtering is to avoid reading many properties for many rows. Frame it as:
1. Get a small ID set first (membership scan, or cheap boolean filter)
2. Enrich by ID

Not "filter then bulk read subset" — rather "acquire IDs cheaply, then byIdentifier."

## Implementation Increments

### Increment 1: ByIdEnrich node + executor support
- Add `ByIdEnrich` PlanNode type (source: PlanNode producing idSet or rows, entity, fields)
- Add executor handler using OmniJS `byIdentifier()`
- Replace `.whose()` loop in PerItemEnrich entirely
- Add to compile.ts (ByIdEnrich is a phase-2 op, not fusible with phase-1 scans)

### Increment 2: Cost estimator answering two questions
- "Bulk scan vs byId for enrichment?" (cardinality threshold)
- "JXA vs AppleScript for bulk scan?" (property count threshold)
- Phase/Cost types on PlanNode, bottom-up computation
- Selectivity heuristics table

### Increment 3: MembershipScan + ByIdEnrich fusion
- Rewrite pass: when restPart needs only byId-fetchable fields, collapse to 1 phase
- Per-entity field capability map
- New emitter method: `membershipThenEnrich(membershipNode, fields)` → fused script

## Caution: OmniJS Variance

Keep OmniJSScan and ByIdEnrich separate in the cost model:
- **OmniJSScan**: last resort, large penalty, high variance
- **ByIdEnrich**: predictable linear function, low variance

Do not let the optimiser discover that OmniJSScan is sometimes cheap — hard-code it as dominated.
