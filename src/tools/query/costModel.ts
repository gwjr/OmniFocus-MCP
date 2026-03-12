/**
 * Cost model for EventPlan execution.
 *
 * Calibrated from empirical Apple Events benchmarks (see benchmark/REPORT.md).
 * All costs are in milliseconds.
 *
 * Key benchmark facts (database: 2,137 tasks, 366 projects, 31 tags, 33 folders):
 *
 * - IPC floor: ~100ms per Apple Events round-trip
 * - JXA osascript startup: ~25ms (interpreter + app connection + defaultDocument)
 * - OmniJS evaluateJavaScript: ~1,700ms compilation overhead
 * - Scalar bulk read (tasks): ~140-170ms
 * - Chain bulk read (tasks): ~200-400ms
 * - Marginal property (JXA): ~55ms per additional property in same script
 * - Marginal property (AS): ~30ms per additional property
 * - OmniJS byIdentifier(): ~7ms per item + ~120ms overhead
 * - Per-item .whose(): ~75-150ms each
 * - Note bulk read: ~7.6ms per task item
 * - Node-side ops: negligible (~0.1ms per item)
 */

import type { Runtime, EventNode } from './eventPlan.js';
import type { Kind } from './eventNodeRegistry.js';

// ── Runtime overhead ────────────────────────────────────────────────────────

/**
 * Fixed overhead per ExecutionUnit invocation (IPC launch cost etc.).
 *
 * - jxa: ~25ms interpreter startup + ~25ms overhead ≈ 50ms
 * - node: 0ms (in-process)
 */
export function runtimeCost(runtime: Runtime): number {
  switch (runtime) {
    case 'jxa':    return 50;
    case 'node':   return 0;
  }
}

// ── Typed cost registries ───────────────────────────────────────────────────

type CostFn = (cardinality: number) => number;

/**
 * Node-side (in-process) cost per kind. Exhaustive over all Kind —
 * adding a new kind without a cost entry is a compile error.
 *
 * AE-only kinds return 10,000ms (unreachable in correct plans;
 * intentionally high to surface planner bugs via cost anomalies).
 */
const NODE_COST: { [K in Kind]: CostFn } = {
  // ── Node-side ops ─────────────────────────────────────────────────
  Filter:       (c) => 0.1 * c,
  SemiJoin:     (c) => 0.01 * c,
  HashJoin:     (c) => 0.1 * c,
  Sort:         (c) => c > 0 ? 0.005 * c * Math.log2(c) : 0,
  Zip:          (c) => 0.01 * c,
  ColumnValues: (c) => 0.01 * c,
  Flatten:      (c) => 0.01 * c,
  Limit:        () => 0.1,
  Pick:         (c) => 0.01 * c,
  Derive:       (c) => 0.05 * c,
  Union:        (c) => 0.02 * c,
  RowCount:     () => 0.01,
  AddSwitch:    (c) => 0.05 * c,
  SetOp:        (c) => 0.01 * c,

  // ── AE ops should not be assigned to node — penalty costs ─────────
  Get:          () => 10000,
  Count:        () => 10000,
  Set:          () => 10000,
  Command:      () => 10000,
  ForEach:      () => 10000,
};

/**
 * JXA (Apple Events) cost per kind. Exhaustive over all Kind —
 * adding a new kind without a cost entry is a compile error.
 *
 * Node-side ops that happen to run in JXA context use their
 * NODE_COST equivalents (they operate on in-memory arrays with no AE overhead).
 */
const JXA_COST: { [K in Kind]: CostFn } = {
  // ── AE reads ──────────────────────────────────────────────────────
  Get:          () => 160,
  Count:        () => 110,

  // ── AE writes / commands ──────────────────────────────────────────
  Set:          () => 150,
  Command:      () => 200,

  // ── Iteration ─────────────────────────────────────────────────────
  ForEach:      (c) => 100 + c * 75,

  // ── Node-side ops in JXA context — delegate to NODE_COST ──────────
  Zip:          (c) => NODE_COST.Zip(c),
  ColumnValues: (c) => NODE_COST.ColumnValues(c),
  Flatten:      (c) => NODE_COST.Flatten(c),
  Filter:       (c) => NODE_COST.Filter(c),
  SemiJoin:     (c) => NODE_COST.SemiJoin(c),
  HashJoin:     (c) => NODE_COST.HashJoin(c),
  Sort:         (c) => NODE_COST.Sort(c),
  Limit:        (c) => NODE_COST.Limit(c),
  Pick:         (c) => NODE_COST.Pick(c),
  Derive:       (c) => NODE_COST.Derive(c),
  Union:        (c) => NODE_COST.Union(c),
  RowCount:     (c) => NODE_COST.RowCount(c),
  AddSwitch:    (c) => NODE_COST.AddSwitch(c),
  SetOp:        (c) => NODE_COST.SetOp(c),
};

// ── Per-op costs ────────────────────────────────────────────────────────────

/**
 * Estimated cost of executing a single EventNode op, in milliseconds.
 *
 * @param runtime  - The runtime environment for this op
 * @param kind     - The EventNode kind
 * @param cardinality - Estimated number of items the op processes
 */
export function opCost(runtime: Runtime, kind: EventNode['kind'], cardinality: number): number {
  return runtime === 'node'
    ? NODE_COST[kind](cardinality)
    : JXA_COST[kind](cardinality);
}
