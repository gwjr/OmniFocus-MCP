/**
 * SetIR — algebraic set-operation IR for query execution.
 *
 * A higher-level IR above EventPlan: represents a query as a combination
 * of (1) primitive collection reads and (2) set operations on result sets.
 *
 * Every node that produces rows guarantees 'id' is present in each row
 * (required for Intersect/Union to join on).
 *
 * Intended lowering path:
 *   normalizeAst → lowerToSetIr → optimizeSetIr → (future) lowerSetIrToEventPlan
 *
 * Design notes:
 *   • Intersect(L, R): rows from L whose id appears in R. L's columns are kept.
 *   • Union(L, R):     all rows from L and R, deduped by id (L wins on collision).
 *   • ContainerMembers: produces {id}-only rows — must be on the R side of
 *     Intersect (or Union) to contribute ids, not column data.
 *   • Count/Limit are scalar/terminal — they do not produce row sets.
 */

import type { LoweredExpr } from './fold.js';
import type { EntityType } from './variables.js';

// ── Node Types ────────────────────────────────────────────────────────────

/**
 * Bulk scan of entity: fetch all rows with the given columns.
 * Always includes 'id'. No AE-side filter — filtering is a separate node.
 * The optimizer may later push a filter into the scan or merge scans.
 */
export interface ScanNode {
  kind: 'Scan';
  entity: EntityType;
  /** Property columns to read. Always includes 'id'. */
  columns: string[];
}

/**
 * Node-side row filter.
 * Predicate is evaluated in Node against the row data from `source`.
 * All columns from `source` pass through.
 */
export interface FilterNode {
  kind: 'Filter';
  source: SetIrNode;
  predicate: LoweredExpr;
  entity: EntityType;
}

/**
 * Set intersection (AND semantics).
 * Keeps rows from `left` whose `id` appears in `right`.
 * `left` provides the full row data; `right` provides the id set.
 * Both sides must include 'id'.
 */
export interface IntersectNode {
  kind: 'Intersect';
  left: SetIrNode;
  right: SetIrNode;
}

/**
 * Set union (OR semantics).
 * All rows from `left` and `right`, deduped by id.
 * When both sides have a row for the same id, `left` wins (provides columns);
 * `right` fills in any columns absent from `left`.
 * Both sides must include 'id'.
 */
export interface UnionNode {
  kind: 'Union';
  left: SetIrNode;
  right: SetIrNode;
}

/**
 * Set difference (anti-join semantics).
 * Keeps rows from `left` whose id does NOT appear in `right`.
 * `left` provides the full row data; `right` provides the exclusion id set.
 * Both sides must include 'id'.
 *
 * Primary use: project exclusion — Difference(taskPlan, Scan('projects', ['id']))
 * removes project root tasks from a task result set.
 */
export interface DifferenceNode {
  kind: 'Difference';
  left: SetIrNode;
  right: SetIrNode;
}

/**
 * Per-row column enrichment.
 * Fetches `columns` for each row in `source` via by-id AE access
 * (i.e. OmniJS byIdentifier or AppleScript by-id specifier).
 * Used for expensive properties (note) and per-item properties (folderName).
 */
export interface EnrichNode {
  kind: 'Enrich';
  source: SetIrNode;
  entity: EntityType;
  /** Columns to add per row. Must NOT already be present in source. */
  columns: string[];
}

/**
 * Container membership scan.
 * Produces rows with just {id} for `targetEntity` items that belong to
 * containers of `containerType` matching `containerPredicate`.
 *
 * Example: container('tag', eq(name, 'Work'))
 *   → ids of tasks that are in the tag named 'Work'
 *
 * `containerPredicate` is evaluated against the container entity
 * (tags, folders, or projects), not the target entity.
 *
 * For simple name equality, this lowers to a by-name AE specifier
 * (e.g. flattenedTags["Work"].tasks.id()).
 * For complex predicates, it requires querying the container entity first.
 */
export interface ContainerMembersNode {
  kind: 'ContainerMembers';
  targetEntity: EntityType;
  containerType: 'tag' | 'folder' | 'project';
  /** Predicate on the container entity (e.g. tags where name contains 'X'). */
  containerPredicate: LoweredExpr;
}

/** Count of rows in source. Terminal — does not produce a row set. */
export interface CountNode {
  kind: 'Count';
  source: SetIrNode;
}

export interface SortNode {
  kind: 'Sort';
  source: SetIrNode;
  by: string;
  direction: 'asc' | 'desc';
  entity: EntityType;
}

export interface LimitNode {
  kind: 'Limit';
  source: SetIrNode;
  n: number;
}

/** One case in an AddSwitch evaluation: if predicate is truthy, assign value. */
export interface SwitchCase {
  predicate: LoweredExpr;
  value: LoweredExpr;
}

/**
 * Default for an AddSwitch node.
 * Use { kind: 'Error' } when the switch must be exhaustive: no valid else branch.
 */
export type SwitchDefault = LoweredExpr | ErrorNode;

/**
 * Adds a computed column to each row by evaluating cases in priority order.
 * Assigns the first matching case value; falls back to default.
 * If default is Error, any unmatched row is a programming error (throws at runtime).
 */
export interface AddSwitchNode {
  kind: 'AddSwitch';
  source: SetIrNode;
  entity: EntityType;
  column: string;
  cases: SwitchCase[];
  /** Value when no case matches. Use { kind: 'Error' } for exhaustive switches. */
  default: SwitchDefault;
}

/**
 * Algebraic bottom: represents an impossible or erroneous computation.
 *
 * Algebraic rules (applied by the optimizer):
 *   Union(Error, R)     = R        — Error contributes no rows
 *   Union(L, Error)     = L        — Error contributes no rows
 *   Intersect(Error, R) = Error    — Error poisons the intersection
 *   Intersect(L, Error) = Error    — Error poisons the intersection
 */
export interface ErrorNode {
  kind: 'Error';
  message?: string;
}

export type SetIrNode =
  | ScanNode
  | FilterNode
  | IntersectNode
  | UnionNode
  | DifferenceNode
  | EnrichNode
  | ContainerMembersNode
  | CountNode
  | SortNode
  | LimitNode
  | AddSwitchNode
  | ErrorNode;

// ── Tree Walk ─────────────────────────────────────────────────────────────

/**
 * Bottom-up recursive transform over SetIrNode.
 * Rebuilds children first, then applies `fn` to the rebuilt node.
 */
export function walkSetIr(node: SetIrNode, fn: (n: SetIrNode) => SetIrNode): SetIrNode {
  let rebuilt: SetIrNode;

  switch (node.kind) {
    // Leaves — no children
    case 'Scan':
    case 'ContainerMembers':
    case 'Error':
      rebuilt = node;
      break;

    // Unary
    case 'Filter':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;
    case 'Enrich':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;
    case 'Count':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;
    case 'Sort':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;
    case 'Limit':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;
    case 'AddSwitch':
      rebuilt = { ...node, source: walkSetIr(node.source, fn) };
      break;

    // Binary
    case 'Intersect':
    case 'Union':
    case 'Difference':
      rebuilt = {
        ...node,
        left: walkSetIr(node.left, fn),
        right: walkSetIr(node.right, fn),
      };
      break;
  }

  return fn(rebuilt);
}
