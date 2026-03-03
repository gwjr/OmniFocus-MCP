# Native AE `count` and `exists` Commands for op:count/exists Queries

**Date:** 2026-03-03
**Status:** Investigation — do not implement yet
**Task:** #57

---

## Background

When the query engine evaluates `op:'count'` or `op:'exists'`, the current pipeline:

1. Bulk-reads all matching entity IDs via JXA (`flattenedTasks.id()` → ~163ms)
2. Materialises the full row set through Node-side filter
3. Wraps with `RowCount` (for count) or `Limit(1)` (for exists)

The question is whether dispatching a native Apple Events `count` command or `exists` command directly on a filtered AE specifier could return the answer in one round-trip without materialising any rows.

---

## AE Command Definitions (from sdef)

Both commands are in the Standard Suite, code `corecnte` and `coredoex`:

```xml
<!-- count: corecnte -->
<command code="corecnte" name="count">
  <direct-parameter type="specifier"/>          <!-- object to count -->
  <parameter code="kocl" name="each" optional="yes" type="type"/>  <!-- class filter -->
  <result type="integer"/>
</command>

<!-- exists: coredoex -->
<command code="coredoex" name="exists">
  <direct-parameter type="any"/>
  <result type="boolean"/>
</command>
```

Both are implemented in OmniFocus via `NSCountCommand` and `NSExistsCommand` — standard Cocoa Scripting implementations.

---

## Current `Count` Node in the EventPlan IR

There is already a `Count` EventPlan node:

```typescript
// eventPlan.ts, line 103
| { kind: 'Count';
    specifier: Specifier;
    effect: SideEffect;
  }
```

And jxaUnit.ts emits it as:

```typescript
// jxaUnit.ts, line 269
case 'Count': {
  const specExpr = emitSpecifier(ctx, node.specifier);
  ctx.lines.push(`var ${varName} = ${specExpr}.length;`);
  break;
}
```

**Key observation:** `.length` on an AE specifier in JXA does NOT dispatch a native AE `count` command. In JXA, `.length` on a specifier reference returns `undefined` — it is a JavaScript property access on a proxy object. The actual count is only produced when the specifier is materialised (e.g. via `.id()` which returns an array). So the current `Count` node in `jxaUnit.ts` only works correctly when `specifier` is a `Get`-materialised array reference, not a raw specifier. Looking at the current pipeline, `Count` is used in SetIR lowering as `RowCount` (Node-side count of a materialised row array), not as a native AE count. The `Count` EventPlan node appears unused in the current lowering path (SetIR `Count` lowers to `RowCount`, not to `Count`).

---

## JXA Syntax Options

### Option A: `.length` on materialised collection (current implied approach)

```javascript
// First materialise ids, then take .length
var ids = doc.flattenedTasks.id();        // ~163ms — returns real JS array
var count = ids.length;                   // free — JS array property
```

**Cost:** ~163ms (one bulk read round-trip). This is what the current pipeline does after Node-side filtering.

### Option B: native AE `count` command via JXA

JXA exposes Standard Suite commands as methods on specifier objects. The `count` command (corecnte) can be invoked as:

```javascript
// On an unfiltered collection
var n = doc.flattenedTasks.count();       // dispatches corecnte AE

// On a whose()-filtered specifier
var n = doc.flattenedTasks.whose({flagged: true}).count();
```

Per REPORT.md Section 2, the "collection access floor" for `flattenedTasks.length` costs ~122ms (which in that benchmark likely resolves to a count AE under the hood). A dedicated `.count()` call should cost similarly — ~100–120ms for any collection size.

**For a Whose-filtered specifier**, the `count` command is server-evaluated by OmniFocus: it applies the whose predicate and returns the count without serialising any item data. This is structurally similar to `.whose().id()` (used in the existing pipeline for tag-name lookups) but returns only a scalar integer.

**Estimated cost:** ~100–150ms (one AE round-trip, no row serialisation)

### Option C: native AE `exists` command via JXA

```javascript
// Unfiltered (always true for non-empty collection)
var exists = doc.flattenedTasks.exists();

// Filtered (does any flagged task exist?)
var exists = doc.flattenedTasks.whose({flagged: true}).exists();

// First-element exists — cheaper than count for op:exists
var exists = doc.flattenedTasks.whose({flagged: true})[0].exists();
```

The `exists` command dispatches `coredoex`, which returns `boolean`. For a `whose`-filtered specifier, OmniFocus must evaluate the predicate but can short-circuit after finding the first match (implementation-dependent; standard `NSExistsCommand` behaviour is not documented as short-circuiting, but it only needs to return true/false).

**Estimated cost:** ~100–150ms (one AE round-trip)

### Option D: native AE `count` on a sub-collection of a materialized reference

When a specific object reference is already in hand (e.g., a project fetched via `byIdentifier` or held as a Restriction specifier), counting its sub-elements dispatches a cached property read on that single object rather than enumerating a large collection:

```javascript
// Already have a specific project reference
var proj = doc.flattenedProjects.byId('abc123');
var tagCount = proj.tags.count();    // ~fast — reads cached count on that object
var taskCount = proj.tasks.count();  // ~fast — same
```

This is fast because:
- The count is a property of the already-materialized AE object, not a filtered scan
- OmniFocus caches sub-element counts on individual objects
- No `whose()` enumeration is involved

**Contrast with `whose().count()`** (Option B), which requires OmniFocus to scan and evaluate a predicate across the full collection.

**Relevance to future work:** Once a project (or folder/tag) reference is materialized — e.g., after a `byIdentifier` lookup or a `Restriction`-based fetch — counting its sub-elements natively is essentially free. This would apply to queries like "how many tasks in project X?" when project X is already identified. Current pipeline does not exploit this; it re-scans `flattenedTasks` filtered by `projectId`.

**Performance tiers for AE count operations:**

| Pattern | Example | Cost | Notes |
|---------|---------|------|-------|
| Unfiltered collection | `flattenedTasks.length` | ~12ms | Native property, no scan |
| Sub-collection on materialized ref | `specificProj.tags.count()` | ~fast | Cached on object, no scan |
| `whose()`-filtered count | `flattenedTasks.whose({...}).count()` | ~100–150ms | Server-side scan, no serialisation |
| Bulk id read + Node count | `flattenedTasks.id().length` | ~163ms | Current pipeline for filtered count |

---

## Constraint: Whose Specifier Limitations

The existing `Whose` specifier node only supports single-property equality and contains predicates:

```typescript
// eventPlan.ts, line 78
| { kind: 'Whose'; parent: Specifier | Ref; prop: FourCC; match: 'eq' | 'contains'; value: string };
```

The AE whose descriptor supports richer predicates (AND, OR, NOT, comparison operators), but the current IR only exposes a subset. This means native AE count/exists is only applicable to queries that reduce to a single-property whose predicate. Complex predicates (multi-condition, date comparisons, etc.) would still require the bulk-read + Node-filter path.

**Current use of Whose:** Only used by `lowerTagNameTaskIds` for the tag-name shortcut (tag by name lookup). It is not used for general task filtering.

---

## Feasibility Analysis

### When would native AE count/exists help?

The optimisation is applicable when:

1. The predicate reduces to a single `whose`-expressible condition (single property, equality or contains match)
2. The entity is `flattenedTasks`, `flattenedProjects`, `flattenedTags`, or `flattenedFolders`
3. The op is `count` or `exists`

**Example queries that would benefit:**
- "How many flagged tasks are there?" → `doc.flattenedTasks.whose({flagged: true}).count()`
- "Do any tasks have name containing 'milk'?" → `doc.flattenedTasks.whose({name: {_contains: 'milk'}}).exists()`
- "How many active projects?" → `doc.flattenedProjects.whose({status: 'active status'}).count()`

**Queries that would NOT benefit (still require bulk-read path):**
- Any multi-condition predicate: `flagged AND dueDate < X`
- Date-range predicates (not expressible in AE whose as a single condition)
- Container/tag membership predicates
- Any `op:'get'` query

### Savings estimate

| Path | Cost | Savings |
|------|------|---------|
| Current (bulk id read + Node count) | ~163ms | — |
| Native AE count on whose specifier | ~100–150ms | ~13–63ms |

The savings are modest — at most one IPC floor's worth (~100ms). The current path (bulk id read) is already optimised; it avoids reading any properties beyond `id`. The native AE count path saves the id array serialisation and Node-side array length, but the AE round-trip cost is approximately the same.

For `op:'exists'`, the savings could be slightly larger because the current path with `Limit(1)` still bulk-reads all IDs, whereas native AE `exists` on a whose specifier might short-circuit internally.

### Task-entity complication

Task queries must subtract project IDs (`flattenedProjects`) to avoid counting project root tasks as tasks. The native AE count on `flattenedTasks.whose(...)` would include project root tasks. This means:

- For count: native AE result must subtract a separate project count (`flattenedProjects.whose(...).count()`) — adding a second round-trip that may negate the savings
- For exists: native AE exists on tasks is correct only if the predicate is never satisfied by a project (i.e., it uses a task-only variable like `inInbox` or `flagged` on a non-project context — but projects also have `flagged`)

This complication significantly reduces the applicability for tasks. Tags, projects, and folders don't have this issue.

---

## Design: New EventPlan Nodes

If implemented, two new nodes would be needed:

### `CountSpecifier` node

```typescript
| { kind: 'CountSpecifier';
    specifier: Specifier;    // the filtered collection specifier
    effect: SideEffect;
  }
```

JXA emission:
```javascript
var _r0 = doc.flattenedTasks.whose({flagged: 'true'}).count();
// Returns integer
```

Estimated latency: ~100–150ms. Compared to current `RowCount(Filter(Get(id)))` path: ~163ms (bulk id read) + negligible Node filter.

### `ExistsSpecifier` node

```typescript
| { kind: 'ExistsSpecifier';
    specifier: Specifier;    // the filtered collection specifier (or first-element specifier)
    effect: SideEffect;
  }
```

JXA emission options:
```javascript
// Option 1: exists on the filtered specifier
var _r0 = doc.flattenedTasks.whose({flagged: 'true'}).exists();
// Returns boolean

// Option 2: first-element exists (may short-circuit earlier)
var _r0 = doc.flattenedTasks.whose({flagged: 'true'})[0].exists();
// Returns boolean — false if no match
```

Estimated latency: ~100–150ms. Compared to current `Limit(1, Filter(Get(id)))` path: same ~163ms bulk read, short-circuit after first match in Node.

---

## Recommendation

**Do not implement this optimisation.** The reasons:

1. **Modest savings (~13–63ms).** The current pipeline already does one AE round-trip (~163ms for id read). The native command saves array serialisation but not the AE call itself. The improvement is at the noise floor.

2. **Narrow applicability.** Only single-property whose-expressible predicates qualify. Complex predicates — which are the common case in practice — still require the bulk-read path. A specialised code path for a small minority of queries adds maintenance overhead for little gain.

3. **Task-entity complication.** The project-exclusion requirement for task queries adds a second AE call, negating much of the savings. Tasks are the most common query entity.

4. **Whose is already slow in the general case.** REPORT.md Section 5 documents that `.whose()` on large collections costs ~150ms for a single call and does not scale well. Applying `count` or `exists` to a whose specifier avoids row materialisation, but the whose predicate evaluation is still server-side linear scan.

5. **Better alternatives exist.** For count/exists on already-filtered result sets (e.g. after a SemiJoin), the current `RowCount` and `Limit(1)` paths are already O(1) in Node after the bulk read. The bulk read is the bottleneck, and the native AE command does not improve that.

If there is a future use case where count/exists on a simple specifier is needed (e.g., a new query surface that doesn't require Node-side filtering), the `Count` EventPlan node already exists and `jxaUnit.ts` emits it — it just needs the emission corrected from `.length` to `.count()` for raw specifiers, and `ExistsSpecifier` would need to be added.

---

## Existing `Count` Node Discrepancy (Minor Bug)

The `Count` EventPlan node in `jxaUnit.ts` emits `.length` on a specifier expression:

```typescript
// jxaUnit.ts, line 269
case 'Count': {
  const specExpr = emitSpecifier(ctx, node.specifier);
  ctx.lines.push(`var ${varName} = ${specExpr}.length;`);
  break;
}
```

In JXA, `.length` on a live AE specifier (not a materialised array) returns `undefined`. This code is correct only when `specifier` resolves to a materialised JS array reference (i.e., a `Get` node's result). Since the current lowering path does not produce `Count(specifier)` nodes (SetIR `Count` → EventPlan `RowCount`), this is a latent issue rather than an active bug. If `Count` nodes are ever used with raw specifiers in future, the emission should use `.count()` instead.

---

## Summary for Team Lead

**Feasible?** Technically yes, but not recommended.

**What the JXA would look like:**
```javascript
// count: ~100-150ms
var n = doc.flattenedTasks.whose({flagged: true}).count();

// exists: ~100-150ms
var exists = doc.flattenedTasks.whose({flagged: true}).exists();
```

**Estimated savings:** ~13–63ms over the current ~163ms bulk-id-read path — well within measurement noise, and only applicable to single-property predicates. Task queries require an additional project-count AE call, further reducing net savings.

**Blocking issues:**
- Narrow applicability (single-property whose predicates only)
- Task-entity project-exclusion complication adds a second round-trip
- Savings are marginal relative to the implementation and maintenance cost

**If implemented anyway:**
- Add `CountSpecifier` and `ExistsSpecifier` EventPlan node kinds
- Emit `.count()` and `.exists()` in jxaUnit
- Wire up in `lowerSetIrToEventPlan` for the `Count` case when the inner SetIR is a simple Scan with a single-property filter
- Handle project-exclusion for task entities (either accept the inaccuracy for flagged/other shared vars, or add a subtract-project-count step)
- Fix the existing `Count` node emission from `.length` to `.count()` while there
