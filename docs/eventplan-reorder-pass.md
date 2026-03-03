# EventPlan Node Reordering Pass — Design

## Status

Implemented — `src/tools/query/eventPlanReorder.ts`, wired into orchestrator pipeline.

## Context

The EventPlan SSA emitter produces nodes in lowering order, which interleaves
JXA and node-runtime operations. After CSE deduplicates shared `Get(Elements)`
specifiers, chain property reads may be separated from their Elements base by
intervening node-runtime nodes.

**Concrete example** — `projects` with `select: ['name', 'folderName']`:
```
%0  Get(Elements(Doc, FCfx))                → jxa
%1  Get(Property(%0, ID))                   → jxa
%2  Get(Property(%0, pnam))                 → jxa
%3  Zip([id:%1, name:%2])                   → node  ← breaks JXA run
%4  Get(Property(Property(%0, ctnr), ID))   → jxa   ← new EU, needs %0
```

The consecutive-runtime splitter creates three EUs: [%0–%2], [%3], [%4]. The
third EU needs %0 as input — a non-materializing AE specifier.

### Current fix: Input/Output bindings

The `computeBindings` pass (in `targetedEventPlanLowering.ts`) detects
non-materializing AE specifier refs crossing EU boundaries and:

- **JXA→JXA**: marks the input as `kind: 'specifier'` with the full specifier
  tree, so the consuming JXA unit reconstructs the specifier in-place rather
  than deserializing from JSON.
- **JXA→node**: throws a compile error (AE specifiers are not JSON-serializable
  and cannot be consumed by node-runtime EUs).

This makes the pipeline correct even with interleaved node order. The
reordering pass is an **optimization** — it reduces unnecessary EU splits and
IPC round-trips (~50ms per osascript call).

## Algorithm: priority-queue topo-sort

### Input / Output

```typescript
export function reorderEventPlan(plan: EventPlan): EventPlan
```

Takes an EventPlan (pre-targeting) and returns a new EventPlan with the same
nodes in a reordered sequence, refs compacted to new positions.

### Steps

1. **Build dependency graph.** For each node, compute predecessor Refs using
   `collectRefs()` (from `targetedEventPlanLowering.ts`).

2. **Add mutation barriers.** Nodes with `effect !== 'nonMutating'` (Set,
   Command, mutating ForEach) must preserve their relative order. Add implicit
   dependency edges between consecutive mutating nodes.

3. **Compute in-degree** for each node.

4. **Classify runtime.** Check `hint` field first, fall back to
   `defaultRuntime(node)` (from `targetedEventPlanLowering.ts`).

5. **Priority-queue topo-sort.** Maintain a ready set (in-degree = 0).
   Tie-breaking:
   - **Same runtime as last emitted node** — extends the current run.
   - **Among same-runtime candidates** — lower original SSA index (stability).
   - **No same-runtime candidate ready** — lowest-index of any runtime.

6. **Compact refs.** Build old→new Ref map, rewrite all Refs in nodes and
   specifiers using `rewriteNode()` (from `eventPlanCSE.ts`).

### Why not a sort?

A simple sort (e.g. "JXA first, then node") violates data dependencies. The
topo-sort with runtime-aware tie-breaking is the minimal correct approach.

## Pipeline placement

```
lowerStrategy → cseEventPlan → pruneColumns → reorderEventPlan → assignRuntimes → splitExecutionUnits → computeBindings
```

After CSE and column pruning (which may eliminate nodes), before runtime
assignment and EU splitting.

## Shared utilities to extract

| Function | Current location | Used by |
|----------|-----------------|---------|
| `rewriteNode(node, remapFn)` | `eventPlanCSE.ts` | CSE compaction, reorder compaction |
| `collectRefs(node)` | `targetedEventPlanLowering.ts` | EU splitting, reorder dependency graph |
| `defaultRuntime(node)` | `targetedEventPlanLowering.ts` | Runtime assignment, reorder classification |

Extract to `eventPlanUtils.ts` and import from both consumers.

## Test plan

Unit tests constructing EventPlans by hand (pattern from `eventPlanCSE.test.ts`):

| Test | Scenario | Expected |
|------|----------|----------|
| No-op | JXA nodes, then node nodes | Same order |
| Interleaved Zip | Get, Get, Get, Zip, Get | Trailing Get hoisted before Zip |
| Two JXA groups | JXA, node, JXA (independent) | Both JXA groups consolidated |
| Dependency barrier | Node op that later JXA depends on | Node stays before JXA |
| Mutation ordering | Set, Get, Set | Set order preserved |
| Result ref | Plan result after renumbering | Correctly mapped |

Integration: all 24 tests in `setIrPipeline.integration.ts` should remain green.

## Effect on EU count

For the folderName query, the reorder pass would consolidate all JXA nodes
into a single run:

**Before** (3 EUs):
```
EU0 [jxa]: %0 Get(Elements), %1 Get(Prop ID), %2 Get(Prop name)
EU1 [node]: %3 Zip
EU2 [jxa]: %4 Get(Prop container.id)  ← specifier input from EU0
```

**After** (2 EUs):
```
EU0 [jxa]: %0 Get(Elements), %1 Get(Prop ID), %2 Get(Prop name), %3 Get(Prop container.id)
EU1 [node]: %4 Zip
```

One fewer osascript call (~50ms saved) and no cross-EU specifier reconstruction.
