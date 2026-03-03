# EventPlan IR

Intermediate representation between the SetIR (algebraic query plan) and emitted
code (JXA / AppleScript / Node).

## Purpose

SetIR answers *what to compute* at the query-plan level (Scan, Intersect, Filter,
Restriction…). EventPlan answers *what primitive operations to perform* — as a
traversable SSA graph rather than opaque strings.

Key properties:
- **Runtime-agnostic**: no JXA, AppleScript, or OmniJS syntax embedded. Runtime is a
  targeting annotation added by a later pass.
- **App-specific involvement stops here**: the SetIR→EventPlan lowering carries all
  OmniFocus (or other app) knowledge. Everything below is generic.
- **SSA form**: each node is a numbered binding (`%0`, `%1`, …). Values are immutable
  references. Data flow is explicit.
- **Traversable**: unlike source-text AppleScript, the graph can be inspected,
  partitioned, and optimised.

## Primitive types

```typescript
type FourCC   = string   // 4-char Apple Events code, e.g. 'pnam', 'FCft'
type Resource = string   // scoped resource identifier, e.g. 'of:tasks', 'dt:records'
type Ref      = number   // index into the EventPlan node array (SSA binding)
```

## Side effects

```typescript
type SideEffect =
  | 'nonMutating'
  | { kind: 'sideEffectiveFor'; resources: Resource[] }
  | 'sideEffective'     // conservative: full barrier, assume mutates everything
```

Two nodes may be reordered / fused unless at least one is `sideEffective`, or both are
`sideEffectiveFor` with overlapping resource sets. `nonMutating` floats freely.

Read effects are not tracked. If we ever encounter a system where reading is a mutating
operation that will be handled as a special case.

## Specifiers

Specifiers describe AE object addresses. They are structural (not SSA values) — no
value is produced until a specifier is wrapped in a `Get` or `Count`. `parent` may be
either a nested specifier or a `Ref` (used inside `ForEach` bodies where the loop
variable is an AE object reference).

```typescript
type Specifier =
  | { kind: 'Document' }
  | { kind: 'Elements';  parent: Specifier | Ref; classCode: FourCC }
  | { kind: 'Property';  parent: Specifier | Ref; propCode:  FourCC }
  | { kind: 'ByID';      parent: Specifier | Ref; id:   string | Ref }
  | { kind: 'ByName';    parent: Specifier | Ref; name: string | Ref }
  | { kind: 'ByIndex';   parent: Specifier | Ref; index: number }
```

Chained property access (`task.containingProject.name`) is nested specifiers:

```
Property(
  Property(Elements(Document, FCft), pCon),
  pnam
)
```

No special `ChainGet` node — the specifier structure *is* the chain. The emitter walks
it and emits dots.

FourCCs come from the app's sdef. The SetIR→EventPlan lowering resolves human-
readable names (from `variables.ts` etc.) to FourCCs at lowering time using the
`aeProps.ts` tables (derived from the parsed sdef). The IR itself only ever
contains FourCCs.

## EventPlan nodes

Each node occupies a slot in the plan array; its slot index is its `Ref`.

```typescript
type EventNode =

  // ── AE reads ────────────────────────────────────────────────────────────

  | { kind: 'Get';
      specifier: Specifier;
      effect: SideEffect;         // almost always 'nonMutating'
    }

  | { kind: 'Count';
      specifier: Specifier;
      effect: SideEffect;
    }

  // ── AE writes / commands ────────────────────────────────────────────────

  | { kind: 'Set';
      specifier: Specifier;
      value: Ref;
      effect: SideEffect;         // typically sideEffectiveFor the affected entity
    }

  | { kind: 'Command';
      fourCC:  FourCC;
      target:  Specifier;
      args:    Record<string, Ref | string | number>;
      effect:  SideEffect;
    }

  // ── Iteration ───────────────────────────────────────────────────────────
  //
  // Iterates over `source` — a collection of any kind (AE element set, flat value
  // array from ColumnValues, etc.). The set of valid collection types is open.
  // The ForEach node occupies index N in the plan.
  //
  // Ref N is SCOPED — its meaning depends on where it appears:
  //   • Inside `body`:   Ref N resolves to the current iteration item.
  //   • Outside `body`:  Ref N resolves to the accumulated result — the flat
  //                      collection of `collect` values across all iterations.
  //
  // Using Ref N (as "current item") in a node outside this ForEach's body
  // is a compile error. The emitter tracks a ForEach stack to resolve this.
  //
  // Maps to: JS for-loop (JXA/Node), repeat-with (AppleScript), for-of (OmniJS).
  //
  // Convention: no loop-invariant expressions in body — the lowering pass guarantees
  // this; we do not implement invariant hoisting.

  | { kind: 'ForEach';
      source:  Ref;
      body:    EventNode[];
      collect: Ref;
      effect:  SideEffect;
    }

  // ── Node-side operations (no AE involvement) ────────────────────────────

  | { kind: 'Zip';
      columns: { name: string; ref: Ref }[];
    }

  // Extract a single named field from each row in a row array, producing a flat
  // value array. Primary use: preparing a column for ForEach or Get(ByID, Ref).
  // Inverse direction of Zip for a single column.
  | { kind: 'ColumnValues';
      source: Ref;
      field:  string;
    }

  // Flatten one level of nesting from an array of arrays.
  // e.g. [['a','b'], [], ['c']] → ['a', 'b', 'c']
  | { kind: 'Flatten';
      source: Ref;
    }

  | { kind: 'Filter';
      source:    Ref;
      predicate: LoweredExpr;   // compiled at emission time to NodePredicate / JXA / OmniJS
    }

  | { kind: 'SemiJoin';
      source: Ref;
      ids:    Ref;                // Ref to a string[] / Set<string>
    }

  | { kind: 'HashJoin';
      source:    Ref;
      lookup:    Ref;
      sourceKey: string;
      lookupKey: string;
      fieldMap:  Record<string, string>;
    }

  | { kind: 'Sort';
      source: Ref;
      by:     string;
      dir:    'asc' | 'desc';
    }

  | { kind: 'Limit';
      source: Ref;
      n:      number;
    }

  // Narrow a row array to a subset of fields. Named Pick to avoid collision with
  // the OmniFocus domain concept of a "project".
  | { kind: 'Pick';
      source: Ref;
      fields: string[];
    }

  | { kind: 'Derive';
      source:      Ref;
      derivations: DeriveSpec[];  // computed-var derivation rules (from existing executor)
    }

  // ── Targeting hint ──────────────────────────────────────────────────────
  //
  // Transparent to data flow: value equals source's value.
  // Carries a runtime preference that the targeting pass treats as authoritative,
  // overriding its default heuristics for the sourced node.
  //
  // Emitted by the SetIR→EventPlan lowering, which has app-specific knowledge
  // the generic targeting pass does not (e.g. that a Ref comes from a ByName lookup
  // and will always be small, so Get(ByID, Ref) should target a specific runtime).

  | { kind: 'Hint';
      source:  Ref;
      runtime: Runtime;
    }
```

## The plan

```typescript
interface EventPlan {
  nodes:  EventNode[];   // index = Ref
  result: Ref;           // which node's value is the query output
}
```

## Optimisation passes over EventPlan

### CSE (Common Subexpression Elimination) — required

The SetIR→EventPlan lowering works mechanically from a tree, so the same specifier
can appear in multiple sibling nodes without the lowering having cross-subexpression
visibility. For example, a `Scan` with three columns produces three `Get` nodes
all sharing `Elements(Document, FCft)` as parent — without CSE those are three
separate AE round-trips.

CSE is the one pass that cannot be deferred: it is structurally impossible to eliminate
during lowering. Two `Get` nodes with structurally identical specifiers are the same
value; CSE detects this and canonicalises them to a single `Ref`.

Specifier structural equality: recursive comparison of `kind` + `FourCC` + parent.
`ByID`/`ByName` also compare their `id`/`name` literal (or Ref index for dynamic
values).

### Partition + fusion — required for correctness and performance

Divide the DAG at `sideEffective` / `sideEffectiveFor` barriers. Within each partition,
co-runtime nodes may be fused into a single batch call (one `osascript` invocation, one
`evaluateJavascript` call, etc.).

### Other passes — not needed

DCE is vacuous: the IR has no branching, so nothing produced by a correct lowering
is unreachable. Loop-invariant hoisting is unnecessary because the lowering guarantees
no invariants are left in `ForEach` bodies. No further passes are anticipated.

## Runtime targeting (post-EventPlan pass)

The targeting pass annotates each node with a runtime. This is NOT part of the EventPlan
IR — it lives in `TargetedEventPlan`:

```typescript
type Runtime = 'jxa' | 'applescript' | 'omniJS' | 'node'

type TargetedNode = EventNode & { runtime: Runtime }
```

Targeting decisions are made here, e.g.:
- `Get(ByID(...))` with many IDs → target `omniJS` (uses `Task.byIdentifier()`)
- `Get(ByID(...))` with few IDs  → target `jxa`
- All Node-side nodes → target `node`

The fusion pass then groups co-runtime nodes into batches (one `osascript` / one
`evaluateJavascript` call per batch).

## Emission

Emission is mechanical pattern-matching on `(node.kind, node.runtime)`. Each case
emits the appropriate syntax for that runtime. Because targeting is already resolved,
emitters contain no strategic logic — only syntax.

## Debug representation

Each IR level has a textual dump format for logging and regression diagnosis. The
visitor pattern mirrors the existing `Describer` backend for `LoweredExpr`.

### EventPlan — SSA notation

```
%0 = Get(Elements(Document, 'FCft'))
%1 = Get(Property(%0, 'pnam'))
%2 = Get(Property(%0, 'FCdu'))
%3 = Zip([name:%1, dueDate:%2])
%4 = Filter(%3, {and:[{var:"flagged"},{gt:[{var:"dueDate"},{date:"2025-01-01"}]}]})
result: %4
```

`ForEach` shows its scoped item binding explicitly:

```
%5 = ForEach(%1) {          // inside body: %5 = current item; outside: %5 = accumulated result
  %6 = Get(Property(%5, 'pnam'))
  collect: %6
}
```

`Hint` shows the runtime it carries:

```
%7 = Hint(%4, omniJS)
```

### TargetedEventPlan — SSA with batch annotations

Same notation, with `[runtime batch:N]` suffix on each line and batch boundaries shown:

```
── batch 0 [jxa] ──────────────────────────────
%0 = Get(Elements(Document, 'FCft'))       [jxa batch:0]
%1 = Get(Property(%0, 'pnam'))             [jxa batch:0]
── batch 1 [node] ─────────────────────────────
%2 = Filter(%0, ...)                       [node batch:1]
result: %2
```

### SetIR — indented tree

```
Filter(flagged = true)
  Scan tasks [id, name, flagged, dueDate]
```

### Emitted scripts

The JXA and OmniJS emitters expose the generated script string before execution so it
can be logged on demand. A debug flag (or environment variable) causes the executor to
print the script to stderr alongside its result, enabling before/after comparison when
investigating regressions.

## What EventPlan does NOT contain

- JXA, AppleScript, or OmniJS syntax
- Cost model or query planning logic (lives in the SetIR layer)
- Active-item filter semantics (injected into the predicate before SetIR lowering)
- Human-readable property names (resolved to FourCCs during lowering)
- `sideEffective` annotations as optimisation hints — they are for correctness
  (ordering constraints) only
