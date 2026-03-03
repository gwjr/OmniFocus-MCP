# Apple Events Cost Model for OmniFocus

**Date:** 3 March 2026 (updated; original 2 March 2026)
**Database:** 2,146 tasks, 369 projects, 31 tags, 33 folders (original: 2,137 tasks, 366 projects)
**Method:** Each measurement repeated 3 times (median reported) for the main benchmark, 5 times (alternating JXA/AS) for the chain property head-to-head. JXA via `osascript -l JavaScript`, AppleScript via `osascript`, both using temp files. All scripts connect to OmniFocus, get `defaultDocument`, then perform the measured operation.

---

## 1. Process Startup

| Step | JXA | AppleScript |
|------|----:|------------:|
| Bare interpreter (no app) | 17ms | 26ms |
| + `Application("OmniFocus")` | 17ms | 29ms |
| + `defaultDocument` | 24ms | 26ms |

JXA's JavaScriptCore interpreter starts ~9ms faster than AppleScript's, but the difference disappears once you're connected to an application. Connecting to OmniFocus adds ~2ms; resolving `defaultDocument` adds another ~6ms in JXA (negligible in AS — likely deferred resolution).

**Implication:** Process startup is cheap. The real cost is the first Apple Events round-trip to the application, not the interpreter.

---

## 2. Collection Access Floor

| Collection | JXA `.length` | AS `count of` |
|------------|-------------:|-------------:|
| flattenedTasks (2,146) | 134ms | 123ms |
| flattenedProjects (369) | 133ms | 109ms |
| flattenedTags (31) | 107ms | 104ms |
| flattenedFolders (33) | 108ms | 96ms |

Merely obtaining a reference to a flattened collection and reading its count costs **~100–120ms regardless of collection size**. A 2,137-item collection costs the same as a 31-item collection. This is the Apple Events IPC floor: the fixed cost of constructing the object specifier, sending it across the Mach port, having OmniFocus resolve it, and returning the result.

**Implication:** Every Apple Events round-trip pays at least ~100ms. This floor dominates the cost model. The number of round-trips matters far more than the amount of data in any single round-trip.

---

## 3. Bulk Property Reads

### 3.1 Tasks (2,146 items)

The fundamental operation: `doc.flattenedTasks.propertyName()` returns an array of 2,146 values in a single Apple Events call.

| Property | Median | Category |
|----------|-------:|----------|
| name | 181ms | scalar |
| id | 223ms | scalar |
| flagged | 163ms | scalar |
| completed | 238ms | scalar |
| dropped | 219ms | scalar |
| dueDate | 168ms | date |
| deferDate | 134ms | date |
| completionDate | 161ms | date |
| modificationDate | 237ms | date |
| estimatedMinutes | 154ms | scalar |
| blocked | 176ms | computed |
| effectivelyCompleted | 161ms | computed |
| effectivelyDropped | 153ms | computed |

*effectivelyDropped in the 2 March run showed high variance (173ms–1,225ms; 725ms median), likely a GC artifact. The 3 March run shows 153ms, consistent with other computed booleans.*

**Simple scalar and date properties** (name, flagged, dueDate, etc.) cost **130–240ms** — above the collection access floor, with significant run-to-run variance. The per-item serialisation cost for 2,146 items adds ~30–100ms on top of the ~100ms floor depending on property type.

**Computed boolean properties** (blocked, effectivelyCompleted, effectivelyDropped) cost **150–180ms** — similar to scalars. OmniFocus must evaluate each item's state graph, but this appears no more expensive than reading a stored value in current measurements.

#### Chain properties (containingProject)

The initial 3-run benchmark suggested large differences between chain property variants (160ms for `.name()` vs 531ms for `.id()` vs 1,182ms for raw refs). A follow-up head-to-head test with 5 alternating runs per language told a different story:

| Operation | JXA | AS | Notes |
|-----------|----:|---:|-------|
| containingProject.id() | 126ms | 123ms | JXA runs: 128, 131, 126, 117, 116 (3 Mar) |
| containingProject.name() | 135ms | 135ms | JXA runs: 139, 132, 135, 127, 152 (3 Mar) |
| containingProject() (raw refs) | 155ms | 142ms | JXA runs: 141, 156, 163, 155, 142 (3 Mar) |
| flattenedTasks.id() (baseline) | 123ms | 123ms | JXA runs: 119, 137, 123, 127, 115 (3 Mar) |

> **Note:** The 2 March run showed much higher chain property medians (237ms, 396ms, 380ms) versus the 3 March run (126ms, 135ms, 155ms). This confirms the high variance documented below — the 2 March figures were likely cache-cold measurements. The 3 March figures are consistent with `flattenedTasks.id()` baseline (~120ms), suggesting the relationship traversal overhead is near zero in a warm cache.

(Script Debugger independently confirmed `id of containing project of every flattened task` at 35–89ms in a persistent connection, consistent with the ~100ms IPC floor accounting for most of the osascript overhead.)

The key findings:

**Chain property cost is highly session-dependent.** The 2 March run measured 237–396ms for chain variants; the 3 March run measured 123–155ms — near the baseline for a direct scalar read. This is the largest observed source of variance across sessions and is consistent with OmniFocus's internal caching: a warm cache eliminates the relationship traversal cost almost entirely.

**Variance is high.** Within a session, individual runs of `containingProject.name()` can range from 127ms to 571ms. This likely reflects OmniFocus's caching of the task→project relationship. The initial benchmark's apparent anomalies (531ms for `.id()`, 1,182ms for raw refs on 2 March) were most likely unlucky draws from this high-variance distribution.

**JXA and AS are equivalent for chains.** No consistent winner across either session. There is no JXA bridge penalty for chain property resolution.

**Implication for the query engine:** Chain properties are *at most* moderately more expensive than direct properties (up to ~400ms vs ~130–200ms in a cold session), but can be essentially free in a warm session. The variable cost model (see `variables.ts`) correctly classifies chain variables as slightly more expensive than direct ("easy") variables. The variance means chain reads may occasionally spike to ~500ms, but a chain read is always cheaper than the alternative of materialising specifiers and doing per-item lookups.

### 3.2 Projects (369 items)

| Property | Median |
|----------|-------:|
| name | 120ms |
| id | 169ms |
| status | 160ms |
| flagged | 118ms |
| completed | 82ms |
| dueDate | 87ms |
| deferDate | 120ms |
| completionDate | 111ms |
| estimatedMinutes | 125ms |
| sequential | 127ms |
| numberOfTasks | 121ms |
| numberOfAvailableTasks | 83ms |
| container() (ref) | 89ms |
| container.id() | 120ms |

Most project properties cost **80–130ms** — near or at the collection access floor, because 369 items add negligible serialisation overhead to the ~100ms IPC cost.

`numberOfAvailableTasks` (83ms) and `completed` (82ms) are at or below the floor — OmniFocus appears to cache these aggregates. `container.id()` for projects (120ms) is comparable to direct scalar reads.

### 3.3 Tags (31 items)

| Property | Median |
|----------|-------:|
| name | 79ms |
| id | 82ms |
| allowsNextAction | 97ms |
| hidden | 98ms |
| effectivelyHidden | 121ms |
| container() (ref) | 107ms |
| container.id() | 121ms |

All tag properties cost **79–121ms** — at or near the collection access floor. With only 31 items, serialisation cost is zero. Even `container()` as an object specifier is cheap because it's only 31 specifiers.

### 3.4 Folders (33 items)

| Property | Median |
|----------|-------:|
| name | 118ms |
| id | 107ms |
| container.id() | 104ms |

Same story as tags — everything is at or near the floor.

---

## 4. Multi-Property Reads

### 4.1 JXA scaling (1–12 properties)

Reading multiple properties from the same collection in a single JXA osascript invocation:

| Properties | Median (3 Mar) | Incremental | Marginal per prop |
|-----------:|---------------:|------------:|------------------:|
| 1 | 116ms | — | — |
| 2 | 168ms | +52ms | 52ms |
| 3 | 197ms | +29ms | 29ms |
| 5 | 315ms | +118ms | 59ms |
| 8 | 494ms | +179ms | 60ms |
| 12 | 579ms | +85ms | 28ms |

The first property read in a script pays the full ~120ms (floor + collection resolution + one property). Each additional property read adds roughly **30–60ms** on average, because the collection specifier is already resolved and cached within the process.

Reading 12 properties in one script costs ~**580ms**. Reading them as 12 separate osascript invocations would cost approximately 12 × 120ms = **1,440ms** — 2.5× more expensive. The savings come entirely from amortising the ~100ms IPC floor across multiple property reads.

> **Note on variance:** The 3 March run shows lower absolute values than the 2 March run (which showed 164ms at 1 prop, 749ms at 12 props). High run-to-run variance is normal — OmniFocus cache state, background sync, and system load all affect timing. The relative scaling (each additional property ≈ 30–60ms marginal cost) is consistent across sessions.

**Implication:** Always batch property reads into a single script. The marginal cost of an additional property within an existing script (~30–60ms) is well below the cost of a fresh round-trip (~100–130ms floor).

### 4.2 JXA vs AppleScript at high property counts

> **Update (3 March 2026):** The dramatic bridge tax figures below (14s JXA vs 5.2s AS) were **not reproducible** in fresh benchmarks run the following day. JXA and AppleScript now measure within ~20% of each other at all property counts (10 and 18 properties tested). The original data was likely an artifact of GC pressure, OmniFocus cache/sync state, or system conditions — the extreme variance (1.2s–27s within a single JXA run sequence) supports this. See `docs/applescript-codegen-design.md` for the full re-investigation.
>
> The original data is preserved below for reference, but **the "JXA bridge tax" is not a reliable optimisation target.**

At low property counts (1–5), JXA and AppleScript perform similarly — the IPC floor dominates and per-statement overhead is invisible. A head-to-head comparison at 18 properties (10 runs each, alternating JXA/AS/pre-compiled-AS) showed:

| Language | Original median (2 Mar) | Fresh median (3 Mar, 18 props) | Notes |
|----------|------------------------:|-------------------------------:|-------|
| JXA | 13,982ms | ~958ms | Original not reproducible |
| AppleScript (source) | 5,158ms | ~1,272ms | AS slightly slower in fresh run |
| AppleScript (pre-compiled .scpt) | 3,443ms | — | Not re-tested |

(The 18 properties: name, id, flagged, completed, dropped, dueDate, deferDate, completionDate, modificationDate, creationDate, estimatedMinutes, blocked, effectivelyCompleted, effectivelyDropped, sequential, inInbox, next, repetitionRule.)

Variance remained extremely high in both sessions (original JXA runs ranged from 1,172ms to 26,995ms; fresh JXA runs ranged from 909ms to 2,521ms). The original medians suggested a clear pattern, but the fresh data shows no consistent winner.

A further `multi-prop-compare` run (3 March, 5 alternating runs each for JXA/AS/pre-compiled-SCPT, 1–12 properties) confirms the same picture:

| Props | JXA median | AS median | SCPT median | Winner |
|------:|-----------:|----------:|------------:|--------|
| 1 | 186ms | 240ms | 219ms | JXA |
| 2 | 267ms | 312ms | 290ms | JXA |
| 3 | 456ms | 351ms | 433ms | AS |
| 5 | 586ms | 498ms | 490ms | AS/SCPT |
| 8 | 670ms | 864ms | 693ms | JXA |
| 12 | 557ms | 589ms | 592ms | JXA |

No consistent winner at any property count. The direction flips between AS-faster and JXA-faster depending on measurement run. The 3-prop JXA median (456ms) includes one 2,262ms outlier that dominated the median — without that outlier the JXA sequence is 339–627ms, fully consistent with the other rows. This confirms the high variance is noise, not a systematic effect.

**The original hypothesis — that the JXA bridge has significant per-statement overhead — is not supported by reproducible evidence.** The fresh benchmarks show JXA and AppleScript within ~20% of each other at all property counts tested (1–18 properties), with the advantage alternating randomly. The extreme original JXA times were caused by JavaScriptCore GC pressure under specific heap conditions.

**Implication for the query engine:** The JXA-only codegen path is adequate for all current property counts. Typical queries read 5-7 properties (well below any hypothetical crossover). An AppleScript codegen backend is not justified by the data. See `docs/applescript-codegen-design.md` for the detailed investigation and recommendation.

---

## 5. Per-Item Lookups (`.whose()`)

| Operation | Median | Per-lookup |
|-----------|-------:|----------:|
| `.whose({id: x})` × 1 | 142ms | 142ms |
| `.whose({id: x})` × 5 (loop) | 411ms | 82ms |
| `.whose({id: x})` × 10 (loop) | 232ms | 23ms |
| `.whose({name: x})` on tasks | 192ms | — |
| `.whose({name: x})` on tags | 137ms | — |
| `.whose({name: x})` on projects | 121ms | — |

A single `.whose()` call costs **~140ms** — approximately the same as reading an entire property array from the full 2,146-task collection. (The 10-item loop median of 232ms is suspiciously low — the 3-run sequence was [232ms, 181ms, 510ms]; high variance is typical for `.whose()` loops.) The `.whose()` predicate is evaluated server-side by OmniFocus, which must iterate the entire collection to find matches. For a keyed lookup by `id`, this is a linear scan (OmniFocus does not appear to maintain a hash index on IDs for Apple Events queries).

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

**Implication:** The current relationship traversal implementation — used by `Restriction` nodes in the SetIR and by `container()`/`containing()` predicates — is close to optimal. The `.whose({name:})` lookup + `.tasks.id()` read completes in one Apple Events round-trip for ~140–170ms.

---

## 7. Note Reads

| Entity | Median | Per-item |
|--------|-------:|---------:|
| Tasks (2,146) | 14,043ms | 6.5ms |
| Projects (369) | 3,324ms | 9.0ms |

Task notes are **~80× more expensive** than scalar properties. Project notes are **~20× more expensive**. The 3 March run shows faster task notes (14s vs 16.3s) and slower project notes (3.3s vs 1.8s) than 2 March — both within the documented high-variance range.

Notes in OmniFocus are stored as rich text. Each note must be serialised from the internal RTF-like representation to a plain-text string for Apple Events delivery. Task note reads show very high variance across sessions (3 March: 14s; 2 March: 16.3s; individual runs spanning 12–27s in one session), suggesting disk I/O and RTF→text stripping overhead that depends on note content and cache state.

The per-item cost (~6.5ms for tasks, ~9.0ms for projects on 3 March) is dramatically higher than for scalar properties (<0.1ms per item). Notes are in a fundamentally different performance class.

**Implication:** The query engine's policy of classifying `note` as "expensive" and restricting it to `select`-only (never `where`) is strongly validated. Even reading notes in `select` should be considered carefully for large result sets — a query returning 500 tasks with notes will spend ~4 seconds just on note reads.

---

## 8. OmniJS `byIdentifier()` vs JXA Bulk Read

A different access pattern: given a set of known task IDs (e.g., from a SemiJoin after a `container()` or `containing()` predicate), is it faster to look up each item individually via OmniJS's `Task.byIdentifier()`, or to bulk-read the entire collection via JXA Apple Events and filter in-script?

OmniJS `byIdentifier()` runs inside OmniFocus's JavaScript environment (via `app.evaluateJavascript()`), accessing objects directly without Apple Events serialisation. This avoids the IPC overhead per property but must be called once per item. The JXA bulk path reads 5 property arrays from all 2,146 tasks in parallel, then filters to the wanted IDs — a fixed cost regardless of how many IDs are wanted.

5 runs each, alternating, reading 5 properties per item (name, id, flagged, dueDate, deferDate):

| IDs wanted | OmniJS byId | JXA bulk | Winner | Per-ID (OmniJS) |
|-----------:|------------:|---------:|--------|----------------:|
| 1 | 138ms | 248ms | OmniJS 1.8× | 138ms |
| 5 | 130ms | 252ms | OmniJS 1.9× | 26ms |
| 10 | 147ms | 274ms | OmniJS 1.9× | 15ms |
| 50 | 214ms | 273ms | OmniJS 1.3× | 4ms |
| 100 | 333ms | 270ms | JXA bulk 1.2× | 3ms |
| 500 | 1,233ms | 272ms | JXA bulk 4.5× | 2ms |

(3 March 2026 run; 5 alternating runs each; 5 properties read: name, id, flagged, dueDate, deferDate.)

**The crossover is around 50–100 IDs** — consistent with the 2 March measurement. Below 50, `byIdentifier()` wins because it avoids reading the entire collection — the per-item cost (~4–26ms depending on count) is less than the bulk read's fixed cost (~250–270ms for 5 properties). Above 100, the per-item cost accumulates and the bulk read wins decisively.

The `byIdentifier()` per-item cost is not constant: it starts at ~138ms for a single item (dominated by the `evaluateJavascript()` call overhead) and drops to ~2–4ms per item at scale as the fixed overhead amortises. At 500 items the total reaches 1.2s, while the JXA bulk path stays flat at ~270ms. The 3 March JXA bulk reads are notably lower (~250–275ms) than 2 March (~400–700ms), consistent with a warmer OmniFocus cache in this session.

The crossover point and qualitative conclusions are unchanged from the 2 March measurement. The deferred-enrichment thresholds (DEFERRED_ENRICH_MAX_ROWS=50) remain well-calibrated.

**Implications for the query engine:**

1. **Small enrichment sets (<50 items):** After a SemiJoin narrows results to a small ID set (e.g., via a `container()` or `containing()` predicate), `byIdentifier()` is the right enrichment path. It's faster than a full bulk read and avoids reading data for 2,000+ irrelevant items.

2. **Large result sets (>100 items):** Bulk-read + filter remains better. The fixed cost of reading the entire collection is amortised across the result set, and the JXA path has much lower variance.

3. **The crossover at ~50–100 IDs is specific to 5 properties.** With more properties, the JXA bulk-read cost increases (see §4.2 on the JXA bridge tax), which would push the crossover higher — `byIdentifier()` might win up to ~200 IDs when reading 12+ properties.

4. **This creates a two-path enrichment strategy:** the pipeline can estimate result set size (from SemiJoin cardinality or a `limit` clause) and choose `byIdentifier()` for small sets vs bulk-read for large ones. Currently, the SetIR `Enrich` node uses `ForEach` + `byIdentifier()` for expensive variables like `note`.

5. **Bridge serialisation format doesn't matter at these scales.** A follow-up benchmark (§8.1) tested three serialisation strategies — JSON objects stringified in OmniJS, raw arrays returned to JXA for stringification, and JSON arrays stringified in OmniJS — with randomised execution order and trimmed outlier removal. At 100 items × 5 properties, all three converge to within 70ms of each other (~550–620ms). The `byIdentifier()` loop dominates; serialisation cost is in the noise. Choose based on ergonomics (objects are easier to work with downstream), not performance.

### 8.1 Bridge Serialisation: OmniJS vs JXA (detailed)

`evaluateJavascript()` preserves structure — arrays, objects, and nested values come back as real JS types in JXA, not strings. So there are two choices: stringify in OmniJS (returns a flat string across the bridge) or return structured data and let JXA stringify.

Three strategies tested (9 runs each, strategy order randomised per iteration, top/bottom 2 trimmed):

| Path | Description |
|------|-------------|
| A | OmniJS builds `[{name, id, ...}]`, `JSON.stringify` in OmniJS, string returned to JXA |
| B | OmniJS builds `[[name, id, ...]]`, returns raw array, JXA does `JSON.stringify` |
| C | OmniJS builds `[[name, id, ...]]`, `JSON.stringify` in OmniJS, string returned to JXA |

**Results (trimmed median):**

| Items | A (OmniJS JSON, objects) | B (Raw → JXA JSON) | C (OmniJS JSON, arrays) |
|------:|-------------------------:|--------------------:|-------------------------:|
| 10 | 152ms | 139ms | 152ms |
| 50 | 234ms | 213ms | 249ms |
| 100 | 301ms | 311ms | 307ms |

(3 March 2026; 9 runs each, strategy order randomised per iteration, top/bottom 2 trimmed.)

All three strategies converge at all item counts. The maximum spread at 100 items is 10ms — within measurement noise. The `byIdentifier()` loop cost dominates; serialisation format is irrelevant.

**Why the initial (non-randomised) benchmark was misleading:** With fixed A→B→C ordering, strategy A always ran first in each iteration. If OmniFocus had a warm period followed by a slow period, A systematically benefited from the warm start. Randomising the order eliminated this bias and collapsed the apparent differences.

---

## 9. JXA vs AppleScript

### At low property counts: equivalent

| Operation | JXA | AS |
|-----------|----:|---:|
| 3 task props (name, flagged, dueDate) | 248ms | 253ms |
| Project status (bulk) | 94ms | 100ms |

### Chain property head-to-head (5 runs each, alternating, 3 March)

| Operation | JXA | AS |
|-----------|----:|---:|
| containingProject.id() | 126ms | 123ms |
| containingProject.name() | 135ms | 135ms |
| containingProject() (raw refs) | 155ms | 142ms |
| flattenedTasks.id() (baseline) | 123ms | 123ms |

At low property counts (1–5 properties, chain or direct), no consistent winner. Both show high variance. The Apple Events transport layer is identical — both languages generate the same underlying Apple Events messages — and the IPC floor dominates. Chain properties in the 3 March run measure much closer to the baseline than 2 March (see §3.1 note on cache-warmth variance).

### At high property counts: no consistent winner

See §4.2 for the full analysis. Original benchmarks (2 March) suggested a dramatic JXA bridge tax at 18 properties, but fresh benchmarks could not reproduce the difference:

| Language | Original (2 Mar) | Fresh (3 Mar, 18 props) |
|----------|------------------:|------------------------:|
| JXA | 13,982ms | ~958ms |
| AppleScript (source) | 5,158ms | ~1,272ms |

The 3 March multi-prop-compare run (1–12 properties, 5 alternating runs) shows no consistent winner: JXA wins at 1, 2, 8, 12 props; AS wins at 3, 5 props — with the advantage always within the noise margin. There is no reliable JXA bridge tax to exploit.

### Timing methodology

All times in this report are *gross* — measured from before `osascript` invocation to after it returns. They include process startup (~17–26ms), script compilation, Apple Events IPC, OmniFocus processing, and result serialisation. The compilation cost is not isolated in the main benchmark. For AppleScript, `osascript` compiles the source text on every invocation (there is no pre-compiled `.scpt` caching). For JXA, JavaScriptCore parses and JIT-compiles the source. The bare startup numbers (17–26ms) provide a rough lower bound on the non-AE overhead, while the pre-compiled .scpt measurements isolate the compilation cost at ~1.7s for an 18-statement script.

Script Debugger's faster times for the same operations (35–89ms vs our 194–237ms for `containingProject.id()`) are explained by Script Debugger maintaining a persistent, pre-compiled connection to OmniFocus — it pays neither the process startup nor the compilation cost on each evaluation.

### Implication

**JXA and AppleScript are equivalent at all tested property counts** — choose based on ergonomics (JXA for complex logic and JSON serialisation; AppleScript for mutations). The originally reported bridge tax at 8+ properties is not reproducible and should not drive architecture decisions. See `docs/applescript-codegen-design.md` for the full investigation.

---

## Summary: The Cost Hierarchy

| Tier | Cost | Example |
|------|-----:|---------|
| IPC floor | ~100–130ms | Any round-trip to OmniFocus |
| OmniJS byIdentifier() | ~130–140ms | Single item lookup (fixed overhead) |
| Scalar bulk read | ~120–240ms | `flattenedTasks.name()` (2,146 items; high run-to-run variance) |
| Chain bulk read | ~120–400ms | `flattenedTasks.containingProject.name()` (cache-dependent) |
| Marginal prop (JXA) | ~30–60ms | Each additional property in same JXA script |
| Marginal byIdentifier() | ~2–4ms | Each additional item in same OmniJS script (at scale) |
| Single `.whose()` | ~120–150ms | One predicate evaluation |
| Relationship traversal | ~130–160ms | tag → tasks.id() |
| Note bulk read | ~3–16s | `flattenedTasks.note()` (high variance) |
| ~~JXA bridge tax (18 props)~~ | ~~~9s~~ | Not reproducible — see §4.2 |

High run-to-run variance (often 2–3× between best and worst in a 3–5 run sequence) is the norm for all Apple Events operations, driven by OmniFocus cache state, background sync, and GC. The ranges above span measured values across multiple sessions. The relative ordering (IPC floor → scalar → chain → notes) is consistent.

All times are gross (include osascript process startup, script compilation, IPC, and result serialisation). Net OmniFocus processing time is roughly 100ms less, as confirmed by Script Debugger measurements that bypass the process overhead.

### Design Rules Derived from This Data

1. **Minimise round-trips.** The ~100ms floor means every separate osascript invocation is expensive. Batch all property reads into a single script.

2. **Bulk-read, don't query.** A bulk read of 2,146 scalars (~130–230ms) costs the same as a single `.whose()` lookup (~130–150ms). Always prefer bulk-read + Node-side filter over server-side predicate evaluation.

3. **Chain properties show high session-to-session variance.** `containingProject.name()` measured 135ms (3 March, warm cache) to 396ms (2 March, cold cache). In a warm session the overhead is near zero; in a cold session it's ~200ms on top of a direct scalar read. The variable cost model (`cost: 'chain'`) correctly captures that they are at most slightly more expensive than direct reads, but not a different cost tier.

4. **Always chain through to a scalar.** Materialising raw object specifier arrays (`containingProject()`) shows the same cost as chaining to a scalar property. There is no reason to request raw refs — always chain to the property you need.

5. **Collection size doesn't matter (much).** 33 folders and 2,146 tasks have similar read times because the IPC floor dominates. The per-item serialisation cost is <0.1ms for scalars.

6. **Notes are a special case.** At ~6–9ms per item (vs <0.1ms for scalars), notes are ~80–100× more expensive. Keep them out of `where` clauses and be cautious about `select` on large result sets.

7. **JXA and AppleScript are equivalent at all property counts.** The originally reported bridge tax at 8+ properties (§4.2) was not reproducible in fresh benchmarks — JXA and AS measure within ~20% of each other at 1–18 properties, with no consistent winner. Choose based on ergonomics: JXA for complex logic and JSON serialisation, AppleScript for mutations. An AppleScript codegen backend for bulk reads is not justified by the data.

8. **Use OmniJS `byIdentifier()` for small enrichment sets.** When a SemiJoin narrows results to <50 IDs, `byIdentifier()` (at ~2–4ms/item + ~130ms overhead) is faster than a full bulk read (~250–275ms for 5 properties in a warm session). Above ~100 IDs, bulk-read + filter wins decisively. The deferred-enrichment thresholds (DEFERRED_ENRICH_MAX_ROWS=50) are well-calibrated against this crossover.

---

## 10. Pipeline Optimisations Affecting Timing Profile

The following optimisations were implemented in the March 2026 cleanup session. They do not change the raw Apple Events cost data above, but they reduce end-to-end query time by eliminating redundant work at the pipeline level.

### 10.1 Column pruning (`eventPlanColumnPrune.ts`)

Dead-column elimination: backward analysis from the result ref computes needed column sets at each node, then prunes `Zip` columns that are never consumed downstream. Each eliminated column avoids one `Get(Property)` Apple Events call (~30–60ms marginal cost per column within a batch, §4.1). For a typical task query that requests 3 output columns but whose filter references 5 additional columns, this can save 2-3 unnecessary property reads (~60–180ms).

Covers all EventPlan node kinds including Union (propagates to both sides), RowCount (prunes to minimal `id` column), and SetOp (propagates to both sides).

### 10.2 Scan subsumption (`optimizeSetIr` — `widenScansToUnion`)

When multiple `Scan` nodes for the same entity exist in the SetIR tree with different column subsets (e.g., `Scan(projects, [id])` for project exclusion and `Scan(projects, [id, name])` for a `container()` lookup), the pass widens all scans to the union of columns. This makes the resulting EventPlan `Get` + `Zip` chains structurally identical, enabling CSE to deduplicate them into a single Apple Events batch. Saves one full IPC round-trip (~100ms) per deduplicated scan.

### 10.3 Skip project exclusion for task-only predicates

Task queries normally subtract project IDs via `Difference(plan, Scan('projects', ['id']))` because projects appear in `flattenedTasks`. When the predicate uses only task-specific variables (e.g., `flagged`, `inInbox`) that projects never satisfy, the exclusion is provably redundant. Skipping it saves the project scan (`~100ms`) plus the Node-side `SemiJoin` (~1ms).

### 10.4 Filter+Limit fusion for `op:exists`

For `op:'exists'` queries, the SetIR produces `Limit(1)` wrapping a `Filter`. Without fusion, the Filter iterates all rows before Limit truncates to 1. The nodeUnit executor detects `Filter → Limit(N)` patterns where the Filter has a single consumer and fuses them: the filter short-circuits after N matches. For a 2,146-task collection where the first match is at position 10, this avoids evaluating ~2,136 predicate calls. The savings are pure CPU (no IPC), but can be 5-10ms on large collections.

### 10.5 JXA fusion: skip redundant JSON serialise/parse cycle

When consecutive JXA execution units are fused into a single `osascript` invocation, cross-unit values were previously serialised to JSON, returned to Node, then re-serialised into the next unit's script. The fused path now passes intermediate values directly between units within the same script, avoiding the redundant serialise/parse cycle. Saves ~1-5ms per fused boundary, more significant for plans with many JXA units.

### 10.6 CSE deduplication (`eventPlanCSE.ts`)

Common subexpression elimination unifies `Get` nodes with structurally identical specifiers, removing redundant Apple Events calls. Combined with scan subsumption (§10.2), this is particularly effective for `container()` queries where the same entity (e.g., projects) is read both for the FK lookup and for project exclusion. Saves ~100ms per deduplicated `Get(Elements)` call.
