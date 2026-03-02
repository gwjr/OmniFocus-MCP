/**
 * Plan Tree — Physical operator tree for query execution.
 *
 * Replaces the flat ExecutionPlan with a tree of typed physical operators
 * that optimization passes can rewrite before execution.
 */

import type { LoweredExpr } from './fold.js';
import type { EntityType } from './variables.js';
import type { Row } from './backends/nodeEval.js';
import type { SelfJoinEnrich } from './optimizations/selfJoinElimination.js';

// ── Result Types ─────────────────────────────────────────────────────────

export type PlanResult =
  | { kind: 'rows'; rows: Row[] }
  | { kind: 'idSet'; ids: Set<string> };

// ── Plan Node Types ──────────────────────────────────────────────────────

// Leaf nodes (data sources)

export interface BulkScan {
  kind: 'BulkScan';
  entity: EntityType;
  columns: string[];
  /** Columns required for output (subset of columns). Optimization passes may
   *  strip filter-only columns but must preserve these. */
  selectColumns?: Set<string>;
  projectScope?: LoweredExpr;
  includeCompleted: boolean;
  /** Pushed-down Apple Events .whose() predicates (optional). */
  whoseFilters?: WhoseFilter[];
  /** Computed vars to derive in Node after scan (e.g., tasks.status from bulk booleans). */
  computedVars?: Set<string>;
}

/**
 * A predicate expressible as an Apple Events .whose() clause.
 * These are pushed down from Filter nodes to reduce the scan set.
 */
export type WhoseFilter =
  | { type: 'eq'; property: string; value: string | number | boolean }
  | { type: 'contains'; property: string; value: string };

export interface OmniJSScan {
  kind: 'OmniJSScan';
  entity: EntityType;
  filterAst: LoweredExpr;
  includeCompleted: boolean;
}

export interface MembershipScan {
  kind: 'MembershipScan';
  /** Entity to look up (e.g., 'tags') */
  sourceEntity: EntityType;
  /** Entity whose IDs we want (e.g., 'tasks') */
  targetEntity: EntityType;
  /** Predicate on the source entity */
  predicate: LoweredExpr;
  /** Whether to include completed/hidden target items */
  includeCompleted: boolean;
}

// Unary transform nodes

export interface Filter {
  kind: 'Filter';
  source: PlanNode;
  predicate: LoweredExpr;
  entity: EntityType;
}

export interface PreFilter {
  kind: 'PreFilter';
  source: PlanNode;
  predicate: LoweredExpr;
  entity: EntityType;
  assumeTrue: Set<string>;
}

export interface PerItemEnrich {
  kind: 'PerItemEnrich';
  source: PlanNode;
  perItemVars: Set<string>;
  entity: EntityType;
  threshold: number;
  fallback: PlanNode;
}

export interface Sort {
  kind: 'Sort';
  source: PlanNode;
  by: string;
  direction: 'asc' | 'desc';
  entity: EntityType;
}

export interface Limit {
  kind: 'Limit';
  source: PlanNode;
  count: number;
}

export interface Project {
  kind: 'Project';
  source: PlanNode;
  fields: string[];
}

// Binary nodes

export interface SemiJoin {
  kind: 'SemiJoin';
  source: PlanNode;
  lookup: PlanNode;
}

export interface CrossEntityJoin {
  kind: 'CrossEntityJoin';
  /** Source rows (e.g., projects with folderId) */
  source: PlanNode;
  /** Lookup rows (e.g., folders with id + name) */
  lookup: PlanNode;
  /** Field in source rows containing the foreign key (e.g., 'folderId') */
  sourceKey: string;
  /** Field in lookup rows to match against (e.g., 'id') */
  lookupKey: string;
  /** Map of lookup field → output field name (e.g., {'name': 'folderName'}) */
  fieldMap: Record<string, string>;
}

// Discriminated union
export type PlanNode =
  | BulkScan
  | OmniJSScan
  | MembershipScan
  | Filter
  | PreFilter
  | PerItemEnrich
  | Sort
  | Limit
  | Project
  | SemiJoin
  | CrossEntityJoin
  | SelfJoinEnrich;

// ── Tree Walk ────────────────────────────────────────────────────────────

/**
 * Bottom-up recursive transform. Descends into children first,
 * then applies `fn` to the rebuilt node.
 */
export function walkPlan(node: PlanNode, fn: (n: PlanNode) => PlanNode): PlanNode {
  // First, rebuild children
  let rebuilt: PlanNode;

  switch (node.kind) {
    // Leaf nodes — no children
    case 'BulkScan':
    case 'OmniJSScan':
    case 'MembershipScan':
      rebuilt = node;
      break;

    // Unary nodes
    case 'Filter':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;
    case 'PreFilter':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;
    case 'PerItemEnrich':
      rebuilt = {
        ...node,
        source: walkPlan(node.source, fn),
        fallback: walkPlan(node.fallback, fn),
      };
      break;
    case 'Sort':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;
    case 'Limit':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;
    case 'Project':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;

    // Binary nodes
    case 'SemiJoin':
      rebuilt = {
        ...node,
        source: walkPlan(node.source, fn),
        lookup: walkPlan(node.lookup, fn),
      };
      break;
    case 'CrossEntityJoin':
      rebuilt = {
        ...node,
        source: walkPlan(node.source, fn),
        lookup: walkPlan(node.lookup, fn),
      };
      break;

    // Unary self-join node (no separate lookup child)
    case 'SelfJoinEnrich':
      rebuilt = { ...node, source: walkPlan(node.source, fn) };
      break;
  }

  // Apply transform to the rebuilt node
  return fn(rebuilt);
}

// ── Optimization Pipeline ────────────────────────────────────────────────

export type OptimizationPass = (root: PlanNode) => PlanNode;

/**
 * Apply optimization passes in order.
 */
export function optimize(root: PlanNode, passes: OptimizationPass[]): PlanNode {
  let current = root;
  for (const pass of passes) {
    current = pass(current);
  }
  return current;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Get the legacy execution path name from a plan tree (for logging).
 */
export function planPathLabel(node: PlanNode): string {
  // Walk to find the innermost scan type
  switch (node.kind) {
    case 'BulkScan':
      return node.projectScope ? 'project-scoped' : 'broad';
    case 'OmniJSScan':
      return 'omnijs-fallback';
    case 'MembershipScan':
      return 'semijoin';
    case 'SemiJoin':
      return 'semijoin';
    case 'Filter':
    case 'PreFilter':
    case 'Sort':
    case 'Limit':
    case 'Project':
    case 'CrossEntityJoin':
    case 'SelfJoinEnrich':
      return planPathLabel(node.source);
    case 'PerItemEnrich':
      return planPathLabel(node.source) === 'project-scoped' ? 'project-scoped' : 'two-phase';
  }
}
