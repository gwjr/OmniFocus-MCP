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

// ── Runtime overhead ────────────────────────────────────────────────────────

/**
 * Fixed overhead per ExecutionUnit invocation (IPC launch cost etc.).
 *
 * - jxa: ~25ms interpreter startup + ~25ms overhead ≈ 50ms
 * - omniJS: ~1,700ms evaluateJavaScript compilation
 * - node: 0ms (in-process)
 */
export function runtimeCost(runtime: Runtime): number {
  switch (runtime) {
    case 'jxa':    return 50;
    case 'omniJS': return 1700;
    case 'node':   return 0;
  }
}

// ── Per-op costs ────────────────────────────────────────────────────────────

/**
 * Estimated cost of executing a single EventNode op, in milliseconds.
 *
 * @param runtime  - The runtime environment for this op
 * @param kind     - The EventNode kind
 * @param cardinality - Estimated number of items the op processes
 */
export function opCost(runtime: Runtime, kind: EventNode['kind'], cardinality: number): number {
  // Node-side ops are effectively free
  if (runtime === 'node') {
    return nodeOpCost(kind, cardinality);
  }

  // JXA / OmniJS Apple Events ops
  switch (kind) {
    // ── AE reads ──────────────────────────────────────────────────────────

    case 'Get':
      // Bulk property read: ~140ms base (IPC floor + serialisation).
      // Chain properties: ~300ms. We use a middle estimate since we
      // can't distinguish chain vs direct from the node alone.
      return 160;

    case 'Count':
      // Collection count: ~100-120ms (IPC floor)
      return 110;

    // ── AE writes / commands ──────────────────────────────────────────────

    case 'Set':
      // Single property write: ~IPC floor
      return 150;

    case 'Command':
      // Arbitrary command: ~IPC floor + processing
      return 200;

    // ── Iteration ─────────────────────────────────────────────────────────

    case 'ForEach':
      // Per-item AE loop: extremely expensive.
      // Each iteration pays ~75-150ms (amortised .whose() or per-item AE).
      // Use per-item cost of ~75ms (amortised) for conservative estimate.
      return 100 + cardinality * 75;

    // ── Node-side ops that happen to run in JXA/OmniJS context ────────────
    // (These shouldn't normally be assigned to jxa/omniJS, but provide
    //  safe estimates if they are.)

    case 'Zip':
    case 'ColumnValues':
    case 'Flatten':
    case 'Filter':
    case 'SemiJoin':
    case 'HashJoin':
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'Union':
    case 'RowCount':
    case 'AddSwitch':
      // These are data-manipulation ops. If running in JXA, they operate
      // on in-memory arrays with no AE overhead.
      return nodeOpCost(kind, cardinality);
  }
}

/**
 * Cost of node-side (in-process) operations.
 * These operate on in-memory arrays with no IPC overhead.
 */
function nodeOpCost(kind: EventNode['kind'], cardinality: number): number {
  switch (kind) {
    case 'Filter':
      // Predicate evaluation per row: ~0.1ms
      return 0.1 * cardinality;

    case 'SemiJoin':
      // Set lookup per row: ~0.01ms (hash set membership)
      return 0.01 * cardinality;

    case 'HashJoin':
      // Build hash table + probe: ~0.1ms per row
      return 0.1 * cardinality;

    case 'Sort':
      // JS Array.sort: ~0.005ms * n * log(n)
      return cardinality > 0 ? 0.005 * cardinality * Math.log2(cardinality) : 0;

    case 'Zip':
      // Interleave columns: ~0.01ms per row
      return 0.01 * cardinality;

    case 'ColumnValues':
      // Extract column: ~0.01ms per row
      return 0.01 * cardinality;

    case 'Flatten':
      // Flatten arrays: ~0.01ms per row
      return 0.01 * cardinality;

    case 'Limit':
      // Slice: negligible
      return 0.1;

    case 'Pick':
      // Field projection: ~0.01ms per row
      return 0.01 * cardinality;

    case 'Derive':
      // Computed field derivation: ~0.05ms per row (may involve date math etc.)
      return 0.05 * cardinality;

    case 'Union':
      // Concat + dedup by id: ~0.02ms per row
      return 0.02 * cardinality;

    case 'RowCount':
      // Array length: negligible
      return 0.01;

    case 'AddSwitch':
      // Predicate evaluation + column assignment per row: ~0.05ms
      return 0.05 * cardinality;

    // AE ops should not be assigned to node, but return safe high estimates
    case 'Get':
    case 'Count':
    case 'Set':
    case 'Command':
    case 'ForEach':
      return 10000;
  }
}
