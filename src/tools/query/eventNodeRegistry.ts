/**
 * EventNode IR Registry.
 *
 * Typed static object providing per-kind metadata for all 19 EventNode kinds:
 *   - runtime:      default Runtime for the kind (literal 'jxa' | 'node')
 *   - collectRefs:  extract all Ref inputs
 *   - rewriteRefs:  apply a Ref remapping, returning a new node
 *
 * Adding a new EventNode kind without adding a registry entry causes a
 * compile-time error (mapped type exhaustiveness via `satisfies`).
 *
 * Uses `as const satisfies` so:
 *   - `satisfies EventNodeIR` enforces exhaustiveness + per-kind signatures
 *   - `as const` preserves literal runtime types ('jxa' vs 'node')
 *     enabling `NodeKind` derivation in downstream modules
 */

import type { EventNode, Ref, Runtime } from './eventPlan.js';
import { collectSpecifierRefs, rewriteSpec } from './specifierUtils.js';

// ── Kind discriminant union ─────────────────────────────────────────────

export type Kind = EventNode['kind'];

// ── Registry constraint type ────────────────────────────────────────────

type EventNodeIR = {
  [K in Kind]: {
    runtime: Runtime;
    collectRefs(node: Extract<EventNode, { kind: K }>): Ref[];
    rewriteRefs(node: Extract<EventNode, { kind: K }>, remap: (r: Ref) => Ref): Extract<EventNode, { kind: K }>;
  };
};

// ── Registry definition ─────────────────────────────────────────────────

export const EVENT_NODE_IR = {

  // ── JXA kinds ───────────────────────────────────────────────────────

  Get: {
    runtime: 'jxa',
    collectRefs(node: Extract<EventNode, { kind: 'Get' }>) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      return refs;
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'Get' }>, remap: (r: Ref) => Ref) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    },
  },

  Count: {
    runtime: 'jxa',
    collectRefs(node: Extract<EventNode, { kind: 'Count' }>) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      return refs;
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'Count' }>, remap: (r: Ref) => Ref) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    },
  },

  Set: {
    runtime: 'jxa',
    collectRefs(node: Extract<EventNode, { kind: 'Set' }>) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      refs.push(node.value);
      return refs;
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'Set' }>, remap: (r: Ref) => Ref) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap), value: remap(node.value) };
    },
  },

  Command: {
    runtime: 'jxa',
    collectRefs(node: Extract<EventNode, { kind: 'Command' }>) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.target, refs);
      for (const v of Object.values(node.args)) {
        if (typeof v === 'number') refs.push(v);
      }
      return refs;
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'Command' }>, remap: (r: Ref) => Ref) {
      return {
        ...node,
        target: rewriteSpec(node.target, remap),
        args: Object.fromEntries(
          Object.entries(node.args).map(([k, v]) =>
            [k, typeof v === 'number' ? remap(v) : v]
          )
        ),
      };
    },
  },

  ForEach: {
    runtime: 'jxa',
    collectRefs(node: Extract<EventNode, { kind: 'ForEach' }>) {
      return [node.source];
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'ForEach' }>, remap: (r: Ref) => Ref) {
      return {
        ...node,
        source: remap(node.source),
        body: node.body.map(n => dispatchRewriteRefs(n, remap)),
        collect: remap(node.collect),
      };
    },
  },

  // ── Node kinds ──────────────────────────────────────────────────────

  Zip: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Zip' }>) {
      return node.columns.map(c => c.ref);
    },
    rewriteRefs(node: Extract<EventNode, { kind: 'Zip' }>, remap: (r: Ref) => Ref) {
      return { ...node, columns: node.columns.map(c => ({ ...c, ref: remap(c.ref) })) };
    },
  },

  ColumnValues: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'ColumnValues' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'ColumnValues' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Flatten: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Flatten' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Flatten' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Filter: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Filter' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Filter' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  SemiJoin: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'SemiJoin' }>) { return [node.source, node.ids]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'SemiJoin' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source), ids: remap(node.ids) }; },
  },

  HashJoin: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'HashJoin' }>) { return [node.source, node.lookup]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'HashJoin' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source), lookup: remap(node.lookup) }; },
  },

  Sort: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Sort' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Sort' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Limit: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Limit' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Limit' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Pick: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Pick' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Pick' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Derive: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Derive' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Derive' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  Union: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'Union' }>) { return [node.left, node.right]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'Union' }>, remap: (r: Ref) => Ref) { return { ...node, left: remap(node.left), right: remap(node.right) }; },
  },

  RowCount: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'RowCount' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'RowCount' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  AddSwitch: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'AddSwitch' }>) { return [node.source]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'AddSwitch' }>, remap: (r: Ref) => Ref) { return { ...node, source: remap(node.source) }; },
  },

  SetOp: {
    runtime: 'node',
    collectRefs(node: Extract<EventNode, { kind: 'SetOp' }>) { return [node.left, node.right]; },
    rewriteRefs(node: Extract<EventNode, { kind: 'SetOp' }>, remap: (r: Ref) => Ref) { return { ...node, left: remap(node.left), right: remap(node.right) }; },
  },

} as const satisfies EventNodeIR;

// ── Derived runtime classification ──────────────────────────────────────

/** Kinds whose registry entry has runtime === 'node'. Derived from the registry. */
export type NodeKind = {
  [K in Kind]: (typeof EVENT_NODE_IR)[K]['runtime'] extends 'node' ? K : never;
}[Kind];

/** Kinds whose registry entry has runtime === 'jxa'. Derived from the registry. */
export type JxaKind = {
  [K in Kind]: (typeof EVENT_NODE_IR)[K]['runtime'] extends 'jxa' ? K : never;
}[Kind];

// ── Typed dispatchers ───────────────────────────────────────────────────

/**
 * Centralized correlated-union dispatch for per-kind registries.
 *
 * TypeScript cannot prove that `registry[node.kind]` and `node` share
 * the same discriminant K. This helper contains the one unavoidable
 * cast — widening the per-kind entry to accept `EventNode` — so that:
 *   - Registry definitions are fully per-kind typed (compile-time narrowing)
 *   - The cast is documented and auditable in a single location
 *   - Call sites are cast-free
 *
 * Safety argument:
 *   1. `registry` is exhaustive over Kind (enforced by its mapped type)
 *   2. `node.kind` selects the matching entry at runtime
 *   3. each entry only accesses properties on its own narrowed variant
 */
export function dispatchByKind<R>(
  registry: { [K in Kind]: (node: Extract<EventNode, { kind: K }>) => R },
  node: EventNode,
): R {
  const fn = registry[node.kind] as (n: EventNode) => R;
  return fn(node);
}

/**
 * Two-arg variant of dispatchByKind for registries whose entries take
 * an extra context argument beyond the node.
 */
export function dispatchByKind2<Ctx, R>(
  registry: { [K in Kind]: (node: Extract<EventNode, { kind: K }>, ctx: Ctx) => R },
  node: EventNode,
  ctx: Ctx,
): R {
  const fn = registry[node.kind] as (n: EventNode, ctx: Ctx) => R;
  return fn(node, ctx);
}

/**
 * Four-arg variant for the describer registry.
 */
export function dispatchByKind4<A, B, C, R>(
  registry: { [K in Kind]: (node: Extract<EventNode, { kind: K }>, a: A, b: B, c: C) => R },
  node: EventNode,
  a: A, b: B, c: C,
): R {
  const fn = registry[node.kind] as (n: EventNode, a: A, b: B, c: C) => R;
  return fn(node, a, b, c);
}

// ── IR-specific dispatchers ─────────────────────────────────────────────

interface LooseIREntry {
  runtime: Runtime;
  collectRefs(node: EventNode): Ref[];
  rewriteRefs(node: EventNode, remap: (r: Ref) => Ref): EventNode;
}

function looseIREntry(node: EventNode): LooseIREntry {
  return EVENT_NODE_IR[node.kind] as unknown as LooseIREntry;
}

export function dispatchCollectRefs(node: EventNode): Ref[] {
  return looseIREntry(node).collectRefs(node);
}

export function dispatchRewriteRefs(node: EventNode, remap: (r: Ref) => Ref): EventNode {
  return looseIREntry(node).rewriteRefs(node, remap);
}

export function dispatchDefaultRuntime(node: EventNode): Runtime {
  return EVENT_NODE_IR[node.kind].runtime;
}
