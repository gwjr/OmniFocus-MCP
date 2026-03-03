# Query Engine Cost Model & Optimisation Problem Space

## The Pipeline

```
User query (compact syntax)
  → lower.ts                AST: LoweredExpr (predicate tree: and/or/not/eq/contains/...)
  → lowerToSetIr.ts         SetIR tree (Scan, Filter, Intersect, Union, Restriction, ...)
  → optimizeSetIr            SetIR tree (rewritten: scan subsumption, merge scans)
  → lowerSetIrToEventPlan   EventPlan SSA graph (Get, Zip, Filter, SemiJoin, ...)
  → cseEventPlan + prune    EventPlan (CSE'd, dead columns removed)
  → assignRuntimes + split  TargetedEventPlan → ExecutionUnits
  → orchestrator             Rows
```

The optimisation problem: given an AST and entity type, produce execution that minimises wall-clock time. The cost is dominated by **sequential OSA phases** — the number of times we must call osascript, wait for results, then call osascript again.

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

> **Note:** The node names below are from the cost-model design space, not the
> current implementation. The SetIR pipeline uses Scan, Filter, Restriction,
> Enrich, Intersect, Union, Difference, and Count. The mapping is straightforward:
> BulkScan ≈ Scan, MembershipScan ≈ Restriction (via `.whose()`), ByIdEnrich ≈
> Enrich (ForEach + by-id read). OmniJSScan has been eliminated.

For each plan node, compute `rowsOut`/`idsOut` and `phases`:

| Node | Cardinality | Phases |
|------|-------------|--------|
| BulkScan (Scan) | collectionSize(entity) | 1 phase: bulkProps = columns.length |
| MembershipScan (Restriction) | heuristic (~20) | 1 phase: membershipWork |
| ByIdEnrich (Enrich) | source cardinality | 1 phase: byIdItems = source.idsOut |
| Filter | source.rowsOut × selectivity(pred) | 0 phases |
| SemiJoin | min(source.rowsOut, lookup.idsOut) | merge child phases (fuse if independent) |
| CrossEntityJoin (HashJoin) | source.rowsOut | merge child phases (fuse if independent) |
| Sort / Pick | passthrough | 0 phases |
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

## Implementation Status

> The implementation increments originally listed here (ByIdEnrich node,
> cost estimator, MembershipScan+ByIdEnrich fusion) have been superseded by
> the SetIR pipeline. The SetIR optimizer implements scan subsumption, project-
> exclusion elision, and phase fusion natively. See `docs/query-engine-architecture.md`
> for the current pipeline architecture.

The remaining optimisation opportunities from this cost model:
- **Backend choice for BulkScan** (JXA ≤8 props, AppleScript >8 props) — under investigation as AppleScript codegen (Task #38).
- **MembershipScan + Enrich fusion** — not yet implemented; would collapse 2 phases to 1 for tag-filtered queries with expensive columns.
- **Predicate pushdown as id-set acquisition** — the SetIR `Restriction` node implements this pattern for container/containing predicates.
