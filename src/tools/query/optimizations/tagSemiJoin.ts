/**
 * Tag Semi-Join Optimization Pass.
 *
 * Rewrites two-phase plans that filter tasks by tag membership into
 * a semi-join: look up task IDs from the tag side (~80ms), then filter
 * the bulk scan by set membership (~150ms). Total ~250ms vs ~5.8s for
 * the old OmniJS fallback triggered by threshold exceedance.
 *
 * Safe cases only:
 * - Tag value must be a string literal
 * - Predicate must be top-level or conjunct in top-level AND
 * - NOT triggered when: under or/not, non-literal value, entity != tasks
 */

import type { LoweredExpr } from '../fold.js';
import type {
  StrategyNode,
  PerItemEnrich,
  PreFilter,
  BulkScan,
  OptimizationPass,
} from '../strategy.js';
import { walkPlan } from '../strategy.js';

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Tag semi-join rewrite pass.
 *
 * Matches the canonical two-phase shape:
 *   Filter → PerItemEnrich → PreFilter → BulkScan
 *
 * When the predicate contains `contains(tags, 'literal')`:
 * - Replaces with SemiJoin(BulkScan, MembershipScan)
 * - Chains multiple tags as nested SemiJoins
 * - Preserves remaining predicate as Filter
 */
export const tagSemiJoinPass: OptimizationPass = (root) => {
  return walkPlan(root, rewriteNode);
};

// ── Predicate Extraction ────────────────────────────────────────────────

interface TagExtraction {
  /** Tag name literals to semi-join on */
  tagNames: string[];
  /** Remainder predicate after removing tag conjuncts (null if nothing left) */
  remainder: LoweredExpr | null;
}

/**
 * Extract tag membership predicates from an expression.
 * Only matches safe patterns at the top level or as AND conjuncts.
 */
export function extractTagPredicates(expr: LoweredExpr): TagExtraction {
  // Check if the whole expression is a single tag contains
  const tagName = matchTagContains(expr);
  if (tagName !== null) {
    return { tagNames: [tagName], remainder: null };
  }

  // Check if it's an AND with tag contains conjuncts
  if (typeof expr === 'object' && expr !== null && !Array.isArray(expr) && 'op' in expr) {
    const node = expr as { op: string; args: LoweredExpr[] };
    if (node.op === 'and') {
      const tagNames: string[] = [];
      const remaining: LoweredExpr[] = [];

      for (const arg of node.args) {
        const name = matchTagContains(arg);
        if (name !== null) {
          tagNames.push(name);
        } else {
          remaining.push(arg);
        }
      }

      if (tagNames.length > 0) {
        let remainder: LoweredExpr | null;
        if (remaining.length === 0) {
          remainder = null;
        } else if (remaining.length === 1) {
          remainder = remaining[0];
        } else {
          remainder = { op: 'and', args: remaining };
        }
        return { tagNames, remainder };
      }
    }
  }

  return { tagNames: [], remainder: expr };
}

/**
 * Match a single `contains(tags, 'literal')` or `in('literal', tags)` pattern.
 * Returns the tag name (lowercased) or null.
 */
function matchTagContains(expr: LoweredExpr): string | null {
  if (typeof expr !== 'object' || expr === null || Array.isArray(expr)) return null;
  if (!('op' in expr)) return null;

  const node = expr as { op: string; args: LoweredExpr[] };

  // {contains: [{var:'tags'}, 'literal']}
  if (node.op === 'contains' && isVarRef(node.args[0], 'tags') && typeof node.args[1] === 'string') {
    return node.args[1].toLowerCase();
  }

  // {in: ['literal', {var:'tags'}]}
  if (node.op === 'in' && typeof node.args[0] === 'string' && isVarRef(node.args[1], 'tags')) {
    return node.args[0].toLowerCase();
  }

  return null;
}

function isVarRef(node: LoweredExpr, name: string): boolean {
  return typeof node === 'object' && node !== null && !Array.isArray(node) &&
    'var' in node && (node as { var: string }).var === name;
}

// ── Rewrite Logic ───────────────────────────────────────────────────────

function rewriteNode(node: StrategyNode): StrategyNode {
  // Only rewrite Filter → PerItemEnrich → PreFilter → BulkScan for tasks entity
  if (node.kind !== 'Filter') return node;
  const filter = node;

  const enrich = filter.source;
  if (enrich.kind !== 'PerItemEnrich') return node;
  if (enrich.entity !== 'tasks') return node;

  const preFilter = enrich.source;
  if (preFilter.kind !== 'PreFilter') return node;

  const scan = preFilter.source;
  if (scan.kind !== 'BulkScan') return node;

  // Try to extract tag predicates from the filter predicate
  const extraction = extractTagPredicates(filter.predicate);
  if (extraction.tagNames.length === 0) return node;

  // Ensure id is in BulkScan columns (needed for SemiJoin)
  const columns = scan.columns.includes('id') ? scan.columns : [...scan.columns, 'id'];
  const newScan: BulkScan = { ...scan, columns };

  // Build chained SemiJoins for each tag
  let current: StrategyNode = newScan;
  for (const tagName of extraction.tagNames) {
    current = {
      kind: 'SemiJoin',
      source: current,
      lookup: {
        kind: 'MembershipScan',
        sourceEntity: 'tags',
        targetEntity: 'tasks',
        predicate: { op: 'eq', args: [{ var: 'name' }, tagName] },
        includeCompleted: scan.includeCompleted,
      },
    };
  }

  // Figure out remaining per-item vars (remove 'tags' since we handled it via semi-join)
  const remainingPerItemVars = new Set(enrich.perItemVars);
  remainingPerItemVars.delete('tags');

  // If there's a remainder predicate that still references per-item vars,
  // keep PerItemEnrich with reduced var set
  if (extraction.remainder !== null && remainingPerItemVars.size > 0) {
    // Remaining per-item vars still need enrichment
    const remainingStubs = new Set(preFilter.assumeTrue);
    remainingStubs.delete('tags');

    // PreFilter with remainder predicate and reduced stubs
    const newPreFilter: StrategyNode = remainingStubs.size > 0
      ? {
          kind: 'PreFilter',
          source: current,
          predicate: extraction.remainder,
          entity: enrich.entity,
          assumeTrue: remainingStubs,
        }
      : current;

    const newEnrich: StrategyNode = {
      kind: 'PerItemEnrich',
      source: newPreFilter,
      perItemVars: remainingPerItemVars,
      entity: enrich.entity,
      threshold: enrich.threshold,
      fallback: enrich.fallback,
    };

    return {
      kind: 'Filter',
      source: newEnrich,
      predicate: extraction.remainder,
      entity: filter.entity,
    };
  }

  // If there's a remainder predicate but no remaining per-item vars, just Filter
  if (extraction.remainder !== null) {
    return {
      kind: 'Filter',
      source: current,
      predicate: extraction.remainder,
      entity: filter.entity,
    };
  }

  // No remainder, no remaining per-item vars — just the semi-join chain
  // But we might still need per-item vars for select (not where)
  if (remainingPerItemVars.size > 0) {
    // Need PerItemEnrich for select-only per-item vars, no filter needed
    return {
      kind: 'PerItemEnrich',
      source: current,
      perItemVars: remainingPerItemVars,
      entity: enrich.entity,
      threshold: enrich.threshold,
      fallback: enrich.fallback,
    };
  }

  return current;
}
