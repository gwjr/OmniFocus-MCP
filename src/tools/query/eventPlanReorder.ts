/**
 * EventPlan Node Reordering Pass.
 *
 * Reorders EventPlan nodes to group same-runtime operations together,
 * reducing the number of ExecutionUnit splits and IPC round-trips.
 *
 * Motivation: the SetIR lowering emits nodes in structural order, which
 * interleaves JXA and node-runtime operations. After CSE deduplicates
 * shared Get(Elements) specifiers, a chain property read may be separated
 * from its Elements base by an intervening node-runtime Zip, forcing an
 * extra EU split (~50ms osascript overhead).
 *
 * Algorithm: priority-queue topological sort with runtime-aware tie-breaking.
 *
 * Runs after CSE and column pruning, before runtime assignment.
 */

import type { EventNode, EventPlan, Ref, Runtime } from './eventPlan.js';
import { defaultRuntime, collectRefs, rewriteNode, rewriteSpec } from './eventPlanUtils.js';

// ── Reorder ──────────────────────────────────────────────────────────────────

export function reorderEventPlan(plan: EventPlan): EventPlan {
  const { nodes, result } = plan;
  const n = nodes.length;
  if (n <= 1) return plan;

  // 1. Build dependency graph
  const deps: Ref[][] = nodes.map(node => collectRefs(node));

  // 2. Add mutation barriers: consecutive mutating nodes keep relative order
  const mutatingIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if ('effect' in node && node.effect !== 'nonMutating') {
      mutatingIndices.push(i);
    }
  }
  for (let i = 1; i < mutatingIndices.length; i++) {
    deps[mutatingIndices[i]].push(mutatingIndices[i - 1]);
  }

  // 3. Compute in-degree and dependents
  const inDegree = new Array<number>(n).fill(0);
  const dependents: Set<number>[] = Array.from({ length: n }, () => new Set());

  for (let i = 0; i < n; i++) {
    for (const dep of deps[i]) {
      if (dep >= 0 && dep < n) {
        inDegree[i]++;
        dependents[dep].add(i);
      }
    }
  }

  // 4. Classify runtime (check hint, fall back to defaultRuntime)
  const runtimes: Runtime[] = nodes.map(node => {
    const hinted = node as EventNode & { hint?: Runtime };
    return hinted.hint ?? defaultRuntime(node);
  });

  // 5. Priority-queue topo-sort
  const ready = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) ready.add(i);
  }

  const order: number[] = [];
  let lastRuntime: Runtime | null = null;

  while (ready.size > 0) {
    let best = -1;
    let bestSameRuntime = false;

    for (const idx of ready) {
      const sameRuntime = runtimes[idx] === lastRuntime;

      if (best === -1) {
        best = idx;
        bestSameRuntime = sameRuntime;
        continue;
      }

      // Prefer same runtime as last emitted (extends current run)
      if (sameRuntime && !bestSameRuntime) {
        best = idx;
        bestSameRuntime = true;
        continue;
      }
      if (!sameRuntime && bestSameRuntime) continue;

      // Among same priority, prefer lower original index (stability)
      if (idx < best) {
        best = idx;
        bestSameRuntime = sameRuntime;
      }
    }

    ready.delete(best);
    order.push(best);
    lastRuntime = runtimes[best];

    for (const dep of dependents[best]) {
      inDegree[dep]--;
      if (inDegree[dep] === 0) ready.add(dep);
    }
  }

  if (order.length !== n) {
    throw new Error('reorderEventPlan: cycle detected in dependency graph');
  }

  // 6. Check if reordering actually changed anything
  let changed = false;
  for (let i = 0; i < n; i++) {
    if (order[i] !== i) { changed = true; break; }
  }
  if (!changed) return plan;

  // 7. Compact refs: build old→new mapping and rewrite
  const oldToNew = new Map<Ref, Ref>();
  for (let newIdx = 0; newIdx < order.length; newIdx++) {
    oldToNew.set(order[newIdx], newIdx);
  }

  function remap(r: Ref): Ref {
    const mapped = oldToNew.get(r);
    if (mapped === undefined) {
      throw new Error(`reorderEventPlan: unmapped ref ${r}`);
    }
    return mapped;
  }

  const newNodes = order.map((oldIdx, newIdx) => {
    const node = nodes[oldIdx];

    // ForEach requires special handling: source is a top-level ref,
    // but collect and body-internal refs are body-local. Only remap
    // refs that reference the ForEach's own top-level index (the
    // scoped "current item" ref used inside body nodes).
    if (node.kind === 'ForEach') {
      const bodyRemap = (r: Ref): Ref => r === oldIdx ? newIdx : r;
      return {
        ...node,
        source: remap(node.source),
        body: node.body.map(bn => rewriteNode(bn, bodyRemap)),
        collect: node.collect,  // body-local, no remap
      } as EventNode;
    }

    return rewriteNode(node, remap);
  });

  return { nodes: newNodes, result: remap(result) };
}
