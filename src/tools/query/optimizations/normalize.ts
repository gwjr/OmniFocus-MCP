/**
 * Plan Normalization Pass.
 *
 * Lightweight cleanup after optimization rewrites:
 * - Drop PerItemEnrich with empty perItemVars
 * - Remove PreFilter with no assumeTrue vars
 * - Merge adjacent Filter nodes
 */

import type { StrategyNode, OptimizationPass } from '../strategy.js';
import { walkPlan } from '../strategy.js';

export const normalizePass: OptimizationPass = (root) => {
  return walkPlan(root, normalizeNode);
};

function normalizeNode(node: StrategyNode): StrategyNode {
  // Drop identity Filter — Filter(source, true/null) is a no-op
  if (node.kind === 'Filter' && (node.predicate === true || node.predicate === null)) {
    return node.source;
  }

  // Drop empty PerItemEnrich — if perItemVars is empty, just pass through source
  if (node.kind === 'PerItemEnrich' && node.perItemVars.size === 0) {
    return node.source;
  }

  // Remove degenerate PreFilter with no assumeTrue vars
  if (node.kind === 'PreFilter' && node.assumeTrue.size === 0) {
    // Convert to a regular Filter
    return {
      kind: 'Filter',
      source: node.source,
      predicate: node.predicate,
      entity: node.entity,
    };
  }

  // Merge adjacent Filters: Filter(Filter(source, pred1), pred2) → Filter(source, and(pred1, pred2))
  if (node.kind === 'Filter' && node.source.kind === 'Filter') {
    const inner = node.source;
    return {
      kind: 'Filter',
      source: inner.source,
      predicate: { op: 'and', args: [inner.predicate, node.predicate] },
      entity: node.entity,
    };
  }

  return node;
}
