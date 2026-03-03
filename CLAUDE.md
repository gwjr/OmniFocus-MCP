# OmniFocus MCP Server

An MCP server that exposes OmniFocus data and operations via a structured query engine.

## Reference Documentation

Before modifying the query engine or execution pipeline, **read these first**:

- **[AppleScript Dictionary](docs/omnifocus-applescript-dictionary.md)** — every property, element, command, and enumeration in OmniFocus's scripting interface. Includes bulk access patterns and performance notes.
- **[OmniJS (Omni Automation) API](docs/omnifocus-omniJS-api.md)** — the JavaScript API that runs inside OmniFocus. Class hierarchy, methods, property differences from AppleScript, and performance guidance.
- **[Raw sdef](docs/omnifocus-applescript-dictionary.sdef)** — the XML scripting dictionary extracted from `OmniFocus.app`.
- **[Query Engine Architecture](docs/query-engine-architecture.md)** — SetIR/EventPlan pipeline, optimization passes, execution units.
- **[Benchmark Report](benchmark/REPORT.md)** — empirical Apple Events cost data (IPC floor, bulk reads, chain properties, JXA bridge tax, OmniJS byIdentifier crossover).
- **[Deferred Enrichment Design](docs/deferred-enrichment-design.md)** — adaptive per-item enrichment via OmniJS byIdentifier for small result sets.
- **[AppleScript Codegen Design](docs/applescript-codegen-design.md)** — AppleScript codegen investigation for wide bulk reads (8+ properties).
- **[Optimisation Ideas](docs/optimisation-ideas.md)** — brainstormed optimizer passes, triaged and prioritised.
- **[Swift Port Hazards](docs/swift-port-hazards.md)** — code review identifying hazards for a future Swift rewrite.
- **[Future Query IR](docs/future-query-ir.md)** — speculative IR design notes (triaged, not yet actionable).

## Critical OmniFocus Object Model Facts

1. **Projects ARE tasks.** Every project has a root task in `flattenedTasks`. Query code must subtract `flattenedProjects` IDs to get pure tasks.
2. **Folders and tags are NOT tasks.** No overlap between `flattenedFolders`/`flattenedTags` and `flattenedTasks`.
3. **Bulk property reads are the fast path.** `doc.flattenedTasks.name()` returns an aligned array in ~140ms. Always prefer this over `.whose()` or per-item iteration.
4. **Chain properties work in bulk.** `doc.flattenedTasks.containingProject.name()` is ~200-400ms — much faster than per-item lookups.
5. **Tags are bulk-readable as nested arrays.** `doc.flattenedTasks.tags.name()` returns `[["tag1"], [], ["tag2","tag3"], ...]` in ~260ms.
6. **`.whose()` is slow on large collections** (~31s for 751 tasks). Only use for small targeted lookups (tag by name, single item by ID).
7. **JXA bridge tax**: at 8+ properties per round-trip, AppleScript is 2-4x faster than JXA.
8. **OmniJS `byIdentifier()`**: fast for <50 items (~7ms each), but bulk read wins above ~100.

## Build & Test

```bash
npm run build              # TypeScript compilation
npm test                   # Unit tests (~931) — parallel, no OmniFocus needed
npm run test:integration   # Integration tests — serial, requires OmniFocus
npm run test:mutations     # Mutation tests — serial, requires OmniFocus, creates/deletes items
npm run test:all           # Unit + integration (no mutations)
```

## Project Layout

```
src/
  server.ts                 # MCP server entry, tool registration
  tools/
    definitions/            # Tool schemas and handlers (query, edit, move, etc.)
    primitives/             # Execution router (queryOmnifocus, queryPerspectives, batchEdit, batchMove)
    query/                  # Query engine core
      lower.ts              # Compact syntax → AST
      normalizeAst.ts       # AST normalization (flatten, canonicalize, sort)
      fold.ts               # AST → backend output via ExprBackend<T>
      schema.ts             # Entity definitions, variable metadata
      variables.ts          # Variable cost classification
      operations.ts         # Operation definitions
      aeProps.ts            # AE property specs, FK relationships, join specs
      setIr.ts              # SetIR node types and tree walker
      lowerToSetIr.ts       # Normalized AST → SetIR (includes merge-scan optimizer)
      lowerSetIrToEventPlan.ts  # SetIR → EventPlan (SSA-style IR)
      eventPlan.ts          # EventPlan/EventNode type definitions
      eventPlanCSE.ts       # Common subexpression elimination
      eventPlanColumnPrune.ts   # Dead-column elimination
      eventPlanReorder.ts   # Runtime-aware node reordering
      eventPlanMergeSemiJoins.ts  # Merge consecutive SemiJoin filters
      targetedEventPlan.ts  # TargetedEventPlan, ExecutionUnit types
      targetedEventPlanLowering.ts  # Runtime assignment + EU splitting
      backends/             # ExprBackend implementations (describer, nodeEval)
      executionUnits/       # Per-runtime executors (jxaUnit, nodeUnit, omniJsUnit, orchestrator)
  utils/
    omniJsEnrich.ts         # OmniJS byIdentifier enrichment for small result sets
    scriptExecution.ts      # JXA/OmniJS script execution wrappers
    ...                     # Date formatting, AS escaping, coercion
test/                       # Unit and integration tests
benchmark/                  # Performance benchmarks and REPORT.md
docs/                       # Reference documentation
```
