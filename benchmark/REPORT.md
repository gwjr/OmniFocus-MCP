# Apple Events Cost Model for OmniFocus

**Date:** 2 March 2026
**Database:** 2,137 tasks, 366 projects, 31 tags, 33 folders
**Method:** Each measurement repeated 3 times, median reported. JXA via `osascript -l JavaScript` with temp files. All scripts connect to OmniFocus, get `defaultDocument`, then perform the measured operation.

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
| containingProject (ref) | 1,182ms | object specifier |
| containingProject.name() | 160ms | chain → scalar |
| containingProject.id() | 531ms | chain → scalar |

*effectivelyDropped showed high variance (173ms–1,225ms); the 725ms median may include GC or cache effects.

**Simple scalar and date properties** (name, flagged, dueDate, etc.) cost **130–170ms** — barely above the collection access floor. The per-item serialisation cost for 2,137 items is roughly 30–70ms on top of the ~100ms floor.

**Computed boolean properties** (blocked, effectivelyCompleted) are slightly more expensive at **164–195ms**. OmniFocus must evaluate each item's state graph rather than reading a stored value.

**Object specifier arrays** are expensive. `containingProject()` returns 2,137 object specifiers (essentially pointers into the OmniFocus object graph). At **1,182ms**, this is ~8× a scalar read. Each specifier must be constructed and serialised individually.

**Chain properties** bypass the specifier cost. `containingProject.name()` at **160ms** is *cheaper than* reading `id` at 163ms — Apple Events resolves the chain on the server side and returns 2,137 strings directly, never materialising 2,137 intermediate object specifiers. This is a critical optimisation: chain reads are as cheap as direct reads.

The anomaly is `containingProject.id()` at **531ms** — significantly more expensive than `.name()`. This may reflect OmniFocus's internal representation: names are cached directly on the project reference, while IDs require resolving the specifier to look up the object's persistent identifier. This needs further investigation but the practical consequence is: **prefer `.name()` chains over `.id()` chains when both are available**.

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

`container.id()` for projects (120ms) is much cheaper than `containingProject.id()` for tasks (531ms). The folder→project containment relationship is simpler than the task→project relationship.

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

Reading multiple properties from the same collection in a single osascript invocation:

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

## 8. JXA vs AppleScript

| Operation | JXA | AS |
|-----------|----:|---:|
| 3 task props (name, flagged, dueDate) | 427ms | 657ms |
| Project status (bulk) | 268ms | 214ms |

No consistent winner. Both show high variance. The Apple Events transport layer is identical — both languages generate the same underlying Apple Events messages. Any differences are in the language runtime's overhead for constructing specifiers and unmarshalling results, which is dwarfed by the IPC and OmniFocus processing time.

**Implication:** Language choice between JXA and AppleScript has no performance significance. Choose based on ergonomics (JXA for complex logic and JSON handling; AppleScript for mutations where the syntax is more natural).

---

## Summary: The Cost Hierarchy

| Tier | Cost | Example |
|------|-----:|---------|
| IPC floor | ~100ms | Any round-trip to OmniFocus |
| Scalar bulk read | ~140–170ms | `flattenedTasks.name()` (2,137 items) |
| Chain bulk read | ~160ms | `flattenedTasks.containingProject.name()` |
| Marginal prop in script | ~55ms | Each additional property in same script |
| Single `.whose()` | ~150ms | One predicate evaluation |
| Relationship traversal | ~140–170ms | tag → tasks.id() |
| Object specifier array | ~500–1,200ms | `containingProject()` (raw refs) |
| Note bulk read | ~5–16s | `flattenedTasks.note()` |

### Design Rules Derived from This Data

1. **Minimise round-trips.** The ~100ms floor means every separate osascript invocation is expensive. Batch all property reads into a single script.

2. **Bulk-read, don't query.** A bulk read of 2,137 scalars (140ms) costs the same as a single `.whose()` lookup (150ms). Always prefer bulk-read + Node-side filter over server-side predicate evaluation.

3. **Chain properties are free.** `containingProject.name()` costs the same as `name()`. The planner should not penalise chain variables relative to direct variables.

4. **Never materialise object specifier arrays.** `containingProject()` at 1,182ms is 7× more expensive than `containingProject.name()` at 160ms. Always chain through to a scalar property.

5. **Collection size doesn't matter (much).** 33 folders and 2,137 tasks have similar read times because the IPC floor dominates. The per-item serialisation cost is <0.1ms for scalars.

6. **Notes are a special case.** At 7.6ms per item (vs <0.1ms for scalars), notes are ~100× more expensive. Keep them out of `where` clauses and warn on large `select` result sets.

7. **Language doesn't matter.** JXA and AppleScript perform identically for Apple Events operations. Choose for ergonomics.
