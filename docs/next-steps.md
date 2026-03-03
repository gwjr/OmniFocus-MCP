# Roadmap

## Near term

### MembershipEnrich (container/containing ops inside or/not)
`container('tag', {pred})` and `containing('tasks', {pred})` inside
`or`/`not` currently decompose into Union/Intersect SetIR nodes. A
MembershipEnrich approach would enumerate membership inline (as a per-row
boolean) rather than restructuring the SetIR tree. This could reduce
round-trips for complex predicates with mixed container/non-container branches.

### Mutations in the pipeline
`edit`, `move`, `remove`, `add_task`, `add_project` currently bypass the
query engine entirely (direct AppleScript via primitives). Bring them
into the EventPlan IR so they share the same execution infrastructure —
specifier construction, error handling, batching.

### AppleScript backend for wide bulk reads
JXA incurs a non-linear bridge tax above ~8 properties per round-trip.
AppleScript bulk reads scale linearly (~30ms/property). For queries
requesting many columns, an AppleScript codegen backend would be 2-4x
faster. (Task #38, in progress.)

## Medium term

### Expression engine extraction
The fold/lower/backend pattern is reusable. DEVONthink MCP could compile
to DT search strings; Mail MCP could compile to SQL WHERE clauses. Wait
for a second consumer before abstracting. Config surface: entities,
variables (with types/costs), container topology.

### Swift rewrite
The TypeScript prototype validates the architecture. A Swift
implementation would eliminate the JXA bridge tax, run as a native
XPC service or app extension, and integrate directly with OmniFocus's
Omni Automation runtime. Plan: define the module boundary, pick the
concurrency model (async/await, Combine), design the AE interface layer.

## Resolved

- **Double-lower bug** (container with complex sub-expressions) — fixed; legacy pipeline eliminated.
- **Legacy pipeline elimination** — the StrategyNode pipeline (`planner.ts`, `strategy.ts`, `strategyToEventPlan.ts`, `compile.ts`, `executor.ts`, `jxaBulkRead.ts`, `optimizations/*`) has been replaced by the SetIR pipeline (`lowerToSetIr` → `optimizeSetIr` → `lowerSetIrToEventPlan` → `cseEventPlan` → orchestrator).
- **First-class aggregate operators** — `op:'count'` and `op:'exists'` are proper pipeline operations with dedicated SetIR (`Count`) and EventPlan (`RowCount`) nodes.
- **Dead code audit** — completed; OmniJS dead code, stale test files, and orphaned dist artifacts identified and cleaned.
- **Swift rewrite friction audit** — reviewed; hazards documented in Task #15.
- **Design review** — the StrategyNode → EventPlan split that was questioned has been resolved by the SetIR pipeline, which eliminated the intermediate IR.
