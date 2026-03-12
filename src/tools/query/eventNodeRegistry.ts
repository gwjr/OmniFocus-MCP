/**
 * EventNode IR Registry.
 *
 * Typed static object providing per-kind metadata for all 19 EventNode kinds:
 *   - runtime:      default Runtime for the kind
 *   - collectRefs:  extract all Ref inputs
 *   - rewriteRefs:  apply a Ref remapping, returning a new node
 *
 * Adding a new EventNode kind without adding a registry entry causes a
 * compile-time error (mapped type exhaustiveness).
 */

import type { EventNode, Ref, Runtime } from './eventPlan.js';
import { collectSpecifierRefs, rewriteSpec } from './specifierUtils.js';

// ── Kind discriminant union ─────────────────────────────────────────────

export type Kind = EventNode['kind'];

// ── Registry type ───────────────────────────────────────────────────────

type EventNodeIR = {
  [K in Kind]: {
    runtime: Runtime;
    collectRefs(node: Extract<EventNode, { kind: K }>): Ref[];
    rewriteRefs(node: Extract<EventNode, { kind: K }>, remap: (r: Ref) => Ref): Extract<EventNode, { kind: K }>;
  };
};

// ── Registry definition ─────────────────────────────────────────────────

export const EVENT_NODE_IR: EventNodeIR = {

  // ── JXA kinds ───────────────────────────────────────────────────────

  Get: {
    runtime: 'jxa',
    collectRefs(node) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      return refs;
    },
    rewriteRefs(node, remap) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    },
  },

  Count: {
    runtime: 'jxa',
    collectRefs(node) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      return refs;
    },
    rewriteRefs(node, remap) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap) };
    },
  },

  Set: {
    runtime: 'jxa',
    collectRefs(node) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.specifier, refs);
      refs.push(node.value);
      return refs;
    },
    rewriteRefs(node, remap) {
      return { ...node, specifier: rewriteSpec(node.specifier, remap), value: remap(node.value) };
    },
  },

  Command: {
    runtime: 'jxa',
    collectRefs(node) {
      const refs: Ref[] = [];
      collectSpecifierRefs(node.target, refs);
      for (const v of Object.values(node.args)) {
        if (typeof v === 'number') refs.push(v);
      }
      return refs;
    },
    rewriteRefs(node, remap) {
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
    collectRefs(node) {
      return [node.source];
    },
    rewriteRefs(node, remap) {
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
    collectRefs(node) {
      return node.columns.map(c => c.ref);
    },
    rewriteRefs(node, remap) {
      return { ...node, columns: node.columns.map(c => ({ ...c, ref: remap(c.ref) })) };
    },
  },

  ColumnValues: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Flatten: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Filter: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  SemiJoin: {
    runtime: 'node',
    collectRefs(node) { return [node.source, node.ids]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source), ids: remap(node.ids) }; },
  },

  HashJoin: {
    runtime: 'node',
    collectRefs(node) { return [node.source, node.lookup]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source), lookup: remap(node.lookup) }; },
  },

  Sort: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Limit: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Pick: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Derive: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  Union: {
    runtime: 'node',
    collectRefs(node) { return [node.left, node.right]; },
    rewriteRefs(node, remap) { return { ...node, left: remap(node.left), right: remap(node.right) }; },
  },

  RowCount: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  AddSwitch: {
    runtime: 'node',
    collectRefs(node) { return [node.source]; },
    rewriteRefs(node, remap) { return { ...node, source: remap(node.source) }; },
  },

  SetOp: {
    runtime: 'node',
    collectRefs(node) { return [node.left, node.right]; },
    rewriteRefs(node, remap) { return { ...node, left: remap(node.left), right: remap(node.right) }; },
  },
};

// ── Typed dispatchers ───────────────────────────────────────────────────

/**
 * Dispatch collectRefs through the registry. Single cast contained here;
 * callers never see `any`.
 */
export function dispatchCollectRefs(node: EventNode): Ref[] {
  return (EVENT_NODE_IR as any)[node.kind].collectRefs(node);
}

/**
 * Dispatch rewriteRefs through the registry. Single cast contained here;
 * callers never see `any`.
 */
export function dispatchRewriteRefs(node: EventNode, remap: (r: Ref) => Ref): EventNode {
  return (EVENT_NODE_IR as any)[node.kind].rewriteRefs(node, remap);
}

/**
 * Look up the default runtime for a node kind.
 */
export function dispatchDefaultRuntime(node: EventNode): Runtime {
  return EVENT_NODE_IR[node.kind].runtime;
}
