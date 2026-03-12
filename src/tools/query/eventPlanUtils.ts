/**
 * Shared EventPlan utilities.
 *
 * Delegates to the typed eventNodeRegistry for per-kind dispatch.
 * Re-exports specifier helpers from specifierUtils for backwards compatibility.
 *
 * Provides:
 *   - defaultRuntime:      node kind → default Runtime
 *   - collectRefs:         extract all Ref inputs for a node
 *   - rewriteNode/Spec:    apply a Ref remapping to a node/specifier
 */

import type { EventNode, EventPlan, Ref, Runtime } from './eventPlan.js';
import { dispatchDefaultRuntime, dispatchCollectRefs, dispatchRewriteRefs } from './eventNodeRegistry.js';

// Re-export specifier helpers for backwards compatibility
export { collectSpecifierRefs, rewriteSpec } from './specifierUtils.js';

// ── Default runtime per node kind ────────────────────────────────────────────

export function defaultRuntime(node: EventNode): Runtime {
  return dispatchDefaultRuntime(node);
}

// ── Collect all Ref inputs for a node ────────────────────────────────────────

export function collectRefs(node: EventNode): Ref[] {
  return dispatchCollectRefs(node);
}

// ── Ref rewriting ────────────────────────────────────────────────────────────

export function rewriteNode(node: EventNode, remap: (r: Ref) => Ref): EventNode {
  return dispatchRewriteRefs(node, remap);
}

// ── Plan compaction ───────────────────────────────────────────────────────────

/**
 * Compact an EventPlan by keeping only `survivors` (an ordered list of old
 * node indices to retain, in ascending order). Builds the old→new remap,
 * rewrites all Refs in surviving nodes, and returns the new plan.
 *
 * The optional `errorTag` is included in the "dangling ref" error message to
 * identify which pass is calling this utility.
 *
 * If `survivors.length === nodes.length`, no nodes are removed and no
 * rewriting is needed — the caller should short-circuit before calling this.
 */
export function compactPlan(
  nodes: EventNode[],
  result: Ref,
  survivors: number[],
  errorTag = 'compactPlan',
): EventPlan {
  const oldToNew = new Map<Ref, Ref>();
  for (let newIdx = 0; newIdx < survivors.length; newIdx++) {
    oldToNew.set(survivors[newIdx], newIdx);
  }

  function remap(r: Ref): Ref {
    const mapped = oldToNew.get(r);
    if (mapped === undefined) {
      throw new Error(`${errorTag}: dangling ref ${r}`);
    }
    return mapped;
  }

  return {
    nodes: survivors.map(oldIdx => rewriteNode(nodes[oldIdx], remap)),
    result: remap(result),
  };
}
