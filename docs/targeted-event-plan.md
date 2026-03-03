# TargetedEventPlan: Lowering from EventPlan

Takes the runtime-agnostic `EventPlan` SSA graph and assigns each node a runtime,
groups co-runtime nodes into batches, and produces an execution-ordered `TargetedEventPlan`.

## Implemented runtimes

```typescript
type Runtime = 'jxa' | 'omniJS' | 'node'
```

**AppleScript** is a designed-for but not-yet-implemented target. The threshold logic
(≥ 8 property reads → AppleScript is 2–4× faster due to JXA bridge tax) is documented
here so the upgrade path is clear, but for now all AE bulk reads target `jxa`.

## Targeting rules

| Node | Runtime |
|---|---|
| `Zip`, `Filter`, `SemiJoin`, `HashJoin`, `Sort`, `Limit`, `Project`, `Derive` | `node` |
| `Get` / `Count` — bulk collection (`Elements`, chained `Property`) | `jxa` |
| `Get(ByID, literal id)` | `jxa` |
| `Get(ByID, Ref source)` | see heuristic below |
| `Get(ByName)` | `jxa` (used for source lookup in `ForEach`/membership scans) |
| `ForEach` | inherits body nodes' runtime |
| `Set` / `Command` — `nonMutating` | `jxa` |
| `Set` / `Command` — side-effectful | `jxa`, placed at barrier boundary |
| OmniJS-indicated nodes (from FallbackScan in strategy) | `omniJS` |
| `Hint` | transparent; propagates `hint.runtime` to `hint.source`'s node |

**Future AS upgrade (not implemented):** when batch has ≥ 8 `jxa` `Get` nodes sharing
the same collection parent, upgrade all to `applescript`. Since we emit JXA for now,
this pass is skipped.

### Get(ByID, Ref) — static heuristic targeting

When IDs come from a preceding computation (`Ref` source), the targeting pass applies a
static heuristic based on the source node type:

- Source node is annotated by a `Hint` → use `hint.runtime` (authoritative)
- Source is an `Elements` fetch or anything unbounded → `jxa`
  (bulk read wins decisively for large sets)
- Default (unknown): `jxa`

The heuristic is intentionally conservative. A runtime count check would itself have
cost (the source must be materialised before you can count it), and pre-compiling both
branches doubles executor complexity. A wrong heuristic costs at most ~40ms, which is
acceptable.

The `omniJS` emitter for `Get(ByID, Ref)` generates a loop over the ID array calling
`byIdentifier()` for each element; the count need not be known at compile time.

The Strategy→EventPlan lowering emits `Hint` nodes where it has specific knowledge: e.g.
when a `ByName` source is a single-item lookup, it wraps the source `Ref` in
`Hint { runtime: 'omniJS' }` to steer the targeting pass toward `byIdentifier()`.

## TargetedEventPlan structure

```typescript
interface Batch {
  index:     number
  runtime:   Runtime
  nodes:     Ref[]       // topologically ordered within batch
  dependsOn: number[]    // batch indices whose output this batch consumes
}

interface TargetedEventPlan {
  nodes:   Array<EventNode & { runtime: Runtime; batch: number }>
  batches: Batch[]
  result:  Ref
}
```

## Lowering algorithm

### Pass 1 — Initial targeting

Walk nodes in topological order. Assign runtime per the table above, applying the
`Get(ByID, Ref)` heuristic to choose between `jxa` and `omniJS`. `Hint` nodes are
consumed here — their `runtime` is applied to the sourced node and the `Hint` itself
is stripped from the plan (it carries no value of its own).

### Pass 2 — Partition at barriers

Walk nodes in topological order. A **barrier** exists before node N if any node M
that data-depends on (precedes) N has a conflicting side effect:

- M is `sideEffective` → N is in a new segment regardless
- M is `sideEffectiveFor(R)` and N is `sideEffectiveFor(R')` with R ∩ R' ≠ ∅ → barrier

`nonMutating` nodes float freely; they are assigned to the earliest segment consistent
with their data dependencies.

Each segment is a maximal set of nodes with no side-effect barriers between them.

### Pass 3 — Fuse within segments

Within each segment, group co-runtime nodes into a `Batch`. A segment produces at most
one batch per runtime (`jxa`, `omniJS`, `node`). Nodes within a batch are topologically
ordered by their SSA data dependencies.

### Pass 4 — Order batches

Topological sort of the `Batch` DAG. A batch B₂ depends on batch B₁ if any node in
B₂ consumes a `Ref` produced by a node in B₁. The result is `Batch.dependsOn[]` and
the overall execution order.

## Execution

The executor processes `batches` in order. For each batch:

- `runtime: 'jxa'` — generate JXA script from batch nodes, execute via `osascript`
- `runtime: 'omniJS'` — generate OmniJS script from batch nodes, execute via
  `Application('OmniFocus').evaluateJavascript()`
- `runtime: 'node'` — execute batch nodes inline in the host process

Batch results are stored in a result map keyed by `Ref`. Node-side nodes read their
inputs from this map and write their outputs back to it.

## What this does NOT include (yet)

- AppleScript runtime and the ≥8-property JXA→AS upgrade pass
- Pre-compiled `.scpt` cache (would save ~1.7s compilation overhead per AS invocation)
- Multi-app batching (co-scheduling batches across OmniFocus and DEVONthink)
- Re-targeting at execution time based on observed performance
