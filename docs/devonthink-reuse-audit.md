# Query Engine Reuse Audit: DEVONthink MCP Server

**Date:** 2026-03-03
**Context:** Assess what would need to change to reuse the OmniFocus query engine in a DEVONthink MCP server. Companion audit for Mail exists at `mail-reuse-audit.md`.

---

## 1. How the DEVONthink MCP Server Currently Works

The existing `mcp-server-devonthink` (28 tools, TypeScript, pure JXA via `executeJxa`) does **no query compilation or filter planning**. Every tool builds a JXA script string at call time and passes it to `osascript`. Filtering — where it exists — happens inside the JXA script, either via DEVONthink's own `search()` command (full-text, relevance-ranked) or by calling per-item property accessors on a result set (`record.tags()`, `record.recordType()`).

There is no equivalent to the query engine pipeline:

- No AST lowering (`lower.ts` / `fold.ts`)
- No SetIR tree construction (`setIr.ts` / `lowerToSetIr.ts`)
- No EventPlan IR or optimizer passes
- No bulk property reads (all reads are per-item: `record.name()`, `record.id()`, etc.)
- No cost model or variable registry

The search tool delegates to DEVONthink's built-in full-text search engine. The lookup tools delegate to `lookupRecordsWithFile`, `lookupRecordsWithTags`, etc. — direct dictionary commands, not computed predicates.

---

## 2. DEVONthink Entity Model

DEVONthink exposes a simpler entity model than OmniFocus:

| Concept       | OmniFocus equivalent | Notes |
|---------------|---------------------|-------|
| Record        | Task                | Core data item; many types (markdown, PDF, group, bookmark, …) |
| Group         | Folder/Project      | Can contain records and other groups |
| Database      | (no equivalent)     | Top-level container; multiple can be open simultaneously |
| Tag           | Tag                 | String-valued; records can have multiple tags |
| Smart Group   | (no equivalent)     | Saved search; not a real container |

**Key structural differences from OmniFocus:**

1. **No "projects are tasks" quirk.** In OmniFocus, `flattenedTasks` includes project root tasks, requiring a `Difference` subtraction. DEVONthink records and groups are separate object types — no analogous ambiguity.

2. **Multi-group membership (replication).** DEVONthink records can be "replicated" — the same record appears in multiple groups simultaneously. A record's `location()` property returns one canonical path, but the record is physically present elsewhere too. This is unlike OmniFocus where a task belongs to exactly one project.

3. **No computed status.** OmniFocus requires `COMPUTED_VAR_SPECS` (e.g., `status = "Overdue"` derived from `completed`, `dropped`, `dueDate`). DEVONthink records have simple boolean flags (`flag`, `unread`, `locked`) with no derived state.

4. **No active-filter concept.** OmniFocus injects default active filters (exclude completed/dropped tasks, exclude hidden tags). DEVONthink has no analogous concept — every record is always queryable regardless of state.

5. **Content is expensive.** The `plainText` / `richText` / `source` properties fetch document content — potentially megabytes. This is the only clear "expensive" tier analogue, and in the current DEVONthink MCP it is already handled conservatively (truncated, only fetched for text-type records).

6. **Full-text search is a first-class primitive.** DEVONthink's `search()` command is far more powerful than any compiled JXA filter. For content-based queries ("find records about X"), delegating to `search()` is always correct and fast. The query engine's Filter node has no analogue here.

7. **Tags are flat strings, not objects.** In OmniFocus, tags are AE objects with their own properties (name, allowsNextAction, etc.) accessible via `flattenedTags`. DEVONthink tags are plain strings stored in `record.tags()`. There is no `flattenedTags` collection to scan; tag membership is only readable per-record.

---

## 3. OmniFocus-Specific Coupling in the Query Engine

### 3.1 `variables.ts` — Fully OmniFocus-specific

The file defines `taskVars`, `projectVars`, `folderVars`, `tagVars`, `perspectiveVars`, and `COMPUTED_VAR_SPECS`. Every entry is OmniFocus-specific:

- Variable names like `dueDate`, `flagged`, `effectivelyCompleted`, `projectId`, `inInbox`
- Apple Events property names like `'effectiveDueDate'`, `'containingProject'`, `'numberOfTasks'`
- Computed derivations like `status = "Overdue"` from date arithmetic
- `EntityType = 'tasks' | 'projects' | 'folders' | 'tags' | 'perspectives'`

**For DEVONthink:** would need to be replaced wholesale with `recordVars`, `groupVars`, `databaseVars`, etc., covering fields like `name`, `uuid`, `recordType`, `tags`, `flag`, `unread`, `size`, `wordCount`, `creationDate`, `modificationDate`, `url`, `comment`, `rating`. No computed vars; no date arithmetic derivations; no chain properties (no `containingProject` equivalent). The VarDef interface (`type`, `nodeKey`, `appleEventsProperty`, `cost`) is structurally reusable; only the content changes.

### 3.2 `aeProps.ts` — Fully OmniFocus-specific

Contains OmniFocus four-character AE codes (`OFClass.flattenedTask`, `OFTaskProp.id`, etc.) from the generated `omnifocus-sdef.js`. The `propSpec()` function maps variable names to AE property specifiers; `getChildToParentFk()` encodes FK relationships between entities.

**For DEVONthink:** DEVONthink has an AppleScript dictionary too, but:
- The class/property codes differ
- DEVONthink's dictionary would need to be extracted and code-generated similarly
- The FK relationships are different: no `containingProject`, no `parentTask`; group membership is a `parents` property (returns a list, because replication)
- The `CHAIN_PROPS` table — which encodes chained AE reads like `task.containingProject.name()` — would need to be replaced with DEVONthink equivalents (e.g., `record.parents.name()` for group names)

### 3.3 `lowerToSetIr.ts` — Partially OmniFocus-specific

The structural lowering logic (and→Intersect, or→Union, not→Filter, container→Restriction) is generic. The OmniFocus-specific parts are:

- `activeFilterForEntity()` — injects OmniFocus-specific active filters. DEVONthink has no equivalent; this function would return `null` for all entities.
- `container()` lowering — hardcoded to OmniFocus container types (`'project'`, `'folder'`, `'tag'`). DEVONthink's group containment is semantically different (groups are containers, but records can be in multiple groups).
- The `ENTITY_TYPES` constant and FK traversal (one-hop `containing()`) is structurally generic but relies on OmniFocus FK metadata from `aeProps.ts`.

### 3.4 `fold.ts` — Generic

`LoweredExpr`, `ExprBackend<T>`, and `foldExpr()` are entirely domain-agnostic. No OmniFocus references. The `container` and `containing` operations reference OmniFocus-specific container type strings (`'project' | 'folder' | 'tag'`), but these are parameters, not hard-coded — the fold dispatches to the backend without caring what the strings mean.

**Reusable as-is** if the container type union is generalised (or left as-is and the DEVONthink backend simply ignores the `container` op).

### 3.5 `setIr.ts` — Generic with one OmniFocus-specific node

All nodes (Scan, Filter, Intersect, Union, Difference, Enrich, Restriction, Count, Sort, Limit, AddSwitch, Error) are domain-agnostic. `TagNameTaskIds` is OmniFocus-specific — a shortcut for the expensive `whose(flattenedTags, name, eq, value)` → `flattenedTasks` traversal. DEVONthink would not need this node.

The `walkSetIr()` tree-walker is fully generic.

### 3.6 EventPlan IR, `lowerSetIrToEventPlan.ts`, JXA unit — Fully OmniFocus-specific

The EventPlan IR (`eventPlan.ts`) uses `FourCC` (four-character AE codes) throughout. `lowerSetIrToEventPlan.ts` calls `classCode()` and `propSpec()` from `aeProps.ts` — all OmniFocus-specific. The JXA unit emits OmniFocus-specific JXA: `Application('OmniFocus')`, `doc.flattenedTasks`, etc.

**For DEVONthink:** the EventPlan IR itself is structurally reusable (it's just an SSA graph of typed instructions), but the lowering pass and JXA codegen would need to be replaced with DEVONthink-specific equivalents.

---

## 4. FK Relationship Mismatch: Multi-Group Membership

OmniFocus FK relationships are clean one-to-many hierarchies: task → project (one), project → folder (one), task → tags (many). These map straightforwardly to `RestrictionNode`.

DEVONthink replication breaks this: a record can appear in multiple groups. `record.parents()` returns a list. A `container(group, pred)` query would need `arrayFk: true` semantics — same as `tags` in OmniFocus. This works in the existing `RestrictionNode` (which already supports `arrayFk`), but:

- The "canonical location" (`record.location()`) only gives one path
- There is no efficient bulk read for `record.parents.id()` analogous to `task.tags.id()`; the DEVONthink dictionary would need to be verified for whether `flattenedRecords.parents.id()` is a valid bulk accessor

This is a known modelling complexity that the current DEVONthink MCP sidesteps by not offering group-filter queries at all.

---

## 5. Effort Assessment

### Is the query engine complexity appropriate for DEVONthink?

**No, not for the current use case.** The current DEVONthink MCP's query pattern is fundamentally different:

- Queries are primarily **full-text searches** delegated to DEVONthink's own engine (`search()`)
- Non-text lookups are **exact-match lookups** via dictionary commands (`lookupRecordsWithTags`, `lookupRecordsWithFile`)
- There is **no bulk scan** use case: DEVONthink doesn't expose `flattenedRecords.name()` aligned-array bulk reads in the same way (the AE dictionary may support them, but the existing server has never needed them)
- Record counts are typically small (hundreds to low thousands), not the ~750-task OmniFocus scale where bulk vs. per-item matters most

The OmniFocus query engine was built specifically to handle OmniFocus's bulk-read fast path, its entity hierarchy, and its active-filter semantics. DEVONthink's primary query primitive is its own full-text search engine, which is already faster and more capable than any compiled JXA filter for content queries.

**Concrete estimate:** Adapting the full pipeline (variables, aeProps, lowerSetIr, EventPlan lowering, JXA unit) for DEVONthink would require replacing approximately 60-70% of the query-engine code. The reusable parts (fold.ts, setIr.ts structural nodes, walkSetIr, node.ts executor) would survive, but they're the simpler parts. The OmniFocus-specific bulk-read optimizations (scan subsumption, tag-name shortcut, column pruning) would all need DEVONthink equivalents or could be dropped.

### What would actually be worth reusing?

If a structured filter query tool were added to the DEVONthink MCP (e.g., "find records where type=PDF and tag contains 'invoice' and modificationDate > 2025-01-01"), the reusable parts are:

1. **`fold.ts`** — `LoweredExpr`, `ExprBackend<T>`, `foldExpr()` — directly reusable
2. **`setIr.ts`** minus `TagNameTaskIds` — directly reusable
3. **`lowerToSetIr.ts` structural core** — and/or/not/Filter mapping; `collectVarNames`; `splitColumns` concept — reusable with new variable registry
4. **`nodeUnit.ts`** — Node-side filter evaluation — directly reusable once variable normalization (dates, enums) is adapted

---

## 6. Architectural Changes That Would Ease Multi-App Reuse

These are concrete changes, not speculative framework design:

1. **Separate the variable registry interface from entity names.** `EntityType` is currently a union type that bleeds into `fold.ts` and `setIr.ts`. If entity names were opaque strings (`type EntityType = string`) at the IR level, with registry lookup injected via a provider, the IR files would become truly generic. Currently blocked by the `container` operation's hardcoded `'project' | 'folder' | 'tag'` union.

2. **Extract `aeProps.ts` into an interface.** The `classCode()` / `propSpec()` / `getChildToParentFk()` functions are the coupling point between the generic IR and OmniFocus AE codes. Defining a `PropertyRegistry` interface and injecting it into `lowerSetIrToEventPlan` would allow a DEVONthink property registry to be swapped in. This is a clean refactor with well-defined seams.

3. **Factor `activeFilterForEntity()` out of `lowerToSetIr.ts`.** Currently the lowering pass hardcodes OmniFocus active filters. Making this an injectable callback (defaulting to `() => null`) would make `lowerToSetIr.ts` generic with no changes to callers.

4. **Wait for a second consumer before extracting.** The existing code is not over-engineered for its current purpose. Extracting a shared package before DEVONthink actually needs structured query compilation would be premature. The natural trigger is: if a DEVONthink structured filter tool is implemented and the per-record iteration approach proves too slow.

---

## 7. Summary

| Layer | Reusable as-is | Needs replacement | Notes |
|-------|---------------|-------------------|-------|
| `fold.ts` | Yes | — | Fully generic |
| `setIr.ts` (minus TagNameTaskIds) | Yes | TagNameTaskIds node | Structural nodes are generic |
| `lowerToSetIr.ts` (structural core) | Partial | activeFilterForEntity, container cases, ENTITY_TYPES | ~50% reusable |
| `variables.ts` | Interface only | All content | VarDef shape reusable; all values are OF-specific |
| `aeProps.ts` | No | Entirely | OmniFocus AE codes throughout |
| EventPlan IR | Structure only | FourCC usage | SSA shape is generic |
| `lowerSetIrToEventPlan.ts` | No | Entirely | Calls OmniFocus-specific propSpec/classCode |
| `jxaUnit.ts` | No | Entirely | Emits OmniFocus-specific JXA |
| `nodeUnit.ts` | Yes | — | Node-side filter evaluation is generic |

**Bottom line:** The OmniFocus query engine is not a good candidate for direct reuse by the DEVONthink MCP today. DEVONthink's query primitive is its own full-text search, not bulk property reads. If a structured property-filter tool were added (type, date range, tag, flag), the generic IR nodes (fold, setIr, nodeUnit) could be shared, but the variable registry, AE property tables, EventPlan lowering, and JXA codegen would all need to be written fresh for DEVONthink. That amounts to building a new query engine that happens to share an IR format, not reusing the existing one.
