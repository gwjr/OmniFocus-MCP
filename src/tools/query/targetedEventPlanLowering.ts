/**
 * targetedEventPlanLowering.ts
 *
 * Takes a runtime-agnostic EventPlan and produces a TargetedEventPlan with:
 *   1. Runtime assignment for each node (jxa, omniJS, node)
 *   2. Hint consumption (strip Hint nodes, apply runtime overrides)
 *   3. Batch grouping by runtime with dependency tracking
 */

import type { EventNode, EventPlan, Ref, Runtime, Specifier } from './eventPlan.js';
import type { Batch, TargetedEventPlan } from './targetedEventPlan.js';

// ── Pass 1: Runtime assignment + Hint consumption ───────────────────────────

/** Default runtime for a node based on its kind. */
function defaultRuntime(node: EventNode): Runtime {
  switch (node.kind) {
    case 'Get':
    case 'Count':
    case 'Set':
    case 'Command':
    case 'ForEach':
      return 'jxa';
    case 'Zip':
    case 'Filter':
    case 'SemiJoin':
    case 'HashJoin':
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'ColumnValues':
    case 'Flatten':
      return 'node';
    case 'Hint':
      // Hints are consumed, not executed — placeholder that gets stripped.
      return 'node';
  }
}

// ── Pass 3: Collect all Ref inputs for a given node ─────────────────────────

function collectRefs(node: EventNode): Ref[] {
  const refs: Ref[] = [];

  switch (node.kind) {
    case 'Get':
    case 'Count':
      collectSpecifierRefs(node.specifier, refs);
      break;
    case 'Set':
      collectSpecifierRefs(node.specifier, refs);
      refs.push(node.value);
      break;
    case 'Command':
      collectSpecifierRefs(node.target, refs);
      for (const v of Object.values(node.args)) {
        if (typeof v === 'number') refs.push(v);
      }
      break;
    case 'ForEach':
      refs.push(node.source);
      // body nodes reference the ForEach's own ref (loop var) — not
      // cross-batch dependencies. We only track source here.
      break;
    case 'Zip':
      for (const col of node.columns) refs.push(col.ref);
      break;
    case 'Filter':
      refs.push(node.source);
      break;
    case 'SemiJoin':
      refs.push(node.source, node.ids);
      break;
    case 'HashJoin':
      refs.push(node.source, node.lookup);
      break;
    case 'Sort':
    case 'Limit':
    case 'Pick':
    case 'Derive':
    case 'ColumnValues':
    case 'Flatten':
      refs.push(node.source);
      break;
    case 'Hint':
      // Hints are stripped — should not appear in output.
      break;
  }

  return refs;
}

function collectSpecifierRefs(spec: Specifier, refs: Ref[]): void {
  if (spec.kind === 'Document') return;

  // parent can be a nested Specifier or a Ref
  if (typeof spec.parent === 'number') {
    refs.push(spec.parent);
  } else {
    collectSpecifierRefs(spec.parent, refs);
  }

  if (spec.kind === 'ByID' && typeof spec.id === 'number') {
    refs.push(spec.id);
  }
  if (spec.kind === 'ByName' && typeof spec.name === 'number') {
    refs.push(spec.name);
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export function targetEventPlan(plan: EventPlan): TargetedEventPlan {
  const { nodes } = plan;
  const n = nodes.length;

  // ── Pass 1: assign runtimes, consume Hints ────────────────────────────

  const runtimes = new Map<Ref, Runtime>();
  const strippedHints = new Set<Ref>();
  let resultRef: Ref = plan.result;

  // First pass: assign default runtimes
  for (let i = 0; i < n; i++) {
    runtimes.set(i, defaultRuntime(nodes[i]));
  }

  // Second pass: process Hints — override runtimes, strip Hints
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.kind === 'Hint') {
      runtimes.set(node.source, node.runtime);
      strippedHints.add(i);
      if (resultRef === i) {
        resultRef = node.source;
      }
    }
  }

  // ── Pass 2: build output nodes (sparse — Hint slots become null) ──────

  type TargetedNode = EventNode & { runtime: Runtime; batch: number };
  const outNodes: Array<TargetedNode | null> = new Array(n).fill(null);

  // We'll assign batch indices after grouping. For now, store runtime.
  for (let i = 0; i < n; i++) {
    if (strippedHints.has(i)) continue;
    outNodes[i] = {
      ...nodes[i],
      runtime: runtimes.get(i)!,
      batch: -1, // placeholder, filled in Pass 3
    } as TargetedNode;
  }

  // ── Pass 3: batch grouping ────────────────────────────────────────────

  // Group surviving nodes by runtime
  const runtimeGroups = new Map<Runtime, Ref[]>();
  for (let i = 0; i < n; i++) {
    if (strippedHints.has(i)) continue;
    const rt = runtimes.get(i)!;
    let group = runtimeGroups.get(rt);
    if (!group) {
      group = [];
      runtimeGroups.set(rt, group);
    }
    group.push(i);
  }

  // Assign batch indices (stable order: iterate runtimeGroups in insertion order)
  const batches: Batch[] = [];
  const refToBatch = new Map<Ref, number>();
  let batchIdx = 0;

  for (const [rt, nodeRefs] of runtimeGroups) {
    const currentBatchIdx = batchIdx++;
    for (const ref of nodeRefs) {
      refToBatch.set(ref, currentBatchIdx);
      outNodes[ref]!.batch = currentBatchIdx;
    }
    batches.push({
      index: currentBatchIdx,
      runtime: rt,
      nodes: nodeRefs,
      dependsOn: [], // filled below
    });
  }

  // Compute dependsOn for each batch
  for (const batch of batches) {
    const depBatches = new Set<number>();
    for (const ref of batch.nodes) {
      const node = nodes[ref];
      const inputRefs = collectRefs(node);
      for (const inputRef of inputRefs) {
        if (strippedHints.has(inputRef)) continue;
        const inputBatch = refToBatch.get(inputRef);
        if (inputBatch !== undefined && inputBatch !== batch.index) {
          depBatches.add(inputBatch);
        }
      }
    }
    batch.dependsOn = [...depBatches].sort((a, b) => a - b);
  }

  return {
    nodes: outNodes as any, // sparse array — null slots for stripped Hints
    batches,
    result: resultRef,
  };
}
