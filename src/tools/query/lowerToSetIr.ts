/**
 * Lowering: normalized AST → SetIR.
 *
 * This is a structural recursion — no pattern-matching, no cost analysis
 * at lowering time. The result is correct but may have redundant reads.
 * Optimizer passes (mergeSameEntityScans, etc.) clean it up.
 *
 * Core rules:
 *   and(A, B)        → Intersect(lower(A), lower(B))
 *   or(A, B)         → Union(lower(A), lower(B))
 *   not(P)           → Filter(scanVarsOf(P), not(P))   [always Node-side]
 *   simple_pred(var) → Filter(Scan(entity, [id, var]), pred)
 *   expensive(var)   → Filter(Enrich(Scan(entity, [id]), [var]), pred)
 *   container(t, p)  → ContainerMembers(entity, t, p)
 *
 * Output columns are added separately at the top:
 *   cheap select cols  → Intersect(Scan(entity, [id, ...cheapCols]), filterTree)
 *   expensive select   → Enrich(plan, [expensiveCols])
 *
 * Both sides of every Intersect/Union always carry 'id' — this is the
 * join key used by the executor and the merge optimiser.
 *
 * op:'count'  → Count(filterTree)   — no output columns needed
 * op:'exists' → Limit(filterTree,1) — no output columns needed
 * op:'get'    → output columns + Sort/Limit wrappers
 */

import type { LoweredExpr } from './fold.js';
import { getVarRegistry, type EntityType } from './variables.js';
import type {
  SetIrNode,
  ScanNode,
  IntersectNode,
  UnionNode,
  SwitchCase,
  SwitchDefault,
} from './setIr.js';

// ── Variable classification ────────────────────────────────────────────────

/**
 * Does this variable require per-row AE fetches rather than a bulk scan?
 * 'expensive' = slow bulk (note); 'per-item' = no bulk accessor at all.
 */
function requiresEnrich(varName: string, entity: EntityType): boolean {
  const reg = getVarRegistry(entity);
  const cost = reg[varName]?.cost;
  return cost === 'expensive' || cost === 'per-item';
}

// ── Collect variable references ────────────────────────────────────────────

/**
 * Collect all {var: "name"} references in a predicate expression.
 */
function collectVarNames(pred: LoweredExpr): Set<string> {
  const result = new Set<string>();

  function walk(node: LoweredExpr): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const obj = node as Record<string, unknown>;
    if ('var' in obj) { result.add(obj.var as string); return; }
    if ('op' in obj) {
      const { args } = obj as { op: string; args: LoweredExpr[] };
      args.forEach(walk);
    }
  }

  walk(pred);
  return result;
}

// ── Column helpers ─────────────────────────────────────────────────────────

/**
 * Produce a Scan that reads the given columns plus 'id'.
 * If columns is empty, returns a minimal Scan([id]).
 */
function scan(entity: EntityType, columns: string[]): ScanNode {
  const cols = new Set<string>(['id', ...columns]);
  return { kind: 'Scan', entity, columns: [...cols] };
}

/**
 * Columns needed to evaluate a predicate, split by cost tier.
 */
function splitColumns(
  varNames: Set<string>,
  entity: EntityType,
): { cheap: string[]; expensive: string[]; computed: string[] } {
  const reg = getVarRegistry(entity);
  const cheap: string[] = [];
  const expensive: string[] = [];
  const computed: string[] = [];

  for (const v of varNames) {
    const cost = reg[v]?.cost;
    if (cost === 'expensive' || cost === 'per-item') {
      expensive.push(v);
    } else if (cost === 'computed') {
      computed.push(v);
    } else {
      cheap.push(v);
    }
  }

  return { cheap, expensive, computed };
}

// ── Computed var specs ─────────────────────────────────────────────────────

/**
 * Describes how a computed variable is derived as an AddSwitch node.
 * deps: the real AE properties that must be scanned before evaluation.
 * cases: evaluated in order; first match wins.
 * default: value when no case matches. Error = exhaustive (should never miss).
 */
interface ComputedVarSpec {
  deps: string[];
  cases: SwitchCase[];
  default: SwitchDefault;
}

const TASK_STATUS_SPEC: ComputedVarSpec = {
  deps: ['completed', 'dropped', 'blocked', 'dueDate'],
  cases: [
    { predicate: { var: 'completed' }, value: 'Completed' },
    { predicate: { var: 'dropped' },   value: 'Dropped'   },
    { predicate: { var: 'blocked' },   value: 'Blocked'   },
    {
      predicate: { op: 'and', args: [
        { op: 'isNotNull', args: [{ var: 'dueDate' }] },
        { op: 'lt',        args: [{ var: 'dueDate' }, { var: 'now' }] },
      ]},
      value: 'Overdue',
    },
    {
      predicate: { op: 'and', args: [
        { op: 'isNotNull', args: [{ var: 'dueDate' }] },
        { op: 'lt', args: [
          { var: 'dueDate' },
          { op: 'offset', args: [{ var: 'now' }, 7] },
        ]},
      ]},
      value: 'DueSoon',
    },
  ],
  default: 'Next',
};

const COMPUTED_VAR_SPECS: Readonly<Record<string, Readonly<Record<string, ComputedVarSpec>>>> = {
  tasks: {
    status:     TASK_STATUS_SPEC,
    taskStatus: TASK_STATUS_SPEC,  // alias — same computation
    hasChildren: {
      deps: ['childCount'],
      cases: [
        { predicate: { op: 'gt', args: [{ var: 'childCount' }, 0] }, value: true },
      ],
      default: false,
    },
  },
  folders: {
    status: {
      deps: ['hidden'],
      cases: [
        { predicate: { var: 'hidden' }, value: 'Dropped' },
      ],
      default: 'Active',
    },
  },
};

/**
 * Build the source node for a filter: scan the required columns (expanding
 * computed var dependencies), enrich for expensive vars, then wrap with
 * AddSwitch nodes for each computed var referenced.
 */
function buildFilterSource(varNames: Set<string>, entity: EntityType): SetIrNode {
  const { cheap, expensive, computed } = splitColumns(varNames, entity);

  // Expand computed var dependencies into the cheap scan
  const allCheap = new Set(cheap);
  for (const cv of computed) {
    const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
    if (spec) for (const dep of spec.deps) allCheap.add(dep);
  }

  let source: SetIrNode = scan(entity, [...allCheap]);

  if (expensive.length > 0) {
    source = { kind: 'Enrich', source, entity, columns: expensive };
  }

  // Wrap with an AddSwitch for each computed var
  for (const cv of computed) {
    const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
    if (spec) {
      source = { kind: 'AddSwitch', source, entity, column: cv, cases: spec.cases, default: spec.default };
    }
  }

  return source;
}

// ── Predicate lowering ────────────────────────────────────────────────────

/**
 * Lower a single predicate to a SetIR subtree.
 *
 * The result is a node that produces rows satisfying `pred`.
 * All result rows include 'id'.
 *
 * This is purely structural — no cost analysis, no merging.
 * The optimizer handles redundant reads.
 */
export function lowerPredicate(pred: LoweredExpr, entity: EntityType): SetIrNode {
  // No predicate — return everything
  if (pred === true || pred === null) {
    return scan(entity, []);
  }

  if (typeof pred === 'boolean') {
    // false would mean no rows — not a valid top-level predicate normally
    return scan(entity, []);
  }

  if (typeof pred !== 'object' || Array.isArray(pred)) {
    return scan(entity, []);
  }

  const obj = pred as Record<string, unknown>;

  if (!('op' in obj)) {
    return scan(entity, []);
  }

  const { op, args } = obj as { op: string; args: LoweredExpr[] };

  switch (op) {
    case 'and': {
      // Structural AND → nested Intersects.
      // and(A, B, C) → Intersect(Intersect(lower(A), lower(B)), lower(C))
      // Both sides carry 'id' — the join key.
      const branches = args.map(a => lowerPredicate(a, entity));
      return branches.reduce((acc, cur): SetIrNode =>
        ({ kind: 'Intersect', left: acc, right: cur })
      );
    }

    case 'or': {
      // Structural OR → nested Unions.
      // Both sides carry 'id' — the join key for dedup.
      const branches = args.map(a => lowerPredicate(a, entity));
      return branches.reduce((acc, cur): SetIrNode =>
        ({ kind: 'Union', left: acc, right: cur })
      );
    }

    case 'not': {
      // not(P) — always handled as Node-side filter.
      // We scan the columns P references, then filter with not(P).
      // This is always correct; the optimizer can improve for structural P.
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }

    case 'container': {
      // container(type, subPred) — membership scan.
      // Produces {id}-only rows for target entity items in matching containers.
      const containerType = args[0] as 'tag' | 'folder' | 'project';
      const containerPred = args[1];
      return {
        kind: 'ContainerMembers',
        targetEntity: entity,
        containerType,
        containerPredicate: containerPred,
      };
    }

    case 'containing': {
      // containing(childEntity, childPred) — reverse join.
      // For now: Node-side filter with a full scan.
      // TODO: lower as CrossEntityJoin or equivalent set operation.
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }

    default: {
      // Simple comparison / string op / null check / count-predicate.
      // Scan columns needed, apply Node-side filter.
      const vars = collectVarNames(pred);
      const source = buildFilterSource(vars, entity);
      return { kind: 'Filter', source, predicate: pred, entity };
    }
  }
}

// ── Top-level query lowering ──────────────────────────────────────────────

export interface LowerToSetIrParams {
  predicate: LoweredExpr;
  entity: EntityType;
  op: 'get' | 'count' | 'exists';
  select?: string[];
  sort?: { by: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

/**
 * Lower a full query to a SetIR plan.
 *
 * Steps:
 *   1. Lower the WHERE predicate to a filter tree (structural recursion).
 *   2. For 'get': attach output columns by Intersecting a column-scan with the filter.
 *      For 'count'/'exists': no output columns needed — skip.
 *   3. Wrap with Count / Limit / Sort as appropriate for the op.
 *
 * The result may contain redundant reads (e.g. Intersect of two Scans of the
 * same entity). The optimizer passes (see optimizeSetIr.ts) collapse these.
 */
export function lowerToSetIr(params: LowerToSetIrParams): SetIrNode {
  const { predicate, entity, op, select, sort, limit } = params;

  // Step 1: Lower predicate
  let plan: SetIrNode = lowerPredicate(predicate, entity);

  // Step 2: For 'get', attach output columns.
  // We add a separate Scan for the output columns and Intersect it with the
  // filter plan. The merge-scan optimizer will collapse this if both scans
  // are over the same entity.
  if (op === 'get') {
    if (select && select.length > 0) {
      const { cheap: cheapOut, expensive: expensiveOut, computed: computedOut } = splitColumns(
        new Set(select), entity
      );

      // Expand computed var dependencies into the cheap output scan
      const allCheapOut = new Set(cheapOut);
      for (const cv of computedOut) {
        const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
        if (spec) for (const dep of spec.deps) allCheapOut.add(dep);
      }

      if (allCheapOut.size > 0) {
        // Output scan carries id + cheap output cols.
        // Intersect: keep output scan rows whose id is in the filter result.
        const outputScan = scan(entity, [...allCheapOut]);
        plan = { kind: 'Intersect', left: outputScan, right: plan };
      }

      if (expensiveOut.length > 0) {
        // Enrich surviving rows with expensive output columns.
        plan = { kind: 'Enrich', source: plan, entity, columns: expensiveOut };
      }

      // Wrap with AddSwitch for computed output vars
      for (const cv of computedOut) {
        const spec = COMPUTED_VAR_SPECS[entity]?.[cv];
        if (spec) {
          plan = { kind: 'AddSwitch', source: plan, entity, column: cv, cases: spec.cases, default: spec.default };
        }
      }
    }
    // (If select is omitted, the filter scan already carries what's needed.
    //  The executor would return all scanned columns — user gets whatever the
    //  filter referenced plus 'id'. Full column selection is a later pass.)
  }

  // Step 3: Wrap for op
  switch (op) {
    case 'count':
      // count(x) → rowcount(get(x, id))
      // The filter plan already produces {id}-only rows by default.
      plan = { kind: 'Count', source: plan };
      break;

    case 'exists':
      // exists(x) → gt(count(x), 0) — but simplified to Limit(1).
      // If the executor finds one row, exists = true.
      plan = { kind: 'Limit', source: plan, n: 1 };
      break;

    case 'get':
      // Sort then limit for 'get'.
      if (sort) {
        plan = {
          kind: 'Sort',
          source: plan,
          by: sort.by,
          direction: sort.direction ?? 'asc',
          entity,
        };
      }
      if (limit) {
        plan = { kind: 'Limit', source: plan, n: limit };
      }
      break;
  }

  return plan;
}

// ── Merge-scan optimizer ──────────────────────────────────────────────────

/**
 * Optimiser pass: merge Intersect(Scan(A, cols1), Scan(A, cols2)) into
 * a single Scan(A, cols1 ∪ cols2).
 *
 * More precisely: merge any Intersect where both sides are Scans over the
 * same entity. The Filter nodes above the Scans are then combined with and().
 * (Full predicate merging is a subsequent pass; this handles the column merge.)
 *
 * Applied bottom-up by walkSetIr.
 */
export function mergeSameEntityScans(node: SetIrNode): SetIrNode {
  // Algebraic Error rules: Error is ⊥ (bottom) for set operations.
  // Union absorbs Error (contributes no rows); Intersect propagates Error.
  if (node.kind === 'Union') {
    if (node.left.kind === 'Error')  return node.right;
    if (node.right.kind === 'Error') return node.left;
  }
  if (node.kind === 'Intersect') {
    if (node.left.kind === 'Error')  return node.left;
    if (node.right.kind === 'Error') return node.right;
  }

  if (node.kind !== 'Intersect') return node;

  const { left, right } = node;

  // Case: Intersect(Scan(A, c1), Scan(A, c2)) → Scan(A, c1 ∪ c2)
  if (left.kind === 'Scan' && right.kind === 'Scan' && left.entity === right.entity) {
    const merged = new Set<string>([...left.columns, ...right.columns]);
    return { kind: 'Scan', entity: left.entity, columns: [...merged] };
  }

  // Case: Intersect(Filter(Scan(A, c1), p1), Filter(Scan(A, c2), p2))
  //   → Filter(Scan(A, c1 ∪ c2), and(p1, p2))
  if (
    left.kind === 'Filter' && left.source.kind === 'Scan' &&
    right.kind === 'Filter' && right.source.kind === 'Scan' &&
    left.source.entity === right.source.entity
  ) {
    const entity = left.source.entity;
    const merged = new Set<string>([...left.source.columns, ...right.source.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity, columns: [...merged] };
    const combinedPred: LoweredExpr = {
      op: 'and',
      args: [left.predicate, right.predicate],
    };
    return { kind: 'Filter', source: mergedScan, predicate: combinedPred, entity };
  }

  // Case: Intersect(Filter(Scan(A, c1), p1), Scan(A, c2))
  //   → Filter(Scan(A, c1 ∪ c2), p1)
  if (
    left.kind === 'Filter' && left.source.kind === 'Scan' &&
    right.kind === 'Scan' &&
    left.source.entity === right.entity
  ) {
    const merged = new Set<string>([...left.source.columns, ...right.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity: left.source.entity, columns: [...merged] };
    return { kind: 'Filter', source: mergedScan, predicate: left.predicate, entity: left.entity };
  }

  // Case: Intersect(Scan(A, c1), Filter(Scan(A, c2), p2))
  //   → Filter(Scan(A, c1 ∪ c2), p2)
  if (
    left.kind === 'Scan' &&
    right.kind === 'Filter' && right.source.kind === 'Scan' &&
    left.entity === right.source.entity
  ) {
    const merged = new Set<string>([...left.columns, ...right.source.columns]);
    const mergedScan: ScanNode = { kind: 'Scan', entity: left.entity, columns: [...merged] };
    return { kind: 'Filter', source: mergedScan, predicate: right.predicate, entity: right.entity };
  }

  return node;
}

/**
 * Apply the merge-scan pass over the whole tree.
 */
export function optimizeSetIr(plan: SetIrNode): SetIrNode {
  return applyMergeScanPass(plan);
}

function applyMergeScanPass(node: SetIrNode): SetIrNode {
  // Rebuild children first (bottom-up)
  let rebuilt = rebuildChildren(node);
  // Apply the merge rule
  return mergeSameEntityScans(rebuilt);
}

function rebuildChildren(node: SetIrNode): SetIrNode {
  switch (node.kind) {
    case 'Scan':
    case 'ContainerMembers':
    case 'Error':
      return node;
    case 'Filter':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Enrich':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Count':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Sort':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Limit':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'AddSwitch':
      return { ...node, source: applyMergeScanPass(node.source) };
    case 'Intersect':
    case 'Union':
    case 'Difference':
      return {
        ...node,
        left: applyMergeScanPass(node.left),
        right: applyMergeScanPass(node.right),
      };
  }
}
