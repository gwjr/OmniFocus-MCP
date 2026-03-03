/**
 * MergeSemiJoins pass for EventPlan IR.
 *
 * Detects chains of SemiJoin nodes on the same field (default 'id') and
 * collapses them into a single SemiJoin with a combined id set.
 *
 * Pattern:
 *   SemiJoin_B(SemiJoin_A(src, idsA), idsB)
 *
 * When both SemiJoins match on the same field and neither uses arrayField:
 *   - include + include → SemiJoin(src, SetOp(idsA, idsB, 'intersect'))
 *   - include + exclude → SemiJoin(src, SetOp(idsA, idsB, 'subtract'))
 *
 * This saves one array iteration pass per merged pair. The performance
 * benefit is marginal (each pass is ~0.02ms over ~2000 rows) but the
 * plan structure is cleaner.
 *
 * Runs after CSE and column pruning, before runtime targeting.
 */

import type { EventPlan, EventNode, Ref } from './eventPlan.js';
import { compactPlan, collectRefs } from './eventPlanUtils.js';

type SemiJoinNode = Extract<EventNode, { kind: 'SemiJoin' }>;

/** Effective field for a SemiJoin (default: 'id'). */
function semiJoinField(node: SemiJoinNode): string {
  return node.field ?? 'id';
}

/** Is this SemiJoin eligible for merging? Must be on a scalar field (no arrayField). */
function isMergeable(node: SemiJoinNode): boolean {
  return !node.arrayField;
}

export function mergeSemiJoins(plan: EventPlan): EventPlan {
  const { nodes, result } = plan;
  if (nodes.length === 0) return plan;

  // Count how many times each ref is consumed as a source.
  // We can only merge when the inner SemiJoin is consumed exactly once
  // (by the outer SemiJoin) — otherwise its result is shared.
  const refUseCounts = new Map<Ref, number>();
  for (const node of nodes) {
    if ('source' in node && typeof (node as any).source === 'number') {
      const s = (node as any).source as Ref;
      refUseCounts.set(s, (refUseCounts.get(s) ?? 0) + 1);
    }
    // Also count left/right uses for Union, SetOp
    if ('left' in node && typeof (node as any).left === 'number') {
      const l = (node as any).left as Ref;
      refUseCounts.set(l, (refUseCounts.get(l) ?? 0) + 1);
    }
    if ('right' in node && typeof (node as any).right === 'number') {
      const r = (node as any).right as Ref;
      refUseCounts.set(r, (refUseCounts.get(r) ?? 0) + 1);
    }
    // ids ref
    if (node.kind === 'SemiJoin') {
      refUseCounts.set(node.ids, (refUseCounts.get(node.ids) ?? 0) + 1);
    }
    // lookup ref
    if (node.kind === 'HashJoin') {
      refUseCounts.set(node.lookup, (refUseCounts.get(node.lookup) ?? 0) + 1);
    }
  }

  // Scan for merge opportunities: outer SemiJoin whose source is an inner SemiJoin
  const newNodes = [...nodes];
  let changed = false;

  for (let i = 0; i < newNodes.length; i++) {
    const outer = newNodes[i];
    if (outer.kind !== 'SemiJoin') continue;
    if (!isMergeable(outer)) continue;

    const innerRef = outer.source;
    const inner = newNodes[innerRef];
    if (!inner || inner.kind !== 'SemiJoin') continue;
    if (!isMergeable(inner)) continue;

    // Both must operate on the same field
    if (semiJoinField(outer) !== semiJoinField(inner)) continue;

    // Inner must be consumed only by outer (otherwise we can't eliminate it)
    if ((refUseCounts.get(innerRef) ?? 0) > 1) continue;

    // Determine set operation:
    //   inner=include, outer=include → intersect(innerIds, outerIds)
    //   inner=include, outer=exclude → subtract(innerIds, outerIds)
    //   inner=exclude, outer=include → not safe to merge (semantics differ)
    //   inner=exclude, outer=exclude → not safe to merge (double negation)
    const innerExclude = inner.exclude ?? false;
    const outerExclude = outer.exclude ?? false;

    if (innerExclude) continue; // can't merge when inner is an anti-join

    const setOp: 'intersect' | 'subtract' = outerExclude ? 'subtract' : 'intersect';

    // Create SetOp node and merged SemiJoin
    const setOpRef = newNodes.length as Ref;
    newNodes.push({
      kind: 'SetOp',
      left: inner.ids,
      right: outer.ids,
      op: setOp,
    });

    // Replace outer with a SemiJoin from inner's source to the combined ids
    newNodes[i] = {
      kind: 'SemiJoin',
      source: inner.source,
      ids: setOpRef,
      ...(semiJoinField(inner) !== 'id' ? { field: semiJoinField(inner) } : {}),
    };

    changed = true;
  }

  if (!changed) return plan;

  // Compact: remove nodes that are now unreachable
  const reachable = new Set<Ref>();
  function mark(ref: Ref): void {
    if (reachable.has(ref) || ref < 0 || ref >= newNodes.length) return;
    reachable.add(ref);
    for (const r of collectRefs(newNodes[ref])) mark(r);
  }
  mark(result);

  if (reachable.size === newNodes.length) return { nodes: newNodes, result };

  const survivors: number[] = [];
  for (let i = 0; i < newNodes.length; i++) {
    if (reachable.has(i)) survivors.push(i);
  }

  return compactPlan(newNodes, result, survivors, 'mergeSemiJoins');
}
