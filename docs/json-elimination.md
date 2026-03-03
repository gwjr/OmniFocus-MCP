# JSON Elimination in Single-Fused JXA Units

**Date:** 3 March 2026
**Context:** Task #58 investigation — can we eliminate JSON in the single-fused-unit case?

---

## Background

The query pipeline produces an `EventPlan` that is split into `ExecutionUnit`s by runtime
(`jxa` or `node`). Before execution the orchestrator calls `fuseSchedule()` to group
consecutive JXA units, then `executeFusedJxaUnits()` to run them.

There are two cases:

- **Single unit**: `emitJxaUnit(..., { raw: false })` — the IIFE ends with
  `return JSON.stringify(result)`. Node receives a string and calls `JSON.parse` on it
  (inside `executeJXA`).
- **Multiple fused units**: each unit IIFE is called with `{ raw: true }` (no inner
  stringify), and a composite wrapper collects all results in `_r` then does a single
  `return JSON.stringify(_r)`. Node receives one string and parses it once.

## Does the JSON cycle already get eliminated in the fused path?

**Partially, but not fully — and the single-unit path still has unavoidable overhead.**

### What is already eliminated (multi-unit fusion)

When N JXA units are fused into one `osascript` call, the intermediate values that flow
*between* those units within the same composite script are **never serialised**. They stay
as raw JS values in the composite script's `_r` array. The `raw: true` option on each
inner IIFE strips the `JSON.stringify` from inside each unit. Only the outer composite
wrapper does one `JSON.stringify(_r)` at the end.

This was implemented as Task #32 (see `REPORT.md` §10.5). It eliminates one
`JSON.stringify`+`JSON.parse` cycle per fused boundary.

### What remains (irreducible)

**`osascript` can only return a string to Node.** The outer boundary (JXA process →
Node.js) cannot be eliminated. Whatever the composite script computes must be serialised to
a string for `osascript` to return it, and Node must parse that string. This is an
OS-level constraint, not an architecture choice.

The flow for a typical single-entity query (one JXA unit):

```
JXA script:
  var _result = [...];        // bulk-read array of rows
  return JSON.stringify(_result);   // required: osascript returns a string

Node:
  const stdout = await execFile('osascript', [...]);
  const result = JSON.parse(stdout);   // required: parse the string
```

No optimisation can remove these two calls. The JSON round-trip at the *outer* boundary is
a fixed cost.

### Cross-unit value inputs (inlining)

When a JXA unit depends on a value computed by a *previous* (already-resolved) unit, the
orchestrator inlines the value directly into the new script as a `JSON.parse(...)` literal:

```typescript
// orchestrator.ts buildInputMap()
inputs.set(input.ref, `JSON.parse(${JSON.stringify(JSON.stringify(value))})`);
```

This means: the value from the previous unit was already JSON-parsed by Node (from the
previous `osascript` run), then re-serialised as a string literal embedded in the new
script source, then parsed again inside the new script. This is two unnecessary
serialise/parse cycles per cross-unit value input that crosses an `osascript` boundary.

However, this situation only arises when there is *no* fusion — i.e., two JXA units were
not scheduled consecutively and cannot share a composite script. If fusion succeeds, the
value flows as a raw JS value with no serialisation. So the double-parse is only incurred
for plans where JXA units are separated by a node-side unit (rare in practice).

## What the numbers say

From the `json-bridge-compare.ts` benchmark (3 March 2026, 2146 tasks):

| Strategy | 100 items × 5 props | Notes |
|----------|--------------------:|-------|
| A: OmniJS `JSON.stringify` (objects) in-script | 301ms (trimmed) | Current approach for OmniJS path |
| B: Raw array → JXA then `JSON.stringify` | 311ms | Slightly slower |
| C: OmniJS `JSON.stringify` (arrays) in-script | 307ms | No difference |

All three strategies are within ~10ms of each other. The JSON serialisation cost itself is
**not measurable at current data volumes**. The Apple Events IPC and OmniFocus processing
dominate.

For the typical JXA bulk-read query (one JXA unit):

- `JSON.stringify` of 2,146 rows × ~5 props each: ~2ms (JavaScript is fast at this)
- `JSON.parse` of the same: ~2ms
- Apple Events round-trip: ~200–400ms

The JSON cycle is ~1% of total query time. Eliminating it would save ~4ms on a ~400ms
query.

## Verdict

**The JSON elimination for fused multi-unit plans is already implemented** (Task #32, `raw: true` path).

**Further elimination is not feasible for the outer `osascript` boundary**, which is an
OS-level constraint. `osascript` can only return a string to its parent process.

**The JSON cycle is not a meaningful optimisation target** at current data volumes. The
~4ms cost of `JSON.stringify` + `JSON.parse` is ~1% of a typical query's total time.
The Apple Events IPC floor (~100ms per round-trip) and bulk property read time (~150–400ms)
are the real bottlenecks.

The one remaining inefficiency — double-serialise for cross-unit value inputs at
`osascript` boundaries — only occurs when JXA units are separated by a node-side unit and
fusion cannot bridge them. This is rare in practice (most plans are one or two JXA
units with no intervening node units).

## If further optimisation were needed

The only lever left is reducing the *size* of the JSON payload — not eliminating it. For
example:

- **Column arrays instead of row objects**: instead of `[{name:'A', flagged:true}, ...]`,
  return `{name:['A',...], flagged:[true,...]}` (columnar format). This is ~30% smaller
  for wide selects (keys not repeated per row). But it requires restructuring how Node
  unpacks and zips results, adds complexity, and saves <3ms. Not worth it.

- **Number-based column references**: omit string keys entirely and use position. Already
  partially done for the JXA script internals (Zip uses column names only in the final
  output). Further compression would need protocol changes across the osascript boundary.

Neither is worth pursuing given the numbers above.
