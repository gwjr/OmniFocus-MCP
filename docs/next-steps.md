# Roadmap

## Near term

### 1. Fix double-lower bug
`container` with complex sub-expressions routes to FallbackScan, which
stores an already-lowered AST. The legacy pipeline's `compileWhere` calls
`lowerExpr` again → "Old-style syntax" error. Straightforward fix, but
superseded if we eliminate the legacy pipeline (#3).

### 3. Eliminate legacy pipeline
FallbackScan still routes through `compileQuery` + `JxaEmitter` (the
pre-EventPlan path). Move FallbackScan into the EventPlan pipeline by
emitting OmniJS evaluation nodes. This kills the double-lower bug (#1),
removes the entire legacy codepath, and simplifies the codebase to a
single execution pipeline.

### 6. First-class aggregate operators (count, exists)
`count` and `exists` should be proper AE operators on a par with `Get`,
not Node-side post-processing. `queryOmnifocus` currently implies `Get` —
the entry point should be explicit about what operation it's performing,
so aggregates and existence checks can take different paths through the
pipeline.

### 10. Mutations in the pipeline
`edit`, `move`, `remove`, `add_task`, `add_project` currently bypass the
query engine entirely (direct AppleScript via primitives). Bring them
into the EventPlan IR so they share the same execution infrastructure —
specifier construction, error handling, batching.

### 11. Dead code audit
Post-merge cleanup. The legacy pipeline removal (#3) will create
significant dead code. Audit for other orphaned modules, unused exports,
stale test helpers.

## Medium term

### 5. MembershipEnrich (container ops inside or/not)
`container('tag', {complex pred})` inside `or`/`not` falls back to
OmniJS because we can't extract a SemiJoin. Low priority — the common
case (`{contains: [{var:"tags"}, "name"]}`) already works via chain vars.

### 12. Audit for Swift rewrite friction
Identify patterns that will be difficult to port: Node-specific APIs,
dynamic dispatch, closure-heavy architecture, runtime type checks. Flag
anything that should be redesigned before porting rather than translated
literally.

### 13. Design review by compiler experts
The query engine is a small compiler (lower → plan → optimise → emit →
execute). Get expert eyes on: the IR design, the pass architecture, CSE
correctness, the cost model, and whether the StrategyNode → EventPlan
split is the right abstraction boundary.

## Longer term

### 14. Plan Swift rewrite
The TypeScript prototype validates the architecture. A Swift
implementation would eliminate the JXA bridge tax, run as a native
XPC service or app extension, and integrate directly with OmniFocus's
Omni Automation runtime. Plan: define the module boundary, pick the
concurrency model (async/await, Combine), design the AE interface layer.

### 8. Expression engine extraction
The fold/lower/backend pattern is reusable. DEVONthink MCP could compile
to DT search strings; Mail MCP could compile to SQL WHERE clauses. Wait
for a second consumer before abstracting. Config surface: entities,
variables (with types/costs), container topology.

### 9. Pre-compiled AppleScript wrapper
A standing `.scpt` for `evaluate javascript` would save ~1.7s
compilation per OmniJS invocation. Worth doing if OmniJS fallback
remains a supported path after #3.
