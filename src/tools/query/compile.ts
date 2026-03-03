/**
 * Query Compilation — fuses JXA leaf nodes into batch scripts.
 *
 * Walks the optimised plan tree, collects fusible JXA leaves (BulkScan,
 * MembershipScan), generates ScriptFragments via the Emitter, and
 * produces a CompiledQuery that the executor can run with fewer
 * osascript invocations.
 */

import type { StrategyNode } from './strategy.js';
import type { Emitter, ScriptFragment } from './emitter.js';

// ── CompiledQuery ────────────────────────────────────────────────────────

export interface SlotEntry {
  index: number;
  resultType: 'rows' | 'idSet';
}

export interface CompiledQuery {
  /** Composite JXA script for 2+ fusible leaves. */
  batchScript: string | null;
  /** Standalone script for single-leaf case. */
  standaloneScript: string | null;
  /** Map from JXA leaf StrategyNode (by identity) → slot in batch results. */
  slotMap: Map<StrategyNode, SlotEntry>;
  /** The original plan tree. */
  root: StrategyNode;
}

// ── Compilation ──────────────────────────────────────────────────────────

/**
 * Compile a plan tree into a CompiledQuery.
 *
 * Collects all BulkScan and MembershipScan leaves reachable without
 * traversing `.fallback` edges (those only execute conditionally).
 * Generates script fragments and fuses them if 2+.
 */
export function compileQuery(root: StrategyNode, emitter: Emitter): CompiledQuery {
  // 1. Collect fusible JXA leaves
  const leaves: StrategyNode[] = [];
  collectLeaves(root, leaves, false);

  // 2. Generate fragments
  const fragments: ScriptFragment[] = [];
  for (const leaf of leaves) {
    if (leaf.kind === 'BulkScan') {
      fragments.push(emitter.propertyScan(leaf));
    } else if (leaf.kind === 'MembershipScan') {
      fragments.push(emitter.membershipLookup(leaf));
    }
  }

  // 3. Build slotMap
  const slotMap = new Map<StrategyNode, SlotEntry>();
  for (let i = 0; i < leaves.length; i++) {
    slotMap.set(leaves[i], { index: i, resultType: fragments[i].resultType });
  }

  // 4. Assemble scripts
  let batchScript: string | null = null;
  let standaloneScript: string | null = null;

  if (fragments.length === 0) {
    // No JXA leaves (e.g., OmniJS-only path)
  } else if (fragments.length === 1) {
    standaloneScript = emitter.wrapStandalone(fragments[0]);
  } else {
    batchScript = emitter.wrapComposite(fragments);
  }

  return { batchScript, standaloneScript, slotMap, root };
}

// ── Tree Traversal ───────────────────────────────────────────────────────

/**
 * DFS-collect BulkScan and MembershipScan nodes, skipping `.fallback`
 * edges (those only execute conditionally in PerItemEnrich).
 */
function collectLeaves(node: StrategyNode, out: StrategyNode[], inFallback: boolean): void {
  switch (node.kind) {
    case 'BulkScan':
    case 'MembershipScan':
      if (!inFallback) out.push(node);
      return;

    case 'FallbackScan':
      // Not fusible
      return;

    // Unary nodes — traverse source
    case 'Filter':
    case 'PreFilter':
    case 'Sort':
    case 'Limit':
    case 'Project':
    case 'SelfJoinEnrich':
      collectLeaves(node.source, out, inFallback);
      return;

    // PerItemEnrich — source is normal, fallback is conditional
    case 'PerItemEnrich':
      collectLeaves(node.source, out, inFallback);
      collectLeaves(node.fallback, out, true);
      return;

    // Binary nodes — traverse both children
    case 'SemiJoin':
      collectLeaves(node.source, out, inFallback);
      collectLeaves(node.lookup, out, inFallback);
      return;

    case 'CrossEntityJoin':
      collectLeaves(node.source, out, inFallback);
      collectLeaves(node.lookup, out, inFallback);
      return;
  }
}
