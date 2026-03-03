# EventPlan IR Architecture Critique

Review of the EventPlan IR as of March 2026 (post-ast-normalization branch).

Files reviewed:
- `src/tools/query/eventPlan.ts`
- `src/tools/query/lowerSetIrToEventPlan.ts`
- `src/tools/query/eventPlanCSE.ts`
- `src/tools/query/eventPlanColumnPrune.ts`
- `src/tools/query/eventPlanUtils.ts`
- `src/tools/query/executionUnits/jxaUnit.ts`
- `src/tools/query/executionUnits/nodeUnit.ts`
- `src/tools/query/eventPlanDescriber.ts`
- `src/tools/query/executionUnits/orchestrator.ts`

---

## 1. SSA-style ref tracking: numeric index + results Map

**What it does.** Each node occupies a slot in a flat array; its index (`Ref = number`) is its binding. Passes thread a `Map<Ref, unknown>` for values at runtime; CSE/pruner use a `rename` array + `compact` map for rewriting. Body nodes inside `ForEach` use a parallel index space (body-local integers).

**Right choice?**

Yes, for this codebase. The alternatives were explicit tree edges (every node holds pointers to its inputs) or string names (like LLVM IR `%name`). Numeric indices are cheap, compact, and naturally topologically ordered — the IR is already written in SSA order by the lowering pass. Passes that walk the plan backwards (column pruner) or forward (emitter) are both straightforward with an index.

**Real tradeoffs.**

- **Body-local index collision.** The most serious structural problem in the IR: `ForEach` body uses its own index space (0, 1, 2, ...), and the `ForEach` node's own plan-level index is reused inside the body to mean "current iteration item". This dual meaning of a numeric `Ref` is not type-safe and requires every consumer to maintain an explicit `forEachStack`. The emitter, CSE pass, and pruner all handle this differently (and the pruner handles it only partially — see §8).

- **Specifier refs.** Specifiers can contain `Ref` values embedded in `parent`, `id`, and `name` fields. This means `rewriteSpec`/`collectSpecifierRefs` must walk the specifier tree recursively in addition to the node's direct fields. It works, but it's easy to add a new specifier kind and forget to update the walkers (happened at least once with `ByName`).

- **No type-level separation between value-producing and non-value-producing nodes.** `Get` on a non-Property specifier produces an AE specifier object, not a JS value — but the IR has no way to express this. The emitter distinguishes them via `node.specifier.kind === 'Property'` heuristics. This is fragile (§9).

**Verdict:** the index-based approach is correct. The body-index collision is the one real design debt here; it should have been a scoped ref type (`BodyRef`) or the ForEach body should have been hoisted into the plan with a special scoping annotation.

---

## 2. Runtime annotation (`'jxa' | 'node'`)

**Is the split clean?**

Mostly. The mapping in `defaultRuntime` (eventPlanUtils.ts:17) is stable: `Get`, `Count`, `Set`, `Command`, `ForEach` are always JXA; everything else is always Node. There are no hybrid cases. The `proposed` / `fixed` distinction in `RuntimeAllocation` provides an escape hatch for lowering-pass hints, though in practice nothing currently uses `proposed` in a way that differs from the default.

**Fragile cases.**

- **Zip inside ForEach body.** The outer `ForEach` node is JXA, and `Zip` inside its body is also emitted by `jxaUnit` (`emitBodyNode`). But `Zip` globally defaults to `node` runtime. This works only because body nodes are never assigned to the plan's main node array — they live inside `ForEach.body`, outside the targeting machinery. There's no assertion that prevents a Zip from accidentally ending up in the wrong context.

- **ColumnValues as ForEach source.** `ForEach.source` is a plan-level Ref expected to resolve to a flat JS array. In practice this is always a `ColumnValues` result (Node-side). If someone emits a ForEach whose source is a JXA Get (which produces an AE specifier), the emitter would try to iterate over an AE specifier object in a JS for-loop, producing opaque or zero-length results. There's no validation preventing this.

- **No cross-unit specifier serialisation for `ByName`.** The `specifier` input kind (for passing AE specifier references across execution unit boundaries) is handled for `ByID` cases in the cross-EU lowering, but `ByName` with a Ref in `name` is a parallel case that likely works by construction, though the code path is less exercised.

---

## 3. Node type count and factoring

There are **19 distinct `EventNode` kinds** (counting `AddSwitch` and `SetOp` added recently):
Get, Count, Set, Command, ForEach, Zip, ColumnValues, Flatten, Filter, SemiJoin, HashJoin, Sort, Limit, Pick, Derive, Union, RowCount, SetOp, AddSwitch.

**Well-factored or bloated?**

Mostly well-factored. Each node maps cleanly to one runtime and does one thing. A few observations:

- `Derive` and `AddSwitch` overlap conceptually (both add computed columns to rows). `Derive` does it via hardcoded derivers registered in `variables.ts`; `AddSwitch` does it via inline predicate expressions. They could be unified — `Derive` is just `AddSwitch` with the cases pre-compiled. Keeping them separate is defensible for performance (pre-compiled derivers skip the `compileNodePredicate` overhead at runtime) but the split adds two separate code paths in every pass.

- `RowCount` is a terminal node that produces a scalar. Every other node produces either a row array (`Row[]`), a flat value array, or an AE specifier. `RowCount` breaking this pattern means `execRowCount` has a different return type that consumers must account for.

- `Flatten` is a one-liner (`[].concat(...source)`). Its existence as a named node kind (rather than an inline transform in `ColumnValues`) adds boilerplate in every switch statement for minimal benefit. It appears only in the tag-restriction path.

- `Pick` and `ColumnValues` are both "project a column subset" — `Pick` for row objects, `ColumnValues` for a single column as a flat array. The distinction is necessary and correct.

- **Missing: Distinct / dedup.** `Union` deduplicates by id. `execUnion` is the only place where dedup happens. There's no node for deduplicating a single source that might have duplicates — currently handled implicitly (the planner ensures inputs are already deduped).

---

## 4. Zip node design

**What it does.** Takes N parallel arrays (each a `Ref`) and zips them into a `Row[]` where each row is `{ col1: arr1[i], col2: arr2[i], ... }`. This is the core alignment mechanism: the entire "bulk read N properties from M elements" pattern maps to N `Get(Property)` calls each returning an array of length M, then a single Zip to assemble rows.

**Sound?**

Yes. The semantics are simple and correct when the precondition holds (all arrays have the same length). The precondition holds because all arrays are bulk reads off the same AE element set — Apple Events guarantees alignment.

**Edge cases.**

- **Empty columns.** `execZip` returns `[]` when `node.columns.length === 0`. The column pruner may produce a zero-column Zip if all columns are pruned (though `RowCount` protects against this for its own source by requiring at least `id`). A zero-column Zip logically represents a count of the element set without reading anything — it's weird but harmless since the downstream `RowCount` only calls `.length`.

- **Column order is significant but not enforced.** Zip columns are keyed by name, so order doesn't matter at the row level. But the CSE pass keys Zip nodes with a *sorted* column list (`map(...).sort()`), while the node itself stores columns in insertion order. This means two Zip nodes with the same columns in different order are correctly identified as duplicates by CSE. Good.

- **Column subset semantics.** After column pruning, a Zip may have fewer columns than it did at construction. Downstream nodes that filter on columns not in the Zip will fail at runtime (predicate compilation or row access will see `undefined`). The pruner is supposed to ensure no needed column is pruned, but bugs in the backward-propagation logic (§8) could cause this silently.

- **ForEach body Zip.** The body Zip has body-local Refs in its `columns[*].ref` fields. These refer to body nodes, not plan-level nodes. The outer emitter (`emitBodyNode`) handles this correctly by setting `ctx.vars.set(i, bodyVarName)` for body-local indices. The pruner also handles this specially. But neither the type system nor any validation enforces that body Zip refs are body-local — a bug could easily introduce a plan-level ref inside a body Zip.

---

## 5. ForEach node

**What it does.** Iterates over a source flat array (typically IDs), runs body nodes for each item (typically AE by-id lookups), and collects the result of `body[collect]` across iterations into a flat output array via `[].concat.apply([], acc)`.

**Earning its keep?**

It solves a real problem: enriching a small filtered row set with expensive per-item AE round-trips (the `Enrich` SetIR node maps to ForEach). Without it, expensive properties (note text, etc.) would require either a full bulk scan of all notes or an OmniJS byIdentifier path. For the 50+ item threshold where byIdentifier becomes slower than bulk, ForEach is the right tool.

**But the complexity is real.**

- Every pass (CSE, pruner, emitter, describer, `collectRefs`, `rewriteNode`, `defaultRuntime`) has a special case for `ForEach`. The body index space adds non-local reasoning to every pass author.
- The emitter's `emitBodyNode` only handles `Get`, `Count`, and `Zip`. Adding any other body node kind requires extending both `emitBodyNode` and `emitForEach`. There's no structural guarantee that the body only contains those kinds.
- The `rewriteNode` for `ForEach` (eventPlanUtils.ts:160) passes `remap` into the body nodes. This is correct only if the remap function is identity for body-local refs, which it is for plan-level compaction maps — but a future pass that rebases body-local indices could break this silently.

**Verdict:** ForEach earns its keep for the enrichment use case, but the body-index design debt from §1 makes it the highest-maintenance node in the IR. If there were ever a second use of ForEach beyond Enrich, I'd push hard for a proper scoped index design.

---

## 6. SetOp node

**What it does.** Computes set intersection or set difference on `string[]` / `Set<string>` id arrays. Produced by `mergeSemiJoins` optimization to combine multiple SemiJoins on the same source into a single id-set operation.

**Consistent with the rest of the IR?**

Mostly, but with some friction points:

- `SetOp` operates on id arrays, not row arrays. This is a different data type from most other node outputs. The column pruner correctly propagates `null` (no column constraints) through `SetOp` (pruner:216), but the comment there ("SetOp operates on id arrays, not row columns — propagate null") reveals that the pruner's column-needs model doesn't quite apply to SetOp inputs.

- `execSetOp` returns a `Set<string>`, not a `Row[]`. This is intentional — the result is consumed by downstream `SemiJoin.ids`, which accepts both `Set<string>` and `string[]`. But the IR's type is `unknown` everywhere, so there's no static check that SetOp output only appears in a SemiJoin's `ids` slot. A SetOp result in a `source` slot would produce confusing downstream behavior.

- The CSE pass does not include `SetOp` in eligible node kinds (`nodeKey` returns null for it). This is probably correct — SetOp is typically unique per query — but it means that if the same two tag id sets were intersected twice (which the current optimizer shouldn't produce), it would be computed twice.

**Verdict:** SetOp is coherent and correct as implemented. Its main risk is type-level: nothing prevents its output from being used in a non-id-consuming slot. This is a latent hazard if the optimizer ever becomes more aggressive.

---

## 7. CSE pass

**What it does.** Unifies structurally identical Get, Zip, and ColumnValues nodes. Runs before column pruning (so CSE sees more candidates before pruning narrows Zips).

**Correct for all node kinds?**

Yes for the three eligible kinds:
- `Get`: keyed on specifier structure + canonical parent refs. Sound.
- `Zip`: keyed on sorted `(name, canonical ref)` pairs. The sort handles column-order variation. Sound.
- `ColumnValues`: keyed on `(canonical source ref, field name)`. Sound.

**Cases where CSE could incorrectly deduplicate.**

- **Effectful Gets.** The CSE pass does not check `node.effect`. A `Get` with a `sideEffective` effect would be deduplicated with a structurally identical pure `Get`. In practice, all reads in the current codebase are `nonMutating`, and `sideEffective` Gets don't exist yet. But the filter should be `node.effect === 'nonMutating'` to be safe.

- **ForEach body nodes.** CSE does not look inside ForEach bodies (body nodes are not in the plan's main array). This is correct for plan-level nodes, but it means duplicate Gets inside different ForEach bodies are not eliminated. Minor, since ForEach bodies are typically short (3-4 nodes) and unique per query.

**Cases where CSE could miss an opportunity.**

- Filter, SemiJoin, HashJoin, Sort, Limit, etc. are not eligible for CSE. These are correctly excluded (they have state or semantic nuance). The three eligible kinds are exactly the right ones.

**Verdict:** CSE is correct and conservative. The only genuine bug risk is the missing `effect` check on Get nodes.

---

## 8. Column pruner

**Backward propagation correctness.**

The pruner walks the plan backwards, computing the set of column names needed at each node, then prunes Zip columns not in that set.

**Correct propagation cases:**

- `Pick`: propagates `fields` set — correct. This is the primary driver of pruning.
- `Filter`: unions predicate vars into downstream needs — correct.
- `Sort`: adds `by` column — correct.
- `SemiJoin`: adds join field (`field ?? 'id'`) — correct. Also propagates null to `ids` (no column semantics there).
- `HashJoin`: removes fields added by the join from source needs (they come from lookup), adds `sourceKey` — correct. Adds `lookupKey` + fieldMap keys to lookup needs — correct.
- `Derive`: if derived var is needed, adds its dependency columns — correct.
- `ColumnValues`: propagates `{field}` to source — correct.
- `Flatten`: passes through — correct.
- `AddSwitch`: removes `column` from source needs (AddSwitch provides it), adds predicate vars from cases — correct.
- `Union`: adds `id` to both sides (needed for dedup) — correct.
- `RowCount`: propagates `{'id'}` to source (to keep Zip producing non-empty rows for count) — correct but slightly arbitrary. The real constraint is that Zip must produce an array with the correct length; any single column would do, not necessarily `id`.
- `SetOp`: propagates null (no column constraints on id arrays) — correct.

**ForEach body pruning.**

This is the most complex section and has a subtle gap. The pruner propagates `myNeeded` to the body Zip (pruner:227-231), then compacts the body based on body-local reachability. However:

- The pruner does not recurse into the body nodes' specifier trees when computing body reachability — it only walks specifier refs shallowly via `collectBodySpecRefs`. If a body Get has a chain specifier (Property of Property), only the outer Property's parent is checked for body-local refs, not the inner Property's parent. In the current codebase, body Gets always reference `byIdRef` (body index 0) as the specifier root, so the outer specifier always points to body index 0. This works. But a more complex body (e.g., a chain Get that references body[2]) could be incorrectly pruned.

- The `rewriteNode` call for ForEach body nodes (pruner:375) passes the body-local remap function. But `rewriteNode` for ForEach (eventPlanUtils.ts:164) recurses into `node.body.map(n => rewriteNode(n, remap))`. If this path is ever hit for a ForEach that appears as a *body node of another ForEach*, the remap function would be wrong. This doesn't happen today (no nested ForEach), but it's a latent hazard.

**Nodes not covered.**

- `Zip`, `Get`, `Count`, `Set`, `Command` are listed as terminals in `computeNeededColumns` and don't propagate further. `Get` and `Count` don't have row column semantics so this is correct.

**Verdict:** Pruning is correct for all current use cases. The ForEach body section is the most fragile, and the shallow specifier walk in `collectBodySpecRefs` is the likeliest future bug site if body structure becomes more complex.

---

## 9. Emission correctness

### jxaUnit

**The Property / non-Property distinction.** `emitNode` for `Get` uses `node.specifier.kind === 'Property'` to decide whether to call `()` on the specifier. Non-Property Gets (Elements, ByID, ByName) produce AE specifier objects; calling `()` on them would materialize as JS arrays and break downstream bulk reads. This is semantically correct but implicit — nothing in the IR encodes whether a Get's value is "an AE specifier" or "a JS array of values". This is the same structural gap noted in §1.

**Chain accessor split in `emitParent`.** When a Property specifier is used as the parent of another Property (chained read), `emitParent` strips the chain accessor to just the base portion (e.g., `tags.name` → `tags`). This prevents `elements.tags.name.id()` (wrong) and produces `elements.tags.id()` (correct). The logic (`chain.accessor.split('.')[0]`) is correct for the current single-depth chains but would silently produce wrong output for a three-level chain like `a.b.c`.

**PROP_VALUE_TRANSFORMS for body nodes.** `emitBodyNode` for Get applies transforms (e.g., date ISO conversion). But it does NOT apply the chain suppression logic that the outer `emitNode` applies (`suppressTransform` check at jxaUnit.ts:255). In the current codebase, body Gets use simple `propCode` lookups (no chain parent), so no transform suppression is needed. If a body ever reads a chained property, transforms might be wrongly applied.

**Whose injection safety.** The Whose specifier value is escaped with a simple string replace (`spec.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")`). This handles backslash and single-quote but not other JS special characters (newlines, null bytes, Unicode edge cases). For tag names coming from user input, this could be an injection surface, though the current callers only produce simple ASCII tag names.

**Multi-export key collision.** Multi-export results are keyed by `String(ref)` (jxaUnit.ts:449). If ref numbers were somehow non-unique (which the SSA invariant prevents), keys would collide silently. Not a real risk given the current design, but the code deserves a comment.

### nodeUnit

**`inferEntity` fallback.** When `execFilter` or `execAddSwitch` needs an entity type for predicate compilation and the node doesn't carry `entity`, it walks the source chain looking for a `Derive` node. If it doesn't find one, it returns `'tasks'`. This is an incorrect fallback for project, folder, or tag queries without a `Derive` node. The current codebase injects `entity` on all `Filter` and `AddSwitch` nodes at lowering time, so this fallback is never triggered — but it's a silent correctness hazard for future callers.

**`execHashJoin` mutates source rows.** `execHashJoin` adds fields directly to source row objects (`row[outputField] = ...`). This is a well-known trade-off (avoids allocation) but means that if a source row is shared with another reference (e.g., if CSE routes two HashJoins to the same source), the second HashJoin would see mutations from the first. The current plan structure prevents aliased source refs, but it's not enforced.

**`execSetOp` returns `Set<string>`.** The Node dispatcher (`execNode`) returns `unknown`, so type information is lost. A downstream `execSemiJoin` converts the Set correctly via `idsRaw instanceof Set`. The `instanceof` check is correct. But the serialization path (if this value ever ended up being JSON.stringify'd by a JXA unit) would produce `{}` (empty object) since `Set` is not JSON-serializable. No current plan structure allows this, but it's a latent bug.

**Filter+Limit fusion detection.** `detectFilterLimitFusion` counts consumers per ref within the unit. The count includes all Refs referenced by any node in the unit. If a Filter's output ref is also used by a SemiJoin in the same unit (unusual but possible), the consumer count would be >1 and fusion would correctly be suppressed. This is correct.

---

## 10. Overall verdict

**Strongest part of the design.**

The two-phase structure — runtime-agnostic EventPlan IR, then `assignRuntimes` + `splitExecutionUnits` targeting — is the right separation of concerns. The IR itself is expressive enough to represent every query pattern that has come up, the passes are compositional and can be applied in any order, and the describer produces genuinely readable output for debugging. The CSE and column-pruning passes are both correct and well-tested. The JXA fusion in the orchestrator is elegant and the `fuseSchedule` wave-based approach is simple and correct.

**What I'd change if starting fresh.**

Three things, in order of importance:

1. **ForEach body index space.** The dual meaning of a `Ref` (plan-level index vs body-local index, with the ForEach's own index meaning "current item" inside the body) is the deepest design debt. I'd introduce a discriminated union: `type Ref = { kind: 'plan'; idx: number } | { kind: 'body'; idx: number } | { kind: 'loopVar' }`. This eliminates the ForEach stack, makes body refs type-safe, and prevents every pass author from having to reason about index spaces.

2. **Distinguish specifier-valued Gets from value-producing Gets.** Currently, `Get(Elements(...))` and `Get(ByID(...))` return AE specifier objects that must not have `()` called on them, while `Get(Property(...))` must. This distinction is encoded only in the emitter's `specifier.kind` check. A cleaner design would split this into two node types: `AESpecifier` (produces an opaque AE reference) and `AERead` (calls `()` to materialize a value). This would let the type system catch any pass that incorrectly mixes the two.

3. **`inferEntity` fallback removal.** The fallback to `'tasks'` in `nodeUnit.inferEntity` is wrong for non-task entities and will silently produce incorrect predicate behavior when triggered. Since lowering already injects `entity` on all relevant nodes, just remove the fallback and throw.

**Minor things worth noting but not blocking.**

- `Flatten` as a node kind is excessive for a one-liner. It adds boilerplate to every switch without meaningful abstraction. Could be eliminated by making `ColumnValues` optionally flatten its output.
- `Derive` and `AddSwitch` are close cousins. If `AddSwitch` proves stable and general enough, `Derive` could eventually be expressed as a special case of it.
- The `proposed` / `fixed` runtime distinction in `RuntimeAllocation` is unused in practice. All nodes get `fixed` runtimes at targeting time. This is fine — the distinction was added for a future optimization that never arrived.
