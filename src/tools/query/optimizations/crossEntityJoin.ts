/**
 * Cross-Entity Join Optimization Pass.
 *
 * Rewrites PerItemEnrich nodes where per-item variables can be resolved
 * via cross-entity bulk hash joins instead of per-item .whose() lookups.
 *
 * When a PerItemEnrich exceeds its threshold (>20 items), it falls back
 * to OmniJS (~1-7s). This pass replaces that pattern with:
 *   1. Two parallel BulkScans (source entity + lookup entity)
 *   2. An O(n) hash join in Node.js
 *
 * Resolved patterns:
 *   - projects.folderName: join via folderId (chain) → folders (id, name)
 *     Replaces ~6.8s OmniJS fallback with ~300ms.
 *   - tags.parentName: self-join via parentId (chain) → tags (id, name)
 *     Replaces ~900ms OmniJS fallback with ~200ms.
 *   - folders.projectCount: aggregate-join via projects (folderId)
 *     Replaces ~1.9s OmniJS fallback with ~300ms.
 */

import type {
  StrategyNode,
  PerItemEnrich,
  BulkScan,
  CrossEntityJoin,
  OptimizationPass,
} from '../strategy.js';
import { walkPlan } from '../strategy.js';
import type { EntityType } from '../variables.js';

// ── Join Resolution Descriptors ──────────────────────────────────────────

interface DirectJoin {
  mode: 'direct';
  /** The per-item var this resolves (e.g., 'folderName') */
  perItemVar: string;
  /** Column on source rows for the FK (nodeKey, e.g., 'folderId') */
  sourceKeyColumn: string;
  /** Entity to bulk-scan for lookup */
  lookupEntity: EntityType;
  /** Columns to read from lookup entity */
  lookupColumns: string[];
  /** Column in lookup rows to match FK against (e.g., 'id') */
  lookupJoinColumn: string;
  /** Map of lookup column → output var name */
  fieldMap: Record<string, string>;
}

interface AggregateJoin {
  mode: 'count';
  /** The per-item var this resolves (e.g., 'projectCount') */
  perItemVar: string;
  /** Column on source rows to match against (nodeKey, e.g., 'id') */
  sourceKeyColumn: string;
  /** Entity to bulk-scan for aggregation */
  lookupEntity: EntityType;
  /** Columns to read from lookup entity */
  lookupColumns: string[];
  /** Column in lookup rows that references back to source */
  lookupGroupByColumn: string;
  /** Output var name for the count */
  outputVar: string;
}

type JoinDescriptor = DirectJoin | AggregateJoin;

/**
 * Registry of known per-item var → cross-entity join replacements.
 * Key: `${entity}.${perItemVar}`
 */
const JOIN_REGISTRY: Record<string, JoinDescriptor> = {
  'projects.folderName': {
    mode: 'direct',
    perItemVar: 'folderName',
    sourceKeyColumn: 'folderId',
    lookupEntity: 'folders',
    lookupColumns: ['id', 'name'],
    lookupJoinColumn: 'id',
    fieldMap: { name: 'folderName' },
  },
  'tags.parentName': {
    mode: 'direct',
    perItemVar: 'parentName',
    sourceKeyColumn: 'parentId',
    lookupEntity: 'tags',
    lookupColumns: ['id', 'name'],
    lookupJoinColumn: 'id',
    fieldMap: { name: 'parentName' },
  },
  'folders.projectCount': {
    mode: 'count',
    perItemVar: 'projectCount',
    sourceKeyColumn: 'id',
    lookupEntity: 'projects',
    lookupColumns: ['folderId'],
    lookupGroupByColumn: 'folderId',
    outputVar: 'projectCount',
  },
};

// ── Public API ──────────────────────────────────────────────────────────

export const crossEntityJoinPass: OptimizationPass = (root) => {
  return walkPlan(root, rewriteNode);
};

// ── Rewrite Logic ───────────────────────────────────────────────────────

function rewriteNode(node: StrategyNode): StrategyNode {
  if (node.kind !== 'PerItemEnrich') return node;
  const enrich = node;

  // Find per-item vars that can be resolved via joins
  const resolvable: JoinDescriptor[] = [];
  const remaining = new Set(enrich.perItemVars);

  for (const varName of enrich.perItemVars) {
    const key = `${enrich.entity}.${varName}`;
    const descriptor = JOIN_REGISTRY[key];
    if (descriptor) {
      resolvable.push(descriptor);
      remaining.delete(varName);
    }
  }

  if (resolvable.length === 0) return node;

  // Build the replacement tree
  let current: StrategyNode = enrich.source;

  for (const desc of resolvable) {
    // Ensure the source BulkScan has the join key column
    current = ensureColumnInSource(current, desc.sourceKeyColumn);

    // Build the lookup BulkScan
    const lookupScan: BulkScan = {
      kind: 'BulkScan',
      entity: desc.lookupEntity,
      columns: desc.lookupColumns,
      includeCompleted: false,
    };

    if (desc.mode === 'direct') {
      current = {
        kind: 'CrossEntityJoin',
        source: current,
        lookup: lookupScan,
        sourceKey: desc.sourceKeyColumn,
        lookupKey: desc.lookupJoinColumn,
        fieldMap: desc.fieldMap,
      };
    } else {
      // count aggregation: we reuse CrossEntityJoin with a special fieldMap
      // that signals the executor to count occurrences instead of copying fields.
      // Convention: fieldMap key of '*' with value = outputVar means "count
      // lookup rows matching this source key and store as outputVar".
      current = {
        kind: 'CrossEntityJoin',
        source: current,
        lookup: lookupScan,
        sourceKey: desc.sourceKeyColumn,
        lookupKey: desc.lookupGroupByColumn,
        fieldMap: { '*': desc.outputVar },
      };
    }
  }

  // If remaining per-item vars exist, keep a reduced PerItemEnrich
  if (remaining.size > 0) {
    return {
      ...enrich,
      source: current,
      perItemVars: remaining,
    };
  }

  return current;
}

/**
 * Walk through unary nodes to find and update the BulkScan with an
 * additional column if not already present.
 */
function ensureColumnInSource(node: StrategyNode, column: string): StrategyNode {
  if (node.kind === 'BulkScan') {
    if (!node.columns.includes(column)) {
      return { ...node, columns: [...node.columns, column] };
    }
    return node;
  }

  // Walk through unary transform nodes
  switch (node.kind) {
    case 'Filter': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    case 'PreFilter': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    case 'PerItemEnrich': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    case 'Sort': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    case 'Limit': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    case 'Project': {
      const s = ensureColumnInSource(node.source, column);
      return s !== node.source ? { ...node, source: s } : node;
    }
    default:
      return node;
  }
}
