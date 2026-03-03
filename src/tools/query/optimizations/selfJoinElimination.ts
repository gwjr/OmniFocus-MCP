/**
 * Self-Join Elimination Optimization Pass.
 *
 * When a CrossEntityJoin joins an entity with itself (self-join), the
 * lookup BulkScan reads the same collection as the source. This pass
 * eliminates the redundant lookup by:
 *
 *   1. Ensuring the source BulkScan reads all columns needed by the lookup
 *   2. Replacing the CrossEntityJoin with a SelfJoinEnrich node that
 *      performs the hash join using the source data alone
 *
 * Currently targets:
 *   - tags.parentName self-join (via parentId → tags id+name)
 *     Saves ~100-200ms per query by eliminating a redundant BulkScan
 *
 * The pass also handles count-aggregation self-joins (e.g., if a folder
 * counted sub-folders via self-join).
 */

import type {
  StrategyNode,
  CrossEntityJoin,
  BulkScan,
  OptimizationPass,
} from '../strategy.js';
import { walkPlan } from '../strategy.js';

// ── Public API ──────────────────────────────────────────────────────────

export const selfJoinEliminationPass: OptimizationPass = (root) => {
  return walkPlan(root, rewriteNode);
};

// ── Rewrite Logic ───────────────────────────────────────────────────────

function rewriteNode(node: StrategyNode): StrategyNode {
  if (node.kind !== 'CrossEntityJoin') return node;
  const join = node;

  // Only optimize self-joins: source and lookup scan the same entity
  const sourceEntity = getLeafEntity(join.source);
  const lookupEntity = getLeafEntity(join.lookup);
  if (!sourceEntity || !lookupEntity) return node;
  if (sourceEntity !== lookupEntity) return node;

  // Only optimize when lookup is a simple BulkScan
  if (join.lookup.kind !== 'BulkScan') return node;
  const lookupScan = join.lookup;

  // Ensure source includes all columns needed by the lookup
  const neededColumns = lookupScan.columns;
  let newSource = join.source;
  for (const col of neededColumns) {
    newSource = ensureColumnInSource(newSource, col);
  }

  // Check if this is a count aggregation (fieldMap has '*' key)
  const isCount = '*' in join.fieldMap;

  if (isCount) {
    // Count aggregation self-join: count source rows grouped by lookupKey
    return {
      kind: 'SelfJoinEnrich',
      source: newSource,
      sourceKey: join.sourceKey,
      lookupKey: join.lookupKey,
      fieldMap: join.fieldMap,
      aggregation: 'count',
    } as SelfJoinEnrich;
  }

  // Direct lookup self-join
  return {
    kind: 'SelfJoinEnrich',
    source: newSource,
    sourceKey: join.sourceKey,
    lookupKey: join.lookupKey,
    fieldMap: join.fieldMap,
    aggregation: null,
  } as SelfJoinEnrich;
}

/**
 * Get the entity type from the innermost leaf scan.
 */
function getLeafEntity(node: StrategyNode): string | null {
  switch (node.kind) {
    case 'BulkScan':
      return node.entity;
    case 'FallbackScan':
      return node.entity;
    case 'MembershipScan':
      return node.targetEntity;
    case 'Filter':
    case 'PreFilter':
    case 'Sort':
    case 'Limit':
    case 'Project':
      return getLeafEntity(node.source);
    case 'SemiJoin':
    case 'CrossEntityJoin':
      return getLeafEntity(node.source);
    default:
      return null;
  }
}

/**
 * Ensure a column exists in the source BulkScan.
 * Walks through unary nodes to find it.
 */
function ensureColumnInSource(node: StrategyNode, column: string): StrategyNode {
  if (node.kind === 'BulkScan') {
    if (!node.columns.includes(column)) {
      return { ...node, columns: [...node.columns, column] };
    }
    return node;
  }

  if (node.kind === 'Filter' || node.kind === 'PreFilter' ||
      node.kind === 'Sort' || node.kind === 'Limit' || node.kind === 'Project') {
    const newSource = ensureColumnInSource(node.source, column);
    if (newSource !== node.source) {
      return { ...node, source: newSource };
    }
  }

  return node;
}

// ── SelfJoinEnrich Node Type ────────────────────────────────────────────

export interface SelfJoinEnrich {
  kind: 'SelfJoinEnrich';
  /** Source rows (which also serve as the lookup table) */
  source: StrategyNode;
  /** Column in source rows to use as the foreign key */
  sourceKey: string;
  /** Column in source rows to use as the lookup key */
  lookupKey: string;
  /** Map of lookup column → output field name */
  fieldMap: Record<string, string>;
  /** Aggregation mode: null for direct lookup, 'count' for counting */
  aggregation: 'count' | null;
}
