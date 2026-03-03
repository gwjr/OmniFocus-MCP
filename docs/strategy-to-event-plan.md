# Strategy → EventPlan Lowering

Translates the `StrategyNode` tree into an `EventPlan` SSA graph. This is the last
pass that carries OmniFocus-specific knowledge — everything below (targeting, emission)
is generic.

## Algorithm

A recursive `lower(node: StrategyNode): Ref` function walks the tree bottom-up.
A **builder** maintains the flat node array; `push(eventNode): Ref` appends a node
and returns its index (its SSA `Ref`).

```
lower(strategyNode):
  match strategyNode.kind:
    'BulkScan'       → lowerBulkScan(node)
    'FallbackScan'   → lowerFallbackScan(node)
    'MembershipScan' → lowerMembershipScan(node)
    'PerItemEnrich'  → lowerPerItemEnrich(node)
    'Filter'         → lowerFilter(node)
    'PreFilter'      → lowerPreFilter(node)
    'Sort'           → lowerSort(node)
    'Limit'          → lowerLimit(node)
    'Project'        → lowerPick(node)
    'SemiJoin'       → lowerSemiJoin(node)
    'CrossEntityJoin'→ lowerCrossEntityJoin(node)
```

After the walk, run **CSE** over the node array to canonicalise duplicate specifiers
(see `event-plan-ir.md`). CSE is mandatory — the mechanical per-column lowering of
`BulkScan` produces duplicate `Elements` nodes that must be unified before execution.

FourCC constants come from the generated sdef file (`src/generated/omnifocus-sdef.ts`).
The lowering never contains raw string literals for codes — always named constants.

---

## Active-item filter expressions

`includeCompleted: false` in `BulkScan`/`FallbackScan` becomes a `Filter` node with
a `LoweredExpr` predicate. The expressions by entity:

| Entity | Active filter predicate |
|---|---|
| `tasks` | `{and:[{not:[{var:'effectivelyCompleted'}]},{not:[{var:'effectivelyDropped'}]}]}` |
| `projects` | `{in:[{var:'status'},['active','on hold']]}` |
| `tags` | `{not:[{var:'effectivelyHidden'}]}` |
| `folders` | `{not:[{var:'hidden'}]}` |

These are app-specific rules. They live here — not in the strategy layer, not in the
emitter.

---

## Node mappings

### BulkScan

Lowers columns by cost class. Each column becomes a `Get` on the entity collection.
Chain columns become nested specifiers. Computed vars become a `Derive` at the end.

```
%0 = Get(Elements(Document, classCode(entity)))

-- easy column, e.g. 'name':
%1 = Get(Property(%0, propertyCode(entity, 'name')))

-- chain column, e.g. 'containingProject' → 'name':
%2 = Get(Property(Property(%0, OFTaskProp.containingProject), OFProp.name))

-- chain column, e.g. 'tags' → 'name' (returns nested arrays):
%3 = Get(Property(Property(%0, OFTaskProp.tags), OFProp.name))

%4 = Zip([name:%1, containingProjectName:%2, tags:%3])

-- if includeCompleted=false:
%5 = Filter(%4, activeFilterExpr(entity))

-- if computedVars non-empty (e.g. 'status' derived from 'completed','dropped',…):
%6 = Derive(%5, deriveSpecs(entity, computedVars))

result: %6 (or %5 or %4 depending on which steps apply)
```

`deriveSpecs` is constructed from `computedVarDeps` in `variables.ts` — the same
derivation rules the current executor uses.

---

### FallbackScan

Bulk-fetch the entire entity collection, filter in-process.

```
%0 = Get(Elements(Document, classCode(entity)))

-- combine active filter with the query predicate if includeCompleted=false:
%1 = Filter(%0, combinedPredicate)

result: %1
```

`combinedPredicate` = `{and: [activeFilterExpr(entity), filterAst]}` when
`includeCompleted=false`, otherwise just `filterAst`.

No `Hint` by default. The targeting pass assigns `Filter` to `node` runtime and the
`Get(Elements)` to `jxa`.

---

### MembershipScan

Find the source entities matching the predicate, then collect all target-entity IDs
that belong to them.

```
%0 = Get(Elements(Document, classCode(sourceEntity)))   -- e.g. all tags
%1 = Filter(%0, predicate)                              -- matching tags

%2 = ForEach(%1) {
  -- %2 inside body = current source item (AE object ref)
  %3 = Get(Elements(%2, classCode(targetEntity)))        -- e.g. tag's flattenedTasks
  %4 = Get(Property(%3, OFProp.id))                     -- their IDs
  collect: %4
}
-- %2 outside = flat array of target IDs

result: %2
```

The configured entity → element class mappings (from sdef):

| Source → Target | Element class on source |
|---|---|
| `tags → tasks` | `flattenedTask` (`FCft`) |
| `projects → tasks` | `flattenedTask` (`FCft`) |
| `folders → projects` | `flattenedProject` (`FCfx`) |

---

### PerItemEnrich

Extract IDs from the source rows, fetch additional properties per-item via AE, rejoin.

```
%source = lower(node.source)                -- [{id, name, …}, …]

%1 = ColumnValues(%source, 'id')            -- ['abc', 'def', …]

%2 = ForEach(%1) {
  -- %2 inside body = current ID string
  %3 = Get(ByID(Elements(Document, classCode(entity)), %2))
  -- one Get per per-item var:
  %4 = Get(Property(%3, propertyCode(entity, var1)))
  %5 = Get(Property(%3, propertyCode(entity, var2)))
  %6 = Zip([id:%2, var1:%4, var2:%5])
  collect: %6
}
-- %2 outside = [{id, var1, var2}, …]

%7 = HashJoin(%source, %2,
       sourceKey: 'id',
       lookupKey: 'id',
       fieldMap: {var1:'var1', var2:'var2'})

result: %7
```

The `Get(ByID, Ref)` at `%3` is a candidate for an `omniJS` `Hint` — the strategy
layer knows `PerItemEnrich` is used for small result sets and `byIdentifier()` is fast
there. Emit `Hint(%3, 'omniJS')` when `node.perItemVars.size` is small (below
`node.threshold`).

---

### Filter

```
%source = lower(node.source)
%result = Filter(%source, node.predicate)

result: %result
```

`node.predicate` is already a `LoweredExpr` — passes through unchanged.

---

### PreFilter

Identical to `Filter`. `assumeTrue` was a planner optimisation hint for the executor;
it has no meaning in EventPlan and dissolves here.

```
%source = lower(node.source)
%result = Filter(%source, node.predicate)

result: %result
```

---

### Sort

```
%source = lower(node.source)
%result = Sort(%source, by: node.by, dir: node.direction)

result: %result
```

---

### Limit

```
%source = lower(node.source)
%result = Limit(%source, n: node.count)

result: %result
```

---

### Project (→ Pick)

`StrategyNode.Project` lowers to `EventNode.Pick`. Renamed to avoid collision with
the OmniFocus domain concept.

```
%source = lower(node.source)
%result = Pick(%source, fields: node.fields)

result: %result
```

---

### SemiJoin

```
%source = lower(node.source)
%lookup = lower(node.lookup)    -- produces a flat id array (from MembershipScan)
%result = SemiJoin(%source, ids: %lookup)

result: %result
```

---

### CrossEntityJoin

```
%source = lower(node.source)
%lookup = lower(node.lookup)
%result = HashJoin(%source, %lookup,
            sourceKey: node.sourceKey,
            lookupKey: node.lookupKey,
            fieldMap:  node.fieldMap)

result: %result
```

---

## What this lowering does NOT do

- Runtime targeting — that is `TargetedEventPlan`'s job
- Optimisation beyond emitting `Hint` nodes — CSE is the only pass applied here
- Flattening the `EventPlan` into batches — that is the partition+fusion pass
- Resolving human-readable names after this point — all FourCCs are resolved here;
  the IR below contains only codes
