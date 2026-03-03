# SetIR Architecture Critique

**Date:** 2026-03-03
**Scope:** `setIr.ts` (node types), `lowerToSetIr.ts` (construction + optimizer), `lowerSetIrToEventPlan.ts` (consumption). Companion architecture critiques exist for EventPlan IR (`eventPlan-architecture-critique.md`, task #69).

---

## 1. Node Type Proliferation

SetIR has 12 node types (13 counting `TagNameTaskIds`):

`Scan | Filter | Intersect | Union | Difference | Enrich | Restriction | Count | Sort | Limit | AddSwitch | Error | TagNameTaskIds`

**What's load-bearing:**

- `Scan`, `Filter`, `Intersect`, `Union` are genuinely distinct and actively optimised (the merge-scan pass targets specific Intersect patterns).
- `Restriction` is distinct from `Intersect`: it embeds FK semantics (`fkColumn`, `arrayFk`) that drive different EventPlan lowering. Keeping it separate is correct.
- `Difference` exists for project exclusion — a single, specific OmniFocus quirk. It lowers identically to SemiJoin with `exclude: true`.
- `Count` / `Limit` / `Sort` are terminal wrappers; they're simple and justified.
- `Enrich` is the per-item enrichment path — semantically distinct from Scan (different execution strategy: byIdentifier rather than bulk read).
- `AddSwitch` is a computed-column derivation node. It duplicates some EventPlan `AddSwitch` semantics.
- `Error` is algebraically useful (enables `Union(Error, R) → R` simplification at optimizer time), but in practice it is only introduced by `lowerPredicate` for an impossible `container('folder', …)` on unsupported entities. It serves its purpose but could equally be replaced by returning `Scan(entity, [])` with a false filter.

**Potentially incidental distinctions:**

- `Difference` could be modelled as `Restriction` with `exclude: true` and `lookupColumn: 'id'` — it is semantically a Difference(left, right) = anti-semijoin. However, keeping a named node makes the tree more readable and avoids overloading `Restriction`'s already complex interface.
- `Intersect` could be modelled as `Restriction` — Intersect(L, R) = Restriction(L, 'id', R). Currently they lower differently: Intersect → SemiJoin(L, ColumnValues(R,'id')), while Restriction → SemiJoin with a custom field. The distinction is load-bearing in the optimizer (merge-scan targets Intersect specifically).

**Verdict:** No obvious pruning opportunities. The count is appropriate. The merge-scan optimizer would need changes if Intersect were collapsed into Restriction.

---

## 2. Missing Abstractions

**2.1 `lowerToSetIr.ts` has no explicit optimizer pass registry.**

`optimizeSetIr` calls three functions in sequence: `applyMergeScanPass`, `tagNameShortcut`, `widenScansToUnion`. These are defined inline in the same file. Adding a new optimizer pass requires knowing to add it here. There's no array of passes, no documentation of pass ordering constraints. This is fine at the current scale (three passes) but would become fragile with five or more.

**2.2 `buildSetIrPlan` in the orchestrator injects the `Difference` for project exclusion — outside `lowerToSetIr`.**

`lowerToSetIr.ts` produces clean SetIR with no project exclusion. `buildSetIrPlan` (orchestrator.ts:451) post-processes the plan to add `Difference(plan, Scan(projects,[id]))`. This means:

- The project-exclusion logic is in orchestrator.ts, not with the lowering logic
- Tests for `lowerToSetIr` pass even if project exclusion is broken (they don't test the full plan)
- `optimizeSetIr` doesn't see or optimise the Difference node

The historical reason is probably ordering: Count/Limit must come after Difference, and `lowerToSetIr` wrapped Count/Limit internally until recently. Now that `buildSetIrPlan` handles terminal wrapping, there's no reason the Difference injection couldn't move into `lowerToSetIr` (or at least a dedicated SetIR pass).

**2.3 No `Subtract` node despite Difference being a genuine set operation.**

`DifferenceNode` is a well-named node, but its usage is exclusively for project exclusion. If a future query needed "tasks not in any project" as a user-visible filter, it would be natural to express it as Difference — but currently the optimizer/lowering has no patterns to handle arbitrary Difference, only the specific `Difference(plan, Scan(projects,[id]))` form.

**2.4 No `Pick` node at SetIR level.**

Output column selection is handled by the EventPlan `Pick` node (appended in `lowerSetIrToEventPlan`). At the SetIR level, the column set is inferred from which variables appear in predicates and select lists. This is correct but means column pruning happens at EventPlan time, not SetIR time. An earlier `Pick`-equivalent at SetIR level could enable earlier pruning of Scan columns before EventPlan construction.

---

## 3. FK-Graph Coupling

`lowerToSetIr.ts` calls `getChildToParentFk(childEntity, entity)` from `aeProps.ts` to resolve `containing()` FK relationships. This is the tightest coupling point in the file:

```typescript
import { getChildToParentFk } from './aeProps.js';
```

**What the coupling buys:** the `containing()` lowering is generic — it walks the FK graph to find the path from child to parent without knowing OmniFocus entity names. The FK metadata is data (in `aeProps.ts`), not logic (in `lowerToSetIr.ts`).

**What it costs:** `lowerToSetIr.ts` can't be used for another application without also providing the FK graph from `aeProps.ts`. The file's comment says "purely structural — no domain knowledge", which is mostly true, but `aeProps.ts` dependency undermines this claim. The `container()` lowering also hardcodes `'project' | 'folder' | 'tag'` container types.

**Is the coupling appropriate?** Yes, for the current single-application context. The alternative — injecting the FK provider via dependency injection — would be a clean seam for multi-application reuse but is premature with one consumer. The coupling is at a well-defined boundary (one import, one function call) and could be extracted when needed.

---

## 4. Restriction Node Design

```typescript
interface RestrictionNode {
  kind: 'Restriction';
  source: SetIrNode;
  fkColumn: string;
  lookup: SetIrNode;
  arrayFk?: boolean;
  lookupColumn?: string;
  flattenLookup?: boolean;
}
```

This is the most complex node in SetIR. The semantics are:

> Keep rows from `source` where `source[fkColumn]` is in `{ row[lookupColumn] | row ∈ lookup }`, with optional array-element semantics on either side.

**Problems:**

- **`lookupColumn` default is implicit.** The default is `'id'`, documented in a comment but not in the type. A reader must check the lowering to discover this. A safer design would make the default explicit (`lookupColumn: string` without `?`, always set by the constructor).

- **`flattenLookup` is a partial type.** The combination `lookupColumn: 'tagIds', flattenLookup: true` means "the lookup column contains nested arrays — flatten them before building the id set". This specific combination exists only for the `containing('tasks', pred)` on tags case. It's not obvious from the type that `flattenLookup` is only meaningful when `lookupColumn` is an array column.

- **`arrayFk` and `flattenLookup` are separate booleans that affect opposite ends of the join.** `arrayFk` means "source's FK column is an array, match any element". `flattenLookup` means "lookup's output column is a nested array, flatten it". These are semantically parallel but named asymmetrically. A reader must read the comments carefully to understand which side each flag applies to.

- **The lowering comment in setIr.ts is the best documentation.** The 40-line comment block documenting `RestrictionNode` usage patterns (default FK semantics, `containing()` semantics, two-hop via `lookupColumn`) is thorough and accurate, but the complexity it's documenting is a smell. Five distinct usage patterns for one node type suggests the type may be doing too much.

**Alternatives considered:**

A cleaner design might split Restriction into two nodes: `SemiJoin(source, fkColumn, lookup)` for the simple FK case and `InverseSemiJoin(source, lookup, fkColumn)` for the `containing()` case. This would eliminate the optional `lookupColumn` and make the direction of the join explicit in the node type. However, it would double the number of optimizer patterns needed.

---

## 5. TagNameTaskIds Special Case

`TagNameTaskIds` is a leaf node that encodes a specific OmniFocus optimization: look up tasks by tag name using `.whose()` on tags followed by traversal to tasks, avoiding the expensive bulk `tagIds` nested-array read.

**Arguments for keeping it:**

- The optimization saves ~200ms on tag-name filter queries
- The node is fully typed and clearly documented
- `lowerTagNameTaskIds` in the lowering pass is a clean 15-line function

**Arguments against keeping it as a named node:**

- It is OmniFocus-specific at the entity level (hardcodes `flattenedTag`, `flattenedTask`, `OFTagProp.name`, `OFElement.flattenedTask` in `lowerSetIrToEventPlan.ts`)
- It is query-pattern-specific (only matches `container('tag', eq(name, literal))`)
- If analogous shortcuts existed for other patterns (e.g., a "project name shortcut" using `.whose()` on flattenedProjects), each would require a new named node

**Is it the right abstraction?**

A more general escape hatch — call it `NativeOperation(script: string)` or `AEWhoseTraversal(fromClass, propCode, match, value, toClass, terminalPropCode)` — would let the optimizer inject native AE operations without needing a new node type per pattern. However, a parameterized traversal node would still be OmniFocus-specific (it would need AE class codes as parameters), and the current `TagNameTaskIds` is at least readable. The trade-off is specificity vs. generality.

**Verdict:** Acceptable for now. If a second OmniFocus-specific shortcut pattern were needed, that would be the right time to introduce a general `NativeAEOperation` node rather than proliferating specific nodes.

---

## 6. Testability

**What works well:**

- `lowerToSetIr` is a pure function (no I/O, no side effects) and is directly testable. The `setIrPipeline.test.ts` file demonstrates this — it tests specific tree shapes and checks that `lowerSetIrToEventPlan` doesn't throw.
- `walkSetIr` enables tree-shape assertions without recursing manually in tests.
- The `Error` node and `mergeSameEntityScans` have defined algebraic identities that can be unit-tested in isolation.

**Friction points:**

- **Tests must import from `dist/`**, not `src/`. The test runner uses Node's built-in test runner against compiled output, so tests lag the source by one `npm run build`. A type error in the source is invisible to the test at runtime. This is a project-wide issue, not specific to SetIR.

- **The tree structure is deep JSON.** Asserting on specific SetIR shapes requires manually destructuring node trees or writing recursive search functions. `setIrPipeline.test.ts` has a handrolled `findScanColumns` function for exactly this reason. A helper like `findNodes(plan, kind)` would reduce boilerplate.

- **`buildSetIrPlan` vs `lowerToSetIr` split.** `buildSetIrPlan` is in the orchestrator; `lowerToSetIr` is in its own file. Tests wanting to check the full plan (including project exclusion) must import from the orchestrator. Tests for just the predicate lowering use `lowerToSetIr`. The split is logical but means there are two entry points to keep in mind.

- **`optimizeSetIr` is not independently tested.** The optimizer passes (mergeSameEntityScans, widenScansToUnion, tagNameShortcut) are tested implicitly through `buildSetIrPlan` → `lowerSetIrToEventPlan` round-trips, not through direct assertions on the SetIR tree post-optimization. If the optimizer introduces a regression (e.g., incorrect column widening), the failure would manifest as an EventPlan error or a runtime failure, not as a failing SetIR assertion.

---

## 7. Extension Difficulty: Adding a New Entity

**Test case: perspectives as a full entity with FK relationships.**

Currently perspectives are a special case: `perspectiveVars` has only `{id, name}`, and there's no perspectives handling in `lowerToSetIr.ts` (perspectives can't appear as the subject of a `containing()` or `container()` relationship).

To add perspectives as a first-class entity with, say, a `taskEntity: EntityType` FK (each perspective is associated with a task entity scope):

1. **`variables.ts`:** Add `perspectiveVars` entries for new properties and FK columns. Straightforward.

2. **`aeProps.ts`:** Add `SIMPLE_PROPS.perspectives`, `CHAIN_PROPS.perspectives` with FK metadata. Add `ENTITY_CLASS_CODE.perspectives`. Straightforward.

3. **`lowerToSetIr.ts`:** Update `ENTITY_TYPES` to include `'perspectives'`. The `containing()` generic FK traversal would then pick up perspectives automatically via `getChildToParentFk`. The `activeFilterForEntity()` switch would need a `'perspectives'` case (or fall through to `null`). Low friction.

4. **`lowerSetIrToEventPlan.ts`:** No changes if the new properties map to standard simple/chain AE props. A new AE traversal pattern would require a new `lowerXxx` function.

5. **Tests:** Would need new entries in the entity integration tests.

**What would break:**

- The `EntityType` union (`'tasks' | 'projects' | 'folders' | 'tags' | 'perspectives'`) is already correct — perspectives is already there. The `getVarRegistry` switch handles it. This is the right place for the union.
- `ENTITY_TYPES` in `lowerToSetIr.ts` is a hardcoded array `['tasks', 'projects', 'folders', 'tags']` — it would need to be updated. This is a maintenance hazard: if someone adds a new entity to `EntityType` without updating this array, the `containing()` two-hop resolution silently fails to consider the new entity. The array should either be derived from `EntityType` or protected by an exhaustiveness check.
- The `container()` lowering in `lowerPredicate` hardcodes `'project' | 'folder' | 'tag'` container types as a TypeScript union. Adding a new container type (e.g., `'perspective'`) would require a code change to this switch. This is acceptable friction — it's a deliberate design choice to enumerate known container types.

**Overall:** Extension is straightforward for new simple-property entities. The main friction points are `ENTITY_TYPES` (not exhaustive-checked) and the `container()` type union (needs code changes for new container types). Neither is a serious problem.

---

## 8. What's Good

- **The comment block on `RestrictionNode` is excellent.** Five concrete usage examples with the SetIR expression for each case. This is the kind of documentation that prevents bugs.
- **`walkSetIr` is correct and complete.** Every case is handled; the bottom-up transformation pattern is idiomatic.
- **Algebraic `Error` node rules are documented and implemented.** `mergeSameEntityScans` handles `Union(Error, R) → R` and `Intersect(Error, R) → Error` correctly.
- **The merge-scan optimizer is clean and well-targeted.** Four specific Intersect patterns are matched and merged; anything else falls through unchanged. The widenScansToUnion pass is a two-phase collect+rewrite, correctly gated by a "needs rewrite" check.
- **SetIR-to-EventPlan lowering is purely structural.** `lowerSetIrToEventPlan.ts` has no domain knowledge — it dispatches on node kind and calls helpers. This makes it easy to verify correctness by inspection.
- **The `tagNameShortcut` optimizer correctly detects the post-merge-scan tree shape.** The comment explains why it expects `Filter(Scan(tags,...), pred)` rather than the pre-merge shape — this is accurate and helpful.

---

## Summary Table

| Area | Verdict | Notes |
|------|---------|-------|
| Node count | Appropriate | 12-13 nodes; all load-bearing except possibly `Error` |
| `Restriction` design | Slightly overloaded | `lookupColumn`/`flattenLookup`/`arrayFk` are correct but semantically dense |
| FK coupling | Acceptable | One import of `getChildToParentFk`; clean seam for future extraction |
| `TagNameTaskIds` | Acceptable now | Would benefit from generalization if a second native AE shortcut is added |
| `ENTITY_TYPES` array | Low-risk hazard | Not exhaustiveness-checked; could silently miss new entities |
| `Difference` injection | Architectural smell | Lives in orchestrator, not in lowering; not visible to optimizer |
| Testability | Good overall | `lowerToSetIr` is pure and testable; optimizer passes lack direct assertions |
| Extension difficulty | Low | FK graph is data-driven; most extension is additive |
