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
 *   • Restriction(src, fk, lookup): semi-join — keeps src rows where src[fk] ∈ lookup.id
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
 * FK-based restriction (relational semi-join).
 * General form: keep source rows where source[fkColumn] ∈ { lookup[lookupColumn] }.
 *
 * Default (lookupColumn omitted): keeps rows where source[fkColumn] ∈ lookup.id.
 *   Used for `container(type, pred)` — items whose container satisfies a predicate.
 *
 *   container('project', pred) on tasks:
 *     source=Scan(tasks,[id,projectId]),  fkColumn='projectId',
 *     lookup=lowerPredicate(pred,'projects')
 *
 *   container('folder', pred) on tasks:
 *     outer Restriction(tasks,'projectId',
 *       inner Restriction(projects,'folderId', lowerPredicate(pred,'folders')))
 *
 *   container('tag', pred) on tasks:
 *     source=Scan(tasks,[id,tagIds]),  fkColumn='tagIds',  arrayFk=true,
 *     lookup=lowerPredicate(pred,'tags')
 *     (tagIds = task.tags.id() — nested-array bulk read)
 *
 * lookupColumn (non-default): keeps rows where source[fkColumn] ∈ { lookup[lookupColumn] }.
 *   Used for `containing(childEntity, pred)` — items that have a matching child.
 *
 *   containing('tasks', pred) on projects:
 *     source=Scan(projects,[id]),  fkColumn='id',
 *     lookup=Intersect(Scan(tasks,['projectId']), lowerPredicate(pred,'tasks')),
 *     lookupColumn='projectId'
 *     → projects whose id appears in any matching task's projectId
 *
 *   containing('tasks', pred) on tags:
 *     source=Scan(tags,[id]),  fkColumn='id',
 *     lookup=Intersect(Scan(tasks,['tagIds']), lowerPredicate(pred,'tasks')),
 *     lookupColumn='tagIds',  flattenLookup=true
 *     → tags whose id appears in any element of any matching task's tagIds array
 *
 * source:       must include 'id' and fkColumn
 * lookup:       provides the allowed FK values via lookupColumn
 * lookupColumn: column in lookup to extract values from (default: 'id')
 * arrayFk:      true → fkColumn contains an array; any-element match semantics
 * flattenLookup: true → lookup[lookupColumn] is a nested array; flatten before matching
 */
export interface RestrictionNode {
  kind: 'Restriction';
  source: SetIrNode;
  fkColumn: string;
  lookup: SetIrNode;
  arrayFk?: boolean;
  /** Column in lookup to use as the id set (default: 'id'). */
  lookupColumn?: string;
  /** When true, lookup[lookupColumn] is a nested array; flatten before matching. */
  flattenLookup?: boolean;
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
  | RestrictionNode
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

    // Binary (source + lookup)
    case 'Restriction':
      rebuilt = {
        ...node,
        source: walkSetIr(node.source, fn),
        lookup: walkSetIr(node.lookup, fn),
      };
      break;

    // Binary (left + right)
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
