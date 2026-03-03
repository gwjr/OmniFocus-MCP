# Query Engine Reuse Audit: Mail MCP Server

Audit of what would need to change, be abstracted, or be reimplemented to
reuse the OmniFocus query engine for a macOS Mail MCP server.

**Updated 2026-03-03**: Audited `../contingency-mail-mcp` to understand what the
actual Mail MCP does and how it queries Mail. Key finding: it uses **SQLite**, not
Apple Events, for reads. This is a fundamental architectural difference from
OmniFocus. See section 0 for details.

## 0. Existing Mail MCP (`../contingency-mail-mcp`) — Architecture Review

The existing `contingency-mail-mcp` server does **not** use a structured query engine.

**Reads**: All message data comes from SQLite against `~/.mail-index/Envelope Index`
(Mail's internal DB, maintained by a separate sync process). Queries are hand-written
SQL: `dbQuery('SELECT ... FROM v_messages WHERE ...', [params])`. No IR, no planner.

**Writes/mutations**: Move, mark, reply, compose go via JXA against `Application('Mail')`.

**Entities exposed**: messages, mailboxes, accounts, attachments — via ~13 tools plus
a resource interface for mailboxes.

**Key implication**: Mail's AE interface does NOT have a `flattenedMessages` collection
analogous to OmniFocus's `flattenedTasks`. Messages nest under `account → mailboxes → messages`.
A full-message scan via AE would require enumerating all accounts and all mailboxes
(potentially 10,000+ messages × per-item property reads). This is why the existing
Mail MCP uses SQLite — it is orders of magnitude faster for read-heavy queries.

**Consequence for query engine reuse**: The JXA execution path (jxaUnit.ts) is **not
viable** as a Mail message query backend. If the query engine is reused for Mail, the
execution layer would need to target SQLite instead of Apple Events for message scans.

## 1. What is Generic (reusable as-is)

These modules have **zero OmniFocus coupling** and could be lifted
verbatim into a shared library:

| Module | Purpose | Coupling |
|--------|---------|----------|
| `lower.ts` | Compact syntax `{op: [args]}` to internal AST | None. Dispatches on `operations` registry (generic). |
| `normalizeAst.ts` | AST canonicalization (flatten, sort, double-neg) | None. Pure tree transform. |
| `fold.ts` | Generic fold over `LoweredExpr` via `ExprBackend<T>` | References `EntityType` (type only) and `isArrayVar` (one lookup). |
| `operations.ts` | Op metadata (arg count, names) | None. Pure data. |
| `nodeEval.ts` | Row-predicate compiler (closure-based) | References `getVarRegistry` for `nodeKey` lookup. The comparison/normalize logic is generic. |
| `eventPlan.ts` | EventPlan IR type definitions | Uses `FourCC` type alias (generic) and `EntityType` (type only). |
| `eventPlanCSE.ts` | Common sub-expression elimination | None. Pure IR transform on `EventNode[]`. |
| `eventPlanColumnPrune.ts` | Dead-column elimination | References `computedVarDeps` (one call). Otherwise pure. |
| `eventPlanReorder.ts` | Node reordering pass | None. Pure IR transform. |
| `eventPlanMergeSemiJoins.ts` | SemiJoin merging | None. Pure IR transform. |
| `eventPlanUtils.ts` | defaultRuntime, collectRefs, rewriteNode | None. Pure IR utilities. |
| `targetedEventPlan.ts` | TargetedEventPlan/ExecutionUnit types | None. Pure types. |
| `targetedEventPlanLowering.ts` | Runtime assignment + unit splitting | None. Uses `defaultRuntime` from eventPlanUtils. |
| `setIr.ts` | SetIR node types + `walkSetIr` | None. Pure types + tree walk. |

**Summary**: ~14 modules (~2,200 LOC) are fully generic. The core
pipeline (lower AST, SetIR, EventPlan, CSE, column pruning, SemiJoin
merging, unit splitting, orchestration scheduling) has no OmniFocus
knowledge.

## 2. OmniFocus-Specific Coupling Points

### 2.1. Entity + Variable Registry (`variables.ts`)

The most tightly coupled module. Defines:

- **`EntityType`** — `'tasks' | 'projects' | 'folders' | 'tags' | 'perspectives'`
- **`VarRegistry`** — per-entity maps of variable name to `{type, nodeKey, appleEventsProperty, cost}`
- **`COMPUTED_VAR_SPECS`** — case-switch derivation rules (e.g. task status)
- **`isTaskOnlyVar`** — project-exclusion optimization

Mail equivalent entities: `messages`, `mailboxes`, `accounts` (maybe `rules`).
Mail variables: `subject`, `sender`, `dateReceived`, `dateSent`, `isRead`,
`isFlagged`, `isJunk`, `isDeleted`, `flagIndex`, `messageSize`, `wasForwarded`,
`wasRepliedTo`, `wasRedirected`, `mailbox` (chain), `account` (chain).

**Reuse strategy**: `VarRegistry` and `VarDef` types are generic. Each app
needs its own registry instances and `EntityType` union. The `getVarRegistry`
function signature is generic; only the switch body changes.

### 2.2. AE Property Tables (`aeProps.ts`)

Maps variable names to Apple Events FourCC property codes:

- `SIMPLE_PROPS` — direct `propCode` per entity/variable
- `CHAIN_PROPS` — chained specifiers (e.g. `containingProject.name()`)
- `ENTITY_CLASS_CODE` — entity name to AE class FourCC
- `getChildToParentFk` — FK relationship metadata for `container`/`containing`
- `getJoinSpec` — join-based enrichment metadata

Mail equivalent:
- Class codes: `mssg` (message), `mbxp` (mailbox), `mact` (account)
- Simple props: `subj` (subject), `sndr` (sender), `rdrc` (dateReceived),
  `drcv` (dateSent), `isrd` (isRead), `isfl` (isFlagged), `isjk` (isJunk),
  `isdl` (isDeleted), `fidx` (flagIndex), `msze` (messageSize), etc.
- Chain props: `message.mailbox.name()` (mailboxName), `message.mailbox.account.name()` (accountName)
- FK relationships: message → mailbox (via `mailbox` property), mailbox → account

**Reuse strategy**: The `PropSpec`, `ChainProp`, `classCode()`, `propSpec()`
function signatures are generic. Each app provides its own tables. Could be
parameterized by passing a "schema" object rather than importing from a
generated module.

### 2.3. Generated sdef Constants (`generated/omnifocus-sdef.ts`)

Auto-generated FourCC constants from OmniFocus's sdef. Each app needs its own
generated file (e.g. `generated/mail-sdef.ts`). The generator script
(`scripts/gen-sdef.ts`) is already parameterized by sdef file path — it would
work for Mail.app's sdef with minimal changes.

### 2.4. JXA Emitter (`executionUnits/jxaUnit.ts`)

Contains two OmniFocus-specific coupling points:

1. **`CLASS_TO_COLLECTION`** — maps FourCC to JXA collection accessor
   (e.g. `OFClass.flattenedTask → 'flattenedTasks'`). Mail needs its own map
   (e.g. `mssg → 'messages'`, `mbxp → 'mailboxes'`).

2. **`PROP_TO_ACCESSOR`** — maps FourCC to JXA property name. Built
   dynamically from OmniFocus prop constants. Mail needs its own prop tables.

3. **Application reference** — `Application("OmniFocus")` hardcoded in the
   emitted script. Mail would need `Application("Mail")`.

The rest of the emitter (specifier tree walking, ForEach body emission,
Zip/Filter/SemiJoin result collection) is **generic AE pattern codegen**.

**Reuse strategy**: Extract the three lookup tables and the application name
into a "JXA codegen config" parameter. The emitter body is reusable.

### 2.5. SetIR Lowering (`lowerToSetIr.ts`, `lowerSetIrToEventPlan.ts`)

- **`lowerToSetIr.ts`**: Heavy OmniFocus coupling in:
  - `activeFilterForEntity` — hardcoded active-filter predicates per entity
  - `container()`/`containing()` lowering — knows OmniFocus FK graph
    (tasks→projects→folders, tasks→tags)
  - `isTaskOnlyVar` — project-exclusion optimization
  - `tagNameShortcut` — OmniFocus-specific tag-name `.whose()` optimization
  - `buildFilterSource` → `splitColumns` → uses `getVarRegistry`

- **`lowerSetIrToEventPlan.ts`**: Uses `classCode()`, `propSpec()`, `getJoinSpec()`
  — all from aeProps.ts. The lowering patterns themselves (Scan → Get(Elements) + Get(Property) + Zip)
  are **generic AE patterns** parameterized by the prop tables.

**Reuse strategy**: The generic lowering patterns (Scan, Filter, Intersect,
Union, Enrich, Restriction) are app-independent. The coupling is in the
*metadata* (which entities exist, what FKs connect them, what active filters
apply). Could be parameterized via a schema descriptor object.

### 2.6. Orchestrator (`orchestrator.ts`)

OmniFocus coupling:
- `buildSetIrPlan` — hardcodes project-exclusion `Difference` for task queries
- `needsProjectExclusion` — OmniFocus-specific concept
- `executeQueryFromAst` — references `enrichByIdentifier` (OmniJS specific)
- Deferred enrichment path — uses `canEnrichColumn` from omniJsEnrich.ts

The core execution loop (topoSort, fuseSchedule, executeFusedJxaUnits,
executeTargetedPlan) is **fully generic**.

### 2.7. Node-side Computed Vars (`executionUnits/nodeUnit.ts`)

Hardcoded OmniFocus derivers: `deriveTaskStatus`, `deriveTaskHasChildren`,
`deriveFolderStatus`. Mail would need its own (if any — Mail has fewer
computed vars; most properties are directly readable).

### 2.8. EventPlan Describer (`eventPlanDescriber.ts`)

Uses `PROP_TO_ACCESSOR` and `CLASS_TO_COLLECTION` for human-readable plan
descriptions. Same coupling pattern as jxaUnit.ts — parameterizable.

## 3. Mail-Specific Requirements

### 3.1. Entity Model

| Mail Entity | AE Class | Key Properties |
|-------------|----------|----------------|
| messages | `mssg` | id, subject, sender, dateReceived, dateSent, isRead, isFlagged, isJunk, isDeleted, flagIndex, messageSize, wasForwarded, wasRepliedTo, wasRedirected |
| mailboxes | `mbxp` | name, unreadCount, account, container (parent mailbox) |
| accounts | `mact` | name, enabled, userName, emailAddresses |

### 3.2. Relationship Graph (FKs)

```
message.mailbox  → mailbox  (chain prop: message.mailbox.name())
mailbox.account  → account  (chain prop: mailbox.account.name())
mailbox.container → mailbox (parent; nullable for top-level)
```

Much simpler than OmniFocus (no multi-hop FK graph, no array FKs like tagIds).

### 3.3. Expensive Properties

- `content` (rich text body) — expensive, analogous to OmniFocus `note`
- `source` (raw RFC822) — very expensive
- `allHeaders` — moderately expensive
- `recipients` (to/cc/bcc) — elements, not properties; require element iteration

### 3.4. No Flattened Collections

Mail has no `flattenedMessages` equivalent — messages live under
`account.mailboxes.messages` (nested). To scan all messages, you'd need to:
1. Enumerate all accounts and mailboxes, or
2. Target a specific mailbox, or
3. Use the selection (viewer's selected messages)

This is a **fundamental architectural difference** from OmniFocus's
`flattenedTasks` which gives a flat collection of all items. The query engine
assumes flat collections (Scan → `Get(Elements(Document, classCode))`).

**Implication**: Mail queries would likely be scoped to a mailbox (or set of
mailboxes), not the entire database. The `Scan` lowering would need a
`scope` parameter (parent specifier) instead of always using `Document`.

### 3.5. No OmniJS Equivalent

Mail has no in-process JavaScript API. All access is via Apple Events.
The deferred enrichment path (OmniJS byIdentifier) would not be available.
ForEach-based enrichment or chain property reads would be the only option.

### 3.6. Active Filters

Mail doesn't have OmniFocus's completed/dropped/active-status concept.
There may be analogues:
- Skip deleted messages (isDeleted = false)
- Skip junk (isJunk = false)

These would be simple default predicates, much simpler than OmniFocus's.

## 4. Effort Assessment

### What can be shared (with parameterization)

| Layer | Files | LOC | Effort to Parameterize |
|-------|-------|-----|----------------------|
| Expression engine | lower.ts, normalizeAst.ts, fold.ts, operations.ts | ~600 | None needed — already generic |
| IR types | setIr.ts, eventPlan.ts, targetedEventPlan.ts | ~500 | `EntityType` becomes a generic type parameter or string |
| IR transforms | eventPlanCSE, columnPrune, reorder, mergeSemiJoins, eventPlanUtils | ~800 | Minor: computedVarDeps call needs abstraction |
| Runtime targeting | targetedEventPlanLowering.ts | ~200 | Already generic |
| Orchestrator core | topoSort, fuseSchedule, executeTargetedPlan loop | ~200 | Extract from OmniFocus-specific buildSetIrPlan |

### What each app must provide

| Component | OmniFocus has | Mail needs | Effort |
|-----------|---------------|------------|--------|
| sdef generator output | omnifocus-sdef.ts | mail-sdef.ts | Low — run existing gen-sdef.ts on Mail.app sdef |
| Entity types | 5 entities | 3 entities | Low |
| Variable registries | ~60 vars across 5 entities | ~20 vars across 3 entities | Low |
| AE property tables | SIMPLE_PROPS, CHAIN_PROPS | Same structure, fewer entries | Low |
| FK graph | Complex (tasks→projects→folders, tasks→tags) | Simple (message→mailbox→account) | Low |
| Active filters | 3 entity-specific filters | 1-2 simple filters | Low |
| Computed vars | taskStatus, hasChildren, folderStatus | None (or minimal) | None |
| JXA codegen config | CLASS_TO_COLLECTION, PROP_TO_ACCESSOR, app name | Same structure | Low |
| Scan scoping | Always Document (flattenedX) | Mailbox-scoped | **Medium** — needs scope parameter |
| Project exclusion | Difference(tasks, projects) | N/A | None (skip) |
| Tag semi-join shortcut | tagNameShortcut optimizer | N/A | None (skip) |

### Architecture gap: mailbox-scoped scans

The most significant difference. OmniFocus's `flattenedTasks` gives a flat,
app-wide collection. Mail requires mailbox-scoped queries. This means:

1. `Scan` nodes need a `parent` specifier (not always `Document`)
2. Cross-mailbox queries require `Union` of per-mailbox scans
3. The `classCode()` function needs to know whether to use `messages` (under
   a mailbox) vs some hypothetical flattened collection (which doesn't exist)

This is not a refactoring of existing code — it's a design decision about how
queries are parameterized. The EventPlan IR already supports arbitrary parent
specifiers in `Get(Elements(parent, classCode))`, so the lower levels handle
it. The change is in `lowerScan()` and the query entry point.

## 5. Recommendation

**Don't extract a shared library yet.** The coupling is concentrated in 4 files
(variables.ts, aeProps.ts, lowerToSetIr.ts, jxaUnit.ts) that are essentially
"schema definition" modules. For a second consumer:

1. **Fork and adapt** the schema files — faster than designing an abstraction
   layer, and Mail's simpler entity model means most OmniFocus complexity
   (project exclusion, tag semi-join, multi-hop FKs, OmniJS enrichment) can
   be deleted rather than parameterized.

2. **Copy the generic pipeline** (14 modules listed in section 1) as a shared
   dependency or monorepo package if a third app is contemplated.

3. **Address mailbox scoping** as a Mail-specific `lowerScan` override — add
   an optional `scope: Specifier` parameter to the Scan node type, defaulting
   to `Document` for OmniFocus compatibility.

4. **For message queries: use SQLite, not AE.** The existing contingency-mail-mcp
   already has the right approach. A query engine integration would need a
   `sqliteUnit.ts` execution backend that translates EventPlan (or SetIR) to SQL,
   not JXA. The predicate-to-filter pipeline (lower → SetIR → Filter) remains
   valid; only the execution layer changes. `mailVariables.ts` would map var names
   to SQL column names rather than AE FourCC codes. This is the most practical
   path — do not try to scan messages via Apple Events.

The expression engine (lower.ts + fold.ts + operations.ts + normalizeAst.ts)
is the most immediately reusable piece and could be extracted into a small
utility package with near-zero effort if a second consumer materializes.

**Estimated effort for a Mail MCP query engine**: 2-3 days to fork schema
files, generate Mail sdef constants, wire up the pipeline, and write basic
tests. The mailbox-scoping change and SQLite execution backend are the only
non-trivial design work. For mailbox/account queries (small cardinality), the
AE path is viable without mailbox-scoping changes.
