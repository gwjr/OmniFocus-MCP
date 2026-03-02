# Apple Events Cost Model for OmniFocus

**Date:** 2 March 2026
**Database:** 2,137 tasks, 366 projects, 31 tags, 33 folders
**Method:** Each measurement repeated 3 times (median reported) for the main benchmark, 5 times (alternating JXA/AS) for the chain property head-to-head. JXA via `osascript -l JavaScript`, AppleScript via `osascript`, both using temp files. All scripts connect to OmniFocus, get `defaultDocument`, then perform the measured operation.

---

## 1. Process Startup

| Step | JXA | AppleScript |
|------|----:|------------:|
| Bare interpreter (no app) | 17ms | 26ms |
| + `Application("OmniFocus")` | 19ms | 28ms |
| + `defaultDocument` | 25ms | 26ms |

JXA's JavaScriptCore interpreter starts ~9ms faster than AppleScript's, but the difference disappears once you're connected to an application. Connecting to OmniFocus adds ~2ms; resolving `defaultDocument` adds another ~6ms in JXA (negligible in AS — likely deferred resolution).

**Implication:** Process startup is cheap. The real cost is the first Apple Events round-trip to the application, not the interpreter.

---

## 2. Collection Access Floor

| Collection | JXA `.length` | AS `count of` |
|------------|-------------:|-------------:|
| flattenedTasks (2,137) | 122ms | 108ms |
| flattenedProjects (366) | 100ms | 112ms |
| flattenedTags (31) | 108ms | 104ms |
| flattenedFolders (33) | 110ms | 97ms |

Merely obtaining a reference to a flattened collection and reading its count costs **~100–120ms regardless of collection size**. A 2,137-item collection costs the same as a 31-item collection. This is the Apple Events IPC floor: the fixed cost of constructing the object specifier, sending it across the Mach port, having OmniFocus resolve it, and returning the result.

**Implication:** Every Apple Events round-trip pays at least ~100ms. This floor dominates the cost model. The number of round-trips matters far more than the amount of data in any single round-trip.

---

## 3. Bulk Property Reads

### 3.1 Tasks (2,137 items)

The fundamental operation: `doc.flattenedTasks.propertyName()` returns an array of 2,137 values in a single Apple Events call.

| Property | Median | Category |
|----------|-------:|----------|
| name | 142ms | scalar |
| id | 163ms | scalar |
| flagged | 158ms | scalar |
| completed | 144ms | scalar |
| dropped | 157ms | scalar |
| dueDate | 145ms | date |
| deferDate | 136ms | date |
| completionDate | 170ms | date |
| modificationDate | 157ms | date |
| estimatedMinutes | 142ms | scalar |
| blocked | 164ms | computed |
| effectivelyCompleted | 195ms | computed |
| effectivelyDropped | 725ms* | computed |

*effectivelyDropped showed high variance (173ms–1,225ms); the 725ms median may include GC or cache effects.

**Simple scalar and date properties** (name, flagged, dueDate, etc.) cost **130–170ms** — barely above the collection access floor. The per-item serialisation cost for 2,137 items is roughly 30–70ms on top of the ~100ms floor.

**Computed boolean properties** (blocked, effectivelyCompleted) are slightly more expensive at **164–195ms**. OmniFocus must evaluate each item's state graph rather than reading a stored value.

#### Chain properties (containingProject)

The initial 3-run benchmark suggested large differences between chain property variants (160ms for `.name()` vs 531ms for `.id()` vs 1,182ms for raw refs). A follow-up head-to-head test with 5 alternating runs per language told a different story:

| Operation | JXA | AS | Notes |
|-----------|----:|---:|-------|
| containingProject.id() | 237ms | 194ms | JXA runs: 389, 189, 255, 159, 237 |
| containingProject.name() | 396ms | 340ms | JXA runs: 163, 225, 396, 571, 436 |
| containingProject() (raw refs) | 380ms | 383ms | JXA runs: 380, 299, 372, 398, 532 |
| flattenedTasks.id() (baseline) | 234ms | 261ms | JXA runs: 193, 287, 236, 168, 234 |

(Script Debugger independently confirmed `id of containing project of every flattened task` at 35–89ms in a persistent connection, consistent with the ~100ms IPC floor accounting for most of the osascript overhead.)

The key findings:

**All chain variants cost ~200–400ms** — roughly 1.5–2.5× a direct scalar read (~160ms). The chain adds ~100ms of overhead for the intermediate relationship traversal, but there is no dramatic cost cliff between `.id()`, `.name()`, and raw refs.

**Variance is high.** Individual runs of `containingProject.name()` ranged from 163ms to 571ms within the same 5-run sequence. This variance — roughly 3× between best and worst — is characteristic of chain property reads and likely reflects OmniFocus's internal caching behaviour: the first traversal of the task→project relationship may populate a cache that subsequent reads benefit from, but the cache may be evicted between osascript invocations. The initial benchmark's apparent anomalies (531ms for `.id()`, 1,182ms for raw refs) were most likely unlucky draws from this high-variance distribution, possibly compounded by concurrent OmniFocus access from another process.

**JXA and AS are equivalent for chains.** The ~1.2× JXA overhead is within noise margins and reverses for the baseline (`flattenedTasks.id()`). There is no JXA bridge penalty for chain property resolution.

**Implication for the query engine:** Chain properties are moderately more expensive than direct properties (~250–400ms vs ~140–170ms for 2,137 tasks), but the cost is predictable and bounded. The planner should treat chain variables as slightly more expensive than direct variables, but not in a different cost tier. The variance means chain reads may occasionally spike to ~500ms, which is worth noting but does not change the overall strategy: a chain read is always cheaper than the alternative of materialising specifiers and doing per-item lookups.

### 3.2 Projects (366 items)

| Property | Median |
|----------|-------:|
| name | 139ms |
| id | 245ms* |
| status | 104ms |
| flagged | 100ms |
| completed | 149ms |
| dueDate | 248ms* |
| deferDate | 132ms |
| completionDate | 113ms |
| estimatedMinutes | 116ms |
| sequential | 112ms |
| numberOfTasks | 99ms |
| numberOfAvailableTasks | 113ms |
| container() (ref) | 111ms |
| container.id() | 120ms |

Most project properties cost **100–140ms** — near the collection access floor, because 366 items add negligible serialisation overhead to the ~100ms IPC cost.

`numberOfTasks` and `numberOfAvailableTasks` (99ms, 113ms) are surprisingly cheap — OmniFocus appears to cache these aggregates rather than computing them on demand.

`container.id()` for projects (120ms) is comparable to direct scalar reads. The folder→project containment relationship is simpler than the task→project relationship (see §3.1 chain property discussion).

*id and dueDate showed high variance in this run, likely noise.

### 3.3 Tags (31 items)

| Property | Median |
|----------|-------:|
| name | 98ms |
| id | 102ms |
| allowsNextAction | 94ms |
| hidden | 100ms |
| effectivelyHidden | 97ms |
| container() (ref) | 96ms |
| container.id() | 103ms |

All tag properties cost **94–103ms** — indistinguishable from the collection access floor. With only 31 items, serialisation cost is zero. Even `container()` as an object specifier is cheap because it's only 31 specifiers.

### 3.4 Folders (33 items)

| Property | Median |
|----------|-------:|
| name | 98ms |
| id | 92ms |
| container.id() | 88ms |

Same story as tags — everything is at the floor.

---

## 4. Multi-Property Reads

### 4.1 JXA scaling (1–12 properties)

Reading multiple properties from the same collection in a single JXA osascript invocation:

| Properties | Median | Incremental | Marginal per prop |
|-----------:|-------:|------------:|------------------:|
| 1 | 164ms | — | — |
| 2 | 224ms | +60ms | 60ms |
| 3 | 237ms | +13ms | 13ms |
| 5 | 386ms | +149ms | 75ms |
| 8 | 498ms | +112ms | 37ms |
| 12 | 749ms | +251ms | 63ms |

The first property read in a script pays the full ~160ms (floor + collection resolution + one property). Each additional property read adds roughly **50–60ms** on average, because the collection specifier is already resolved and cached within the process — only the per-property Apple Events call and serialisation remain.

Reading 12 properties in one script costs **749ms**. Reading them as 12 separate osascript invocations would cost approximately 12 × 160ms = **1,920ms** — 2.6× more expensive. The savings come entirely from amortising the ~100ms IPC floor across multiple property reads.

**Implication:** Always batch property reads into a single script. The marginal cost of an additional property within an existing script (~55ms) is roughly half the cost of a fresh round-trip (~160ms).

### 4.2 The JXA bridge tax: JXA vs AppleScript at high property counts

At low property counts (1–5), JXA and AppleScript perform similarly — the IPC floor dominates and per-statement overhead is invisible. A head-to-head comparison at 18 properties (10 runs each, alternating JXA/AS/pre-compiled-AS) revealed a dramatic divergence:

| Language | Median | vs JXA |
|----------|-------:|-------:|
| JXA | 13,982ms | — |
| AppleScript (source) | 5,158ms | 2.7× faster |
| AppleScript (pre-compiled .scpt) | 3,443ms | 4.1× faster |

(The 18 properties: name, id, flagged, completed, dropped, dueDate, deferDate, completionDate, modificationDate, creationDate, estimatedMinutes, blocked, effectivelyCompleted, effectivelyDropped, sequential, inInbox, next, repetitionRule.)

Variance remained high across all three (individual JXA runs ranged from 1,172ms to 26,995ms), but the medians are separated by enough that the pattern is clear.

**The JXA bridge has significant per-statement overhead.** Each `items.property()` call in JXA goes through the JavaScriptCore-to-Apple-Events bridge, which must construct an object specifier, dispatch it, and unmarshall the result back to a JavaScript array. AppleScript's compiled bytecode dispatches Apple Events more directly — it operates natively on Apple Event descriptors without the JS↔AE marshalling layer.

At 1–5 properties the bridge overhead is masked by the ~100ms IPC floor. At 18 properties it accumulates to ~9 seconds of overhead (14s − 5s). The implied per-statement bridge tax is roughly **500ms per property read at this scale** — far more than the ~55ms marginal cost measured at lower property counts. This suggests the bridge overhead is not purely per-statement but may interact with memory pressure or GC as the number of large arrays in the JS heap increases.

**Compilation saves ~1.7 seconds** at 18 statements (AS source 5,158ms vs pre-compiled .scpt 3,443ms). This is a fixed cost per script — `osacompile` parses and compiles the AppleScript source into bytecode once, and `osascript` runs the pre-compiled bytecode directly.

**The crossover point is somewhere around 8–12 properties.** Below that, JXA and AS are equivalent. Above that, AS pulls ahead decisively, and pre-compiled AS pulls further ahead still.

**Implications for the query engine:**

1. **For scripts reading many properties (the common BulkScan path), AppleScript is substantially faster than JXA.** The current JXA-based bulk read implementation pays an increasing bridge tax as more properties are requested.

2. **Pre-compilation is worth considering for hot paths.** The 1.7s compilation overhead is a fixed cost that could be paid once at server startup or on first use, then amortised across all subsequent queries. For a BulkScan reading 12+ properties, this saves multiple seconds per query.

3. **The JXA bridge remains fine for small scripts** — startup, relationship traversal, tag lookups, and any script touching fewer than ~8 properties. The bridge tax only becomes material when dispatching many Apple Events calls within a single script.

---

## 5. Per-Item Lookups (`.whose()`)

| Operation | Median | Per-lookup |
|-----------|-------:|----------:|
| `.whose({id: x})` × 1 | 154ms | 154ms |
| `.whose({id: x})` × 5 (loop) | 379ms | 76ms |
| `.whose({id: x})` × 10 (loop) | 742ms | 74ms |
| `.whose({name: x})` on tasks | 159ms | — |
| `.whose({name: x})` on tags | 138ms | — |
| `.whose({name: x})` on projects | 125ms | — |

A single `.whose()` call costs **~150ms** — approximately the same as reading an entire property array from the full 2,137-task collection. The `.whose()` predicate is evaluated server-side by OmniFocus, which must iterate the entire collection to find matches. For a keyed lookup by `id`, this is a linear scan (OmniFocus does not appear to maintain a hash index on IDs for Apple Events queries).

In a loop, subsequent `.whose()` calls amortise slightly (74–76ms each after the first), probably because the collection specifier remains resolved. But 10 lookups still cost **742ms** with high variance (one run hit 2,402ms), compared to **163ms** to bulk-read all 2,137 IDs.

**The `.whose()` predicate by name** on tasks (159ms) is comparable to by-id (154ms). On smaller collections (tags at 138ms, projects at 125ms), it's slightly cheaper — less data to scan — but still at or above the floor.

**Implication:** `.whose()` should never be used for filtering. Bulk-read the entire collection and filter in Node. The crossover point is clear: one `.whose()` call costs the same as one bulk-read, so even a single filter condition is better served by bulk-read + local filtering.

The only justified use of `.whose()` is **targeted lookup of a known entity by name** — e.g., finding a specific tag or project before traversing a relationship. Even then, it's a ~130ms hit.

---

## 6. Relationship Traversal

| Traversal | Median | Notes |
|-----------|-------:|-------|
| tag("paused") → .tasks.id() | 140ms | 2 task IDs returned |
| project("One-offs") → .flattenedTasks.id() | 173ms | 129 task IDs returned |

Traversing a relationship from a specific entity to its children is cheap: the `.whose({name:})` to find the source entity and the `.id()` read on the children are bundled into one script at the cost of a single round-trip.

Returning 129 IDs (173ms) costs barely more than returning 2 IDs (140ms). The serialisation cost for an array of strings is negligible compared to the IPC floor.

**Implication:** The current MembershipScan implementation (`.whose({name:}) → .tasks.id()` or `.flattenedTasks.id()`) is close to optimal. The entire operation — source lookup + relationship traversal + ID extraction — completes in one round-trip for ~140–170ms.

---

## 7. Note Reads

| Entity | Median | Per-item |
|--------|-------:|---------:|
| Tasks (2,137) | 16,281ms | 7.6ms |
| Projects (366) | 1,777ms | 4.9ms |

Task notes are **~100× more expensive** than scalar properties. Project notes are **~15× more expensive**.

Notes in OmniFocus are stored as rich text. Each note must be serialised from the internal RTF-like representation to a plain-text string for Apple Events delivery. The 16.3 seconds for task notes — with high variance (5.8s to 17.8s) — suggests this serialisation may involve disk I/O for notes that aren't in memory, plus potential RTF→text stripping overhead.

The per-item cost (~7.6ms for tasks, ~4.9ms for projects) is dramatically higher than for scalar properties (<0.1ms per item). Notes are in a fundamentally different performance class.

**Implication:** The query engine's policy of classifying `note` as "expensive" and restricting it to `select`-only (never `where`) is strongly validated. Even reading notes in `select` should be considered carefully for large result sets — a query returning 500 tasks with notes will spend ~4 seconds just on note reads.

---

## 8. OmniJS `byIdentifier()` vs JXA Bulk Read

A different access pattern: given a set of known task IDs (e.g., from a SemiJoin or MembershipScan), is it faster to look up each item individually via OmniJS's `Task.byIdentifier()`, or to bulk-read the entire collection via JXA Apple Events and filter in-script?

OmniJS `byIdentifier()` runs inside OmniFocus's JavaScript environment (via `app.evaluateJavascript()`), accessing objects directly without Apple Events serialisation. This avoids the IPC overhead per property but must be called once per item. The JXA bulk path reads 5 property arrays from all 2,137 tasks in parallel, then filters to the wanted IDs — a fixed cost regardless of how many IDs are wanted.

5 runs each, alternating, reading 5 properties per item (name, id, flagged, dueDate, deferDate):

| IDs wanted | OmniJS byId | JXA bulk | Winner | Per-ID (OmniJS) |
|-----------:|------------:|---------:|--------|----------------:|
| 1 | 123ms | 197ms | OmniJS 1.6× | 123ms |
| 5 | 126ms | 186ms | OmniJS 1.5× | 25ms |
| 10 | 218ms | 414ms | OmniJS 1.9× | 22ms |
| 50 | 372ms | 428ms | OmniJS 1.2× | 7ms |
| 100 | 497ms | 425ms | JXA bulk 1.2× | 5ms |
| 500 | 3,741ms | 707ms | JXA bulk 5.3× | 7ms |

**The crossover is around 50–100 IDs.** Below 50, `byIdentifier()` wins because it avoids reading the entire collection — the per-item cost (~7–25ms depending on count) is less than the bulk read's fixed cost (~400ms for 5 properties). Above 100, the per-item cost accumulates and the bulk read wins decisively.

The `byIdentifier()` per-item cost is not constant: it starts at ~123ms for a single item (dominated by the `evaluateJavascript()` call overhead) and drops to ~5–7ms per item at scale as the fixed overhead amortises. But at 500 items the total reaches 3.7s with high variance (2.3s–15.9s), while the JXA bulk path stays stable at ~700ms. OmniJS scaling is unpredictable at volume.

**Implications for the query engine:**

1. **Small enrichment sets (<50 items):** After a SemiJoin or MembershipScan narrows results to a small ID set, `byIdentifier()` is the right enrichment path. It's faster than a full bulk read and avoids reading data for 2,000+ irrelevant items.

2. **Large result sets (>100 items):** Bulk-read + filter remains better. The fixed cost of reading the entire collection is amortised across the result set, and the JXA path has much lower variance.

3. **The crossover at ~50–100 IDs is specific to 5 properties.** With more properties, the JXA bulk-read cost increases (see §4.2 on the JXA bridge tax), which would push the crossover higher — `byIdentifier()` might win up to ~200 IDs when reading 12+ properties.

4. **This creates a two-path enrichment strategy:** the planner can estimate result set size (from the SemiJoin cardinality or a `limit` clause) and choose `byIdentifier()` for small sets vs bulk-read for large ones.

5. **Bridge serialisation matters for larger result sets.** The benchmark returns results as a JSON array of objects (`[{name, id, flagged, ...}]`), which repeats property keys for every item. Moving data across the `evaluateJavascript()` bridge can be surprisingly slow — the JXA↔OmniJS boundary involves string serialisation in both directions. For the `byIdentifier()` path, returning an array of arrays (positional columns, no keys) would reduce the payload size and deserialisation cost. At 500 items × 5 properties, the object-keyed JSON is roughly 2× the size of the positional form. This overhead is folded into the measurements above and may account for some of the non-linear scaling at high item counts.

---

## 9. JXA vs AppleScript

### At low property counts: equivalent

| Operation | JXA | AS |
|-----------|----:|---:|
| 3 task props (name, flagged, dueDate) | 427ms | 657ms |
| Project status (bulk) | 268ms | 214ms |

### Chain property head-to-head (5 runs each, alternating)

| Operation | JXA | AS |
|-----------|----:|---:|
| containingProject.id() | 237ms | 194ms |
| containingProject.name() | 396ms | 340ms |
| containingProject() (raw refs) | 380ms | 383ms |
| flattenedTasks.id() (baseline) | 234ms | 261ms |

At low property counts (1–5 properties, chain or direct), no consistent winner. Both show high variance. The Apple Events transport layer is identical — both languages generate the same underlying Apple Events messages — and the IPC floor dominates.

### At high property counts: AppleScript wins decisively

See §4.2 for the full analysis. At 18 properties on 2,137 tasks (10 runs each, alternating):

| Language | Median |
|----------|-------:|
| JXA | 13,982ms |
| AppleScript (source) | 5,158ms |
| AppleScript (pre-compiled .scpt) | 3,443ms |

The JXA bridge imposes a per-statement overhead that accumulates as more Apple Events calls are made within a single script. At 18 property reads, JXA is **2.7× slower** than AppleScript from source and **4.1× slower** than pre-compiled AppleScript.

Pre-compilation saves ~1.7 seconds at this scale — the cost of `osacompile` parsing and compiling the source text. This is a fixed per-script cost that could be paid once at server startup.

### Timing methodology

All times in this report are *gross* — measured from before `osascript` invocation to after it returns. They include process startup (~17–26ms), script compilation, Apple Events IPC, OmniFocus processing, and result serialisation. The compilation cost is not isolated in the main benchmark. For AppleScript, `osascript` compiles the source text on every invocation (there is no pre-compiled `.scpt` caching). For JXA, JavaScriptCore parses and JIT-compiles the source. The bare startup numbers (17–26ms) provide a rough lower bound on the non-AE overhead, while the pre-compiled .scpt measurements isolate the compilation cost at ~1.7s for an 18-statement script.

Script Debugger's faster times for the same operations (35–89ms vs our 194–237ms for `containingProject.id()`) are explained by Script Debugger maintaining a persistent, pre-compiled connection to OmniFocus — it pays neither the process startup nor the compilation cost on each evaluation.

### Implication

Language choice matters for scripts with many Apple Events calls. **For scripts reading fewer than ~8 properties, JXA and AS are equivalent** — choose based on ergonomics (JXA for complex logic and JSON serialisation; AppleScript for mutations). **For scripts reading 8+ properties (the BulkScan hot path), AppleScript is substantially faster**, and pre-compiled AppleScript faster still. This creates a concrete optimisation opportunity: generate AppleScript instead of JXA for bulk property reads, and consider pre-compiling hot-path scripts.

---

## Summary: The Cost Hierarchy

| Tier | Cost | Example |
|------|-----:|---------|
| IPC floor | ~100ms | Any round-trip to OmniFocus |
| OmniJS byIdentifier() | ~120ms | Single item lookup (fixed overhead) |
| Scalar bulk read | ~140–170ms | `flattenedTasks.name()` (2,137 items) |
| Chain bulk read | ~200–400ms | `flattenedTasks.containingProject.name()` (high variance) |
| Marginal prop (JXA) | ~55ms | Each additional property in same JXA script |
| Marginal prop (AS) | ~30ms* | Each additional property in same AS script |
| Marginal byIdentifier() | ~7ms | Each additional item in same OmniJS script |
| Single `.whose()` | ~150ms | One predicate evaluation |
| Relationship traversal | ~140–170ms | tag → tasks.id() |
| Note bulk read | ~5–16s | `flattenedTasks.note()` |
| JXA bridge tax (18 props) | ~9s | JXA 14s vs AS 5s for the same 18 property reads |

*Estimated from the 18-property comparison: (AS 5,158ms − floor 100ms) / 18 ≈ 280ms/prop vs (JXA 13,982ms − 100ms) / 18 ≈ 770ms/prop. The per-property cost in JXA increases non-linearly, likely due to GC pressure from accumulating large arrays in the JS heap.

All times are gross (include osascript process startup, script compilation, IPC, and result serialisation). Net OmniFocus processing time is roughly 100ms less, as confirmed by Script Debugger measurements that bypass the process overhead.

### Design Rules Derived from This Data

1. **Minimise round-trips.** The ~100ms floor means every separate osascript invocation is expensive. Batch all property reads into a single script.

2. **Bulk-read, don't query.** A bulk read of 2,137 scalars (140ms) costs the same as a single `.whose()` lookup (150ms). Always prefer bulk-read + Node-side filter over server-side predicate evaluation.

3. **Chain properties are moderately more expensive than direct properties.** `containingProject.name()` costs ~250–400ms vs ~140–170ms for direct scalars — roughly 1.5–2.5×. The planner should treat chain variables as slightly more expensive than direct variables, but they remain in the same cost tier (not a different class). However, chain reads show high variance (individual runs spanning 160–570ms), so budget for occasional spikes.

4. **Always chain through to a scalar.** Materialising raw object specifier arrays (`containingProject()`) showed the same ~200–400ms cost as chaining to a scalar property. There is no dramatic penalty for raw refs as initially appeared, but there is also no reason to request them — always chain to the property you need.

5. **Collection size doesn't matter (much).** 33 folders and 2,137 tasks have similar read times because the IPC floor dominates. The per-item serialisation cost is <0.1ms for scalars.

6. **Notes are a special case.** At 7.6ms per item (vs <0.1ms for scalars), notes are ~100× more expensive. Keep them out of `where` clauses and warn on large `select` result sets.

7. **Use AppleScript for bulk reads with many properties.** Below ~8 properties, JXA and AS are equivalent — choose for ergonomics. Above ~8 properties, the JXA bridge tax becomes material and AppleScript is 2–4× faster. Pre-compiled AppleScript (.scpt) is faster still, saving ~1.7s of compilation overhead per invocation. For the query engine's BulkScan hot path (which routinely reads 8–15 properties), generating AppleScript instead of JXA is a concrete optimisation opportunity.

8. **Use OmniJS `byIdentifier()` for small enrichment sets.** When a SemiJoin or MembershipScan narrows results to <50 IDs, `byIdentifier()` (at ~7ms/item + ~120ms overhead) is faster than a full bulk read (~400ms+ for 5 properties). Above ~100 IDs, bulk-read + filter wins decisively and with much lower variance. The planner can use estimated result set size (from SemiJoin cardinality or `limit` clauses) to choose the enrichment path.
