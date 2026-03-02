# OmniFocus MCP Server

An MCP server that exposes OmniFocus data and operations via a structured query engine.

## Reference Documentation

Before modifying the query engine, planner, or execution pipeline, **read these first**:

- **[AppleScript Dictionary](docs/omnifocus-applescript-dictionary.md)** — every property, element, command, and enumeration in OmniFocus's scripting interface. Includes bulk access patterns and performance notes.
- **[OmniJS (Omni Automation) API](docs/omnifocus-omniJS-api.md)** — the JavaScript API that runs inside OmniFocus. Class hierarchy, methods, property differences from AppleScript, and performance guidance.
- **[Raw sdef](docs/omnifocus-applescript-dictionary.sdef)** — the XML scripting dictionary extracted from `OmniFocus.app`.
- **[Query Engine Architecture](docs/query-engine-architecture.md)** — plan tree execution, optimization passes, variable cost model.
- **[Benchmark Report](benchmark/REPORT.md)** — empirical Apple Events cost data (IPC floor, bulk reads, chain properties, JXA bridge tax, OmniJS byIdentifier crossover).

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
node --test test/*.ts      # All unit tests (~397)
node --test test/mutations.integration.ts  # Integration (requires OmniFocus running)
```

## Project Layout

```
src/
  server.ts                 # MCP server entry, tool registration
  tools/
    definitions/            # Tool schemas and handlers (query, edit, move, etc.)
    primitives/             # Execution backends (queryOmnifocus, batchEdit, batchMove)
    query/                  # Query engine core
      lower.ts              # Compact syntax → AST
      fold.ts               # AST → backend output via ExprBackend<T>
      schema.ts             # Entity definitions, variable metadata
      planner.ts            # AST → PlanNode tree
      jxaBulkRead.ts        # Bulk Apple Events property reads
      variables.ts          # Variable cost classification
      operations.ts         # Operation definitions
      backends/             # ExprBackend implementations (jxaCompiler, describer, nodeEval, varCollector)
      optimizations/        # Tree rewrite passes (tagSemiJoin, crossEntityJoin, selfJoinElimination, normalize)
    utils/                  # Shared utilities (date formatting, AS escaping, coercion)
test/                       # Unit and integration tests
benchmark/                  # Performance benchmarks and REPORT.md
docs/                       # Reference documentation
```
